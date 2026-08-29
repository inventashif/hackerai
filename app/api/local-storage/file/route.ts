import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";

const LOCAL_STORAGE_KEY_PATTERN =
  /^users\/[A-Za-z0-9_.-]{1,128}\/\d{1,20}-[0-9a-fA-F-]{1,64}(\.[A-Za-z0-9]{1,20})?$/;

const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".log": "text/plain",
  ".csv": "text/csv",
  ".xml": "text/xml",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
  ".py": "text/x-python",
  ".ts": "text/x-typescript",
  ".tsx": "text/x-typescript",
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".zsh": "text/x-shellscript",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".java": "text/x-java",
  ".c": "text/x-c",
  ".cpp": "text/x-c++",
  ".h": "text/x-c",
  ".rb": "text/x-ruby",
  ".php": "text/x-php",
  ".sql": "text/x-sql",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function storageDir(): string {
  return path.resolve(
    /* turbopackIgnore: true */ process.env.LOCAL_STORAGE_DIR ||
      ".local-storage",
  );
}

function resolveKey(key: string): string | null {
  if (!LOCAL_STORAGE_KEY_PATTERN.test(key)) {
    return null;
  }
  return path.join(/* turbopackIgnore: true */ storageDir(), key);
}

function contentTypeForKey(key: string): string {
  const extension = path.extname(key).toLowerCase();
  return EXTENSION_CONTENT_TYPES[extension] ?? "application/octet-stream";
}

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key") ?? "";
  const filePath = resolveKey(key);
  if (!filePath) {
    return new NextResponse("Invalid storage key", { status: 400 });
  }

  let data: Uint8Array<ArrayBuffer>;
  try {
    const buffer = await fs.readFile(/* turbopackIgnore: true */ filePath);
    data = new Uint8Array(buffer);
  } catch {
    return new NextResponse("File not found", { status: 404 });
  }

  return new NextResponse(data, {
    status: 200,
    headers: {
      "Content-Type": contentTypeForKey(key),
      "Content-Length": String(data.byteLength),
      "Cache-Control": "private, max-age=3600",
    },
  });
}
