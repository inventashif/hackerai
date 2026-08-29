import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getUserID } from "@/lib/auth/get-user-id";
import { isPersonalMode } from "@/lib/auth/personal-mode";

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".yaml", ".yml", ".csv", ".log", ".xml", ".html", ".htm",
  ".js", ".ts", ".tsx", ".jsx", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h",
  ".rb", ".php", ".sh", ".bash", ".zsh", ".sql", ".toml", ".ini", ".conf", ".env",
  ".dockerfile", ".gitignore", ".css", ".scss",
]);

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024; // 2 MB for inline preview

function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".pdf": "application/pdf",
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
  };
  return map[ext] ?? "application/octet-stream";
}

function allowedRoots(): string[] {
  const roots: string[] = [];
  // Prioritize /tmp as it's more likely to exist
  roots.push("/tmp");
  roots.push("/home/user");
  roots.push("/workspace");
  roots.push("/app/workspace");
  if (process.env.LOCAL_STORAGE_DIR) roots.push(path.resolve(process.env.LOCAL_STORAGE_DIR));
  if (isPersonalMode()) {
    const home = process.env.HOME;
    if (home) roots.push(path.resolve(home));
    roots.push(process.cwd());
    roots.push("/");
  }
  return roots.map((r) => path.resolve(r));
}

function isPathAllowed(p: string, roots: string[]): boolean {
  const resolved = path.resolve(p);
  if (roots.includes(path.resolve("/"))) return !resolved.includes("\0");
  for (const root of roots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) return true;
  }
  return false;
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function GET(req: NextRequest) {
  try {
    await getUserID(req);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders() });
  }

  const rawPath = req.nextUrl.searchParams.get("path")?.trim();
  if (!rawPath) {
    return NextResponse.json({ error: "Missing ?path=" }, { status: 400, headers: corsHeaders() });
  }
  if (rawPath.includes("\0")) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400, headers: corsHeaders() });
  }

  const resolved = path.resolve(rawPath);
  if (!isPathAllowed(resolved, allowedRoots())) {
    return NextResponse.json({ error: "Path not allowed", path: resolved }, { status: 403, headers: corsHeaders() });
  }

  const download = req.nextUrl.searchParams.get("download") === "1";
  const preview = req.nextUrl.searchParams.get("preview") === "1";

  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      return NextResponse.json({ error: "Path is a directory", path: resolved }, { status: 400, headers: corsHeaders() });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg, path: resolved }, { status: 404, headers: corsHeaders() });
  }

  const mime = mimeForPath(resolved);
  const basename = path.basename(resolved);
  const isPdf = path.extname(resolved).toLowerCase() === ".pdf";
  const isText = TEXT_EXTENSIONS.has(path.extname(resolved).toLowerCase());

  // For preview mode, enforce size limit and text-only
  if (preview) {
    if (stat.size > MAX_PREVIEW_BYTES) {
      return NextResponse.json(
        { error: "File too large for preview", size: stat.size, maxBytes: MAX_PREVIEW_BYTES, path: resolved },
        { status: 413, headers: corsHeaders() },
      );
    }
    // For text preview, read as utf-8 and truncate
    if (isText || mime.startsWith("text/") || mime.includes("json")) {
      try {
        const text = await fs.readFile(resolved, "utf-8");
        const sliced = text.length > 500_000 ? text.slice(0, 500_000) + "\n\n… truncated" : text;
        return new NextResponse(sliced, {
          headers: { ...corsHeaders(), "Content-Type": "text/plain; charset=utf-8", "X-Source-Path": resolved },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return NextResponse.json({ error: msg }, { status: 500, headers: corsHeaders() });
      }
    }
  }

  // Stream file with correct MIME. PDFs open in new tab when ?download≠1 (inline disposition).
  const data = await fs.readFile(resolved);
  const headers: Record<string, string> = {
    ...corsHeaders(),
    "Content-Type": mime,
    "Content-Length": String(data.byteLength),
    "Cache-Control": "private, max-age=60",
  };
  if (download) {
    headers["Content-Disposition"] = `attachment; filename="${basename.replace(/"/g, '\\"')}"`;
  } else if (isPdf) {
    headers["Content-Disposition"] = `inline; filename="${basename.replace(/"/g, '\\"')}"`;
  } else if (!isText && !mime.startsWith("image/")) {
    headers["Content-Disposition"] = `inline; filename="${basename.replace(/"/g, '\\"')}"`;
  }

  return new NextResponse(new Uint8Array(data), { headers });
}
