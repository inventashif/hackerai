import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getUserID } from "@/lib/auth/get-user-id";
import { isPersonalMode } from "@/lib/auth/personal-mode";

const MAX_SANDBOX_FILE_SIZE = 250 * 1024 * 1024; // 250 MB max for sandbox uploads

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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function POST(req: NextRequest) {
  try {
    await getUserID(req);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders() });
  }

  const targetPath = req.nextUrl.searchParams.get("path")?.trim();
  if (!targetPath) {
    return NextResponse.json({ error: "Missing ?path=" }, { status: 400, headers: corsHeaders() });
  }
  if (targetPath.includes("\0")) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400, headers: corsHeaders() });
  }

  const resolved = path.resolve(targetPath);
  const roots = allowedRoots();
  if (!isPathAllowed(resolved, roots)) {
    return NextResponse.json({ error: "Path not allowed", path: resolved }, { status: 403, headers: corsHeaders() });
  }

  // Ensure parent directory exists
  const parentDir = path.dirname(resolved);
  try {
    await fs.mkdir(parentDir, { recursive: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Failed to create directory: ${msg}`, path: parentDir }, { status: 500, headers: corsHeaders() });
  }

  // Check content length
  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (size > MAX_SANDBOX_FILE_SIZE) {
      return NextResponse.json(
        { error: "File too large", size, maxSize: MAX_SANDBOX_FILE_SIZE },
        { status: 413, headers: corsHeaders() },
      );
    }
  }

  try {
    const body = await req.arrayBuffer();
    const actualSize = body.byteLength;

    if (actualSize > MAX_SANDBOX_FILE_SIZE) {
      return NextResponse.json(
        { error: "File too large", size: actualSize, maxSize: MAX_SANDBOX_FILE_SIZE },
        { status: 413, headers: corsHeaders() },
      );
    }

    await fs.writeFile(resolved, Buffer.from(body));

    return NextResponse.json(
      { success: true, path: resolved, size: actualSize },
      { headers: corsHeaders() },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg, path: resolved }, { status: 500, headers: corsHeaders() });
  }
}
