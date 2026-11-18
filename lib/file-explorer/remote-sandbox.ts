import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { CentrifugoSandbox } from "@/lib/ai/tools/utils/centrifugo-sandbox";

// A hosted application must never mistake its own disk for the user's VM.
export function usesRemoteFileSystem(): boolean {
  return Boolean(process.env.VERCEL_ENV || process.env.CENTRIFUGO_WS_URL);
}

export async function openFileSandbox(userId: string) {
  const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
  const wsUrl = process.env.CENTRIFUGO_WS_URL;
  const tokenSecret = process.env.CENTRIFUGO_TOKEN_SECRET;
  if (!serviceKey || !wsUrl || !tokenSecret) {
    throw new Error("VM file access is not configured");
  }
  const connections = await getConvexClient().query(
    api.localSandbox.listConnectionsForBackend,
    { serviceKey, userId },
  );
  const connection = connections.find((entry) => !entry.isDesktop);
  if (!connection) throw new Error("No connected VM sandbox available");
  return new CentrifugoSandbox(userId, connection, { wsUrl, tokenSecret });
}
