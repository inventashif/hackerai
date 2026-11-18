// Run on the sandbox VM, behind its existing HTTPS reverse proxy.
// File bytes never pass through Vercel or Convex, and never leave VM disk storage.
import http from "node:http";
import path from "node:path";
import { promises as fs, createWriteStream, constants } from "node:fs";
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

export const MAX_BYTES = 500 * 1024 * 1024;

export function verifyTicket(ticket, secret, now = Date.now()) {
  const [payload, signature, extra] = (ticket || "").split(".");
  if (!payload || !signature || extra || !secret)
    throw new Error("Invalid ticket");
  const expected = createHmac("sha256", secret).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new Error("Invalid ticket");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  if (
    !Number.isFinite(claims.expires) ||
    claims.expires <= now ||
    claims.expires > now + 61 * 60_000
  )
    throw new Error("Expired ticket");
  if (!["read", "write", "stat", "delete"].includes(claims.operation))
    throw new Error("Invalid operation");
  if (
    typeof claims.path !== "string" ||
    !path.isAbsolute(claims.path) ||
    claims.path.includes("\0")
  )
    throw new Error("Invalid path");
  if (
    claims.operation === "write" &&
    (!Number.isSafeInteger(claims.size) ||
      claims.size < 0 ||
      claims.size > MAX_BYTES)
  )
    throw new Error("Invalid size");
  return claims;
}

function inside(root, target) {
  return target === root || target.startsWith(root + path.sep);
}

async function uploadPath(rawPath, root) {
  const resolved = path.resolve(rawPath);
  if (!inside(root, resolved) || resolved === root)
    throw new Error("Uploads must be inside /upload");
  // Walk parents without following symlinks. Do not create anything outside root.
  const parts = path
    .relative(root, path.dirname(resolved))
    .split(path.sep)
    .filter(Boolean);
  let parent = root;
  for (const part of parts) {
    parent = path.join(parent, part);
    await fs.mkdir(parent).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const stat = await fs.lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Invalid upload directory");
  }
  if (
    !inside(await fs.realpath(root), await fs.realpath(path.dirname(resolved)))
  )
    throw new Error("Invalid upload directory");
  return resolved;
}

export function createGateway({ secret, origin, root = "/upload" }) {
  return http.createServer(async (req, res) => {
    const headers = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, PUT, POST, HEAD, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Expose-Headers": "Content-Length",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    };
    const json = (status, value) => {
      res.writeHead(status, { ...headers, "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.url?.split("?")[0] !== "/vm-files")
      return json(404, { error: "Not found" });
    if (req.method === "OPTIONS") {
      res.writeHead(204, headers);
      return res.end();
    }
    let claims;
    try {
      claims = verifyTicket(
        new URL(req.url, "http://localhost").searchParams.get("ticket"),
        secret,
      );
    } catch {
      return json(401, { error: "Invalid or expired file ticket" });
    }
    const methods = {
      read: "GET",
      write: "PUT",
      stat: "HEAD",
      delete: "DELETE",
    };
    if (req.method !== methods[claims.operation])
      return json(405, { error: "Method not allowed" });
    let temporary;
    try {
      if (claims.operation === "write") {
        const target = await uploadPath(claims.path, root);
        const length = req.headers["content-length"];
        if (length && Number(length) !== claims.size)
          return json(413, { error: "Upload size does not match ticket" });
        temporary = path.join(
          path.dirname(target),
          `.upload-${randomUUID()}.part`,
        );
        let received = 0;
        const limit = new Transform({
          transform(chunk, _encoding, callback) {
            received += chunk.length;
            callback(
              received > claims.size ? new Error("Upload too large") : null,
              chunk,
            );
          },
        });
        await pipeline(
          req,
          limit,
          createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
        );
        if (received !== claims.size) throw new Error("Incomplete upload");
        // A successful response means the complete file is closed and renamed on VM disk.
        await fs.rename(temporary, target);
        temporary = undefined;
        return json(200, { success: true, path: target, size: received });
      }
      if (claims.operation === "delete") {
        const target = await uploadPath(claims.path, root);
        await fs.rm(target, { force: true });
        return json(200, { success: true });
      }
      // Open first and stat the same descriptor; only regular files may be read.
      const handle = await fs.open(
        claims.path,
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) return json(400, { error: "Not a regular file" });
        if (claims.operation === "stat") {
          res.writeHead(200, {
            ...headers,
            "Content-Length": String(stat.size),
          });
          return res.end();
        }
        if (claims.preview && stat.size > 2 * 1024 * 1024)
          return json(413, { error: "File too large for preview" });
        res.writeHead(200, {
          ...headers,
          "Content-Type": claims.preview
            ? "text/plain; charset=utf-8"
            : "application/octet-stream",
          "Content-Length": String(stat.size),
          "Content-Security-Policy": "sandbox; default-src 'none'",
          ...(!claims.preview
            ? {
                "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(claims.path))}`,
              }
            : {}),
        });
        await pipeline(handle.createReadStream({ autoClose: false }), res);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!res.headersSent && !res.destroyed)
        json(error.code === "ENOENT" ? 404 : 400, {
          error:
            error.code === "ENOENT"
              ? "File not found on VM"
              : "VM file operation failed",
        });
    } finally {
      if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
    }
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const secret =
    process.env.CENTRIFUGO_TOKEN_HMAC_SECRET_KEY ||
    process.env.CENTRIFUGO_TOKEN_SECRET;
  if (!secret) throw new Error("VM file signing key is required");
  await fs.mkdir("/upload", { recursive: true });
  const server = createGateway({
    secret,
    origin: process.env.VM_APP_ORIGIN || "https://inventashif.tech",
  });
  server.requestTimeout = 60 * 60_000;
  server.listen(Number(process.env.VM_FILES_PORT || 9002), "127.0.0.1");
}
