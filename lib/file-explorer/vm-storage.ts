import { createHmac } from "node:crypto";

export const MAX_VM_UPLOAD_BYTES = 500 * 1024 * 1024;
export type VMFileOperation = "read" | "write" | "stat" | "delete";

export function hasVMStorage(): boolean {
  return Boolean(process.env.VM_STORAGE_URL || process.env.CENTRIFUGO_WS_URL);
}

/** Exact-path, short-lived capabilities; never expose a long-lived VM secret. */
export function vmFileUrl(
  operation: VMFileOperation,
  filePath: string,
  options: { size?: number; preview?: boolean } = {},
): string {
  const secret = process.env.CENTRIFUGO_TOKEN_SECRET;
  const base = process.env.VM_STORAGE_URL || process.env.CENTRIFUGO_WS_URL;
  if (!secret || !base) throw new Error("VM storage is not configured");
  if (!filePath.startsWith("/") || filePath.includes("\0"))
    throw new Error("Invalid VM path");
  if (
    operation === "write" &&
    (!Number.isSafeInteger(options.size) ||
      options.size! < 0 ||
      options.size! > MAX_VM_UPLOAD_BYTES)
  ) {
    throw new Error("File exceeds the 500 MB upload limit");
  }
  const payload = Buffer.from(
    JSON.stringify({
      operation,
      path: filePath,
      ...options,
      expires: Date.now() + (operation === "write" ? 60 * 60_000 : 5 * 60_000),
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  const url = new URL(
    "/vm-files",
    base.replace(/^ws:/, "http:").replace(/^wss:/, "https:"),
  );
  url.searchParams.set("ticket", `${payload}.${signature}`);
  return url.toString();
}
