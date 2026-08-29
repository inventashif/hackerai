import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { MAX_AGENT_FILE_SIZE_BYTES } from "@/lib/constants/s3";

const LOCAL_STORAGE_KEY_PATTERN =
  /^users\/[A-Za-z0-9_.-]{1,128}\/\d{1,20}-[0-9a-fA-F-]{1,64}(\.[A-Za-z0-9]{1,20})?$/;

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

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function PUT(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key") ?? "";
  const filePath = resolveKey(key);
  if (!filePath) {
    return new NextResponse("Invalid storage key", {
      status: 400,
      headers: corsHeaders(),
    });
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (contentType && contentType.length > 128) {
    return new NextResponse("Invalid content type", {
      status: 400,
      headers: corsHeaders(),
    });
  }

  const bytes = Buffer.from(await req.arrayBuffer());
  if (bytes.byteLength > MAX_AGENT_FILE_SIZE_BYTES) {
    return new NextResponse("File exceeds maximum allowed size", {
      status: 413,
      headers: corsHeaders(),
    });
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, bytes);

  return new NextResponse(null, { status: 200, headers: corsHeaders() });
}
