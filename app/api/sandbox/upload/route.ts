import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getUserID } from "@/lib/auth/get-user-id";
import { isPersonalMode } from "@/lib/auth/personal-mode";
import { api } from "@/convex/_generated/api";
import { ConvexHttpClient } from "convex/browser";

const MAX_SANDBOX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB max for sandbox uploads

function allowedRoots(): string[] {
  const roots: string[] = [];
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
    "Access-Control-Allow-Methods": "PUT, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function PUT(req: NextRequest) {
  return POST(req);
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

  const isVercel = !!process.env.VERCEL_ENV;
  const isUploadPath = targetPath.startsWith("/upload/");

  if (isVercel && isUploadPath) {
    return proxyUploadToVMSandbox(req, targetPath);
  }

  return writeToLocalFS(req, targetPath);
}

async function writeToLocalFS(req: NextRequest, targetPath: string) {
  const resolved = path.resolve(targetPath);
  const roots = allowedRoots();
  if (!isPathAllowed(resolved, roots)) {
    return NextResponse.json({ error: "Path not allowed", path: resolved }, { status: 403, headers: corsHeaders() });
  }

  const parentDir = path.dirname(resolved);
  try {
    await fs.mkdir(parentDir, { recursive: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Failed to create directory: ${msg}`, path: parentDir }, { status: 500, headers: corsHeaders() });
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

async function proxyUploadToVMSandbox(req: NextRequest, targetPath: string) {
  const centrifugoHttpUrl = process.env.CENTRIFUGO_HTTP_URL;
  const centrifugoApiKey = process.env.CENTRIFUGO_API_KEY;

  if (!centrifugoHttpUrl || !centrifugoApiKey) {
    return NextResponse.json(
      {
        error: "VM sandbox upload not configured. Set CENTRIFUGO_HTTP_URL and CENTRIFUGO_API_KEY to enable uploads to the VM sandbox from Vercel.",
        hint: "On self-hosted, uploads work directly to /upload. On Vercel, configure Centrifugo HTTP API to proxy uploads to the VM sandbox.",
      },
      { status: 501, headers: corsHeaders() },
    );
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

    const userId = (await getUserID(req)) ?? "";
    const connectionId = await getActiveSandboxConnectionId(userId);

    if (!connectionId) {
      return NextResponse.json(
        { error: "No active sandbox connection. Start a sandbox session first." },
        { status: 400, headers: corsHeaders() },
      );
    }

    const base64Content = Buffer.from(body).toString("base64");
    const requestId = crypto.randomUUID();
    const message = {
      type: "file_write",
      requestId,
      path: targetPath,
      content: base64Content,
      isBase64: true,
      targetConnectionId: connectionId,
    };

    const channel = `sandbox:connection:${connectionId}#${userId}`;
    const publishUrl = `${centrifugoHttpUrl.replace(/\/$/, "")}/api/publish`;

    const response = await fetch(publishUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `apikey ${centrifugoApiKey}`,
      },
      body: JSON.stringify({ channel, data: message }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { error: `Failed to publish to sandbox: ${response.status} ${errorText}` },
        { status: 500, headers: corsHeaders() },
      );
    }

    return NextResponse.json(
      { success: true, path: targetPath, size: actualSize, async: true },
      { headers: corsHeaders() },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `Proxy upload failed: ${msg}` }, { status: 500, headers: corsHeaders() });
  }
}

async function getActiveSandboxConnectionId(userId: string): Promise<string | null> {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    return null;
  }
  const convex = new ConvexHttpClient(convexUrl);
  const connectionId = await convex.query(api.localSandbox.getActiveSandboxConnectionId, { userId });
  return connectionId;
}