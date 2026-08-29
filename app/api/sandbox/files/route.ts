import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getUserID } from "@/lib/auth/get-user-id";
import { isPersonalMode } from "@/lib/auth/personal-mode";

// Allowed roots: in personal mode allow any path under HOME or cwd;
// in production restrict to workspace volumes.
function allowedRoots(): string[] {
  const roots: string[] = [];
  // Prioritize /tmp as it's more likely to exist
  roots.push("/tmp");
  // In Docker self-host, workspace is mounted at /home/user or /workspace
  roots.push("/home/user");
  roots.push("/workspace");
  roots.push("/app/workspace");
  // Always allow Next.js local storage dir
  if (process.env.LOCAL_STORAGE_DIR) {
    roots.push(path.resolve(process.env.LOCAL_STORAGE_DIR));
  }
  if (isPersonalMode()) {
    const home = process.env.HOME;
    if (home) roots.push(path.resolve(home));
    roots.push(process.cwd());
    // Also allow listing from /
    roots.push("/");
  }
  return roots.map((r) => path.resolve(r));
}

function isPathAllowed(requested: string, roots: string[]): boolean {
  const resolved = path.resolve(requested);
  // Personal mode with "/" root allows everything that is a valid absolute
  // path and does not contain null bytes.
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

  const rawPath = req.nextUrl.searchParams.get("path")?.trim() || "/tmp";
  if (rawPath.includes("\0")) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400, headers: corsHeaders() });
  }

  const resolved = path.resolve(/* turbopackIgnore: true */ rawPath);
  const roots = allowedRoots();
  if (!isPathAllowed(resolved, roots)) {
    return NextResponse.json({ error: "Path not allowed", path: resolved }, { status: 403, headers: corsHeaders() });
  }

  try {
    const stat = await fs.stat(/* turbopackIgnore: true */ resolved);
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "Not a directory", path: resolved }, { status: 400, headers: corsHeaders() });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg, path: resolved }, { status: 404, headers: corsHeaders() });
  }

  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(/* turbopackIgnore: true */ resolved, {
      withFileTypes: true,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg, path: resolved }, { status: 500, headers: corsHeaders() });
  }

  // Sort: directories first, then files, each alphabetically
  dirents.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const entries = await Promise.all(
    dirents.map(async (d) => {
      const fullPath = path.join(
        /* turbopackIgnore: true */ resolved,
        d.name,
      );
      let size = 0;
      let mtime: number | undefined;
      try {
        const s = await fs.lstat(fullPath);
        size = s.size;
        mtime = s.mtimeMs;
      } catch {
        // ignore
      }
      let type: "file" | "directory" | "symlink" = "file";
      if (d.isSymbolicLink()) type = "symlink";
      else if (d.isDirectory()) type = "directory";
      return { name: d.name, path: fullPath, type, size, mtime };
    }),
  );

  // Hide dotfiles unless ?showHidden=1
  const showHidden = req.nextUrl.searchParams.get("showHidden") === "1";
  const filtered = showHidden ? entries : entries.filter((e) => !e.name.startsWith("."));

  return NextResponse.json(
    { path: resolved, entries: filtered },
    { headers: corsHeaders() },
  );
}
