import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHmac } from "node:crypto";
import { createGateway, verifyTicket, MAX_BYTES } from "./vm-file-gateway.mjs";

const secret = "unit-test-only-key";
let root, server, base;
function ticket(operation, filePath, extra = {}) {
  const payload = Buffer.from(
    JSON.stringify({
      operation,
      path: filePath,
      expires: Date.now() + 60_000,
      ...extra,
    }),
  ).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
function url(operation, filePath, extra) {
  return `${base}/vm-files?ticket=${ticket(operation, filePath, extra)}`;
}
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "vm-files-test-"));
  server = createGateway({ secret, root, origin: "https://app.example" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
});

test("write acknowledgement follows complete disk write; read, stat and delete agree", async () => {
  const file = path.join(root, "users", "test", "hello.txt");
  const body = Buffer.from("VM roundtrip\0bytes");
  const upload = await fetch(url("write", file, { size: body.length }), {
    method: "PUT",
    body,
  });
  assert.equal(upload.status, 200);
  assert.deepEqual(await fs.readFile(file), body);
  const stat = await fetch(url("stat", file), { method: "HEAD" });
  assert.equal(Number(stat.headers.get("content-length")), body.length);
  const read = await fetch(url("read", file));
  assert.deepEqual(Buffer.from(await read.arrayBuffer()), body);
  assert.equal(
    read.headers.get("access-control-allow-origin"),
    "https://app.example",
  );
  assert.equal(
    (await fetch(url("delete", file), { method: "DELETE" })).status,
    200,
  );
  assert.equal(
    (await fetch(url("stat", file), { method: "HEAD" })).status,
    404,
  );
});
test("rejects missing, modified, expired and wrong-method tickets", async () => {
  const file = path.join(root, "x");
  assert.equal((await fetch(`${base}/vm-files`)).status, 401);
  assert.throws(() => verifyTicket(ticket("read", file) + "x", secret));
  assert.throws(() =>
    verifyTicket(ticket("read", file, { expires: Date.now() - 1 }), secret),
  );
  assert.equal(
    (await fetch(url("read", file), { method: "PUT", body: "x" })).status,
    405,
  );
});
test("500 MB boundary is inclusive, larger sizes and size mismatches are rejected", async () => {
  const file = path.join(root, "limit");
  assert.equal(
    verifyTicket(ticket("write", file, { size: MAX_BYTES }), secret).size,
    MAX_BYTES,
  );
  assert.throws(() =>
    verifyTicket(ticket("write", file, { size: MAX_BYTES + 1 }), secret),
  );
  assert.throws(() =>
    verifyTicket(ticket("write", file, { size: -1 }), secret),
  );
  const response = await fetch(url("write", file, { size: 3 }), {
    method: "PUT",
    body: "longer",
  });
  assert.equal(response.status, 413);
  await assert.rejects(fs.stat(file));
});
test("rejects traversal, sibling-prefix paths and symlink parents", async () => {
  for (const file of [
    path.join(root, "..", "outside"),
    root + "-sibling/file",
  ]) {
    assert.equal(
      (
        await fetch(url("write", file, { size: 1 }), {
          method: "PUT",
          body: "x",
        })
      ).status,
      400,
    );
  }
  await fs.symlink(os.tmpdir(), path.join(root, "link"));
  assert.equal(
    (
      await fetch(url("write", path.join(root, "link", "bad"), { size: 1 }), {
        method: "PUT",
        body: "x",
      })
    ).status,
    400,
  );
});
test("read rejects directories and limits preview size", async () => {
  assert.equal((await fetch(url("read", root))).status, 400);
  const file = path.join(root, "preview");
  await fs.writeFile(file, Buffer.alloc(2 * 1024 * 1024 + 1));
  assert.equal((await fetch(url("read", file, { preview: true }))).status, 413);
});

test("lists actual VM directory entries including names with spaces and symlinks", async () => {
  const directory = path.join(root, "listing");
  await fs.mkdir(directory);
  await fs.mkdir(path.join(directory, "folder"));
  await fs.writeFile(path.join(directory, "a report.md"), "report");
  await fs.symlink("a report.md", path.join(directory, "link"));
  const response = await fetch(url("list", directory));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.path, directory);
  assert.equal(
    result.entries.find((entry) => entry.name === "a report.md").size,
    6,
  );
  assert.equal(
    result.entries.find((entry) => entry.name === "folder").type,
    "directory",
  );
  assert.equal(
    result.entries.find((entry) => entry.name === "link").type,
    "symlink",
  );
  assert.equal(
    (await fetch(url("list", path.join(directory, "missing")))).status,
    404,
  );
});
