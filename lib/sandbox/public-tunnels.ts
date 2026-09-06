import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface PublicTunnelUrls {
  /**
   * Public Convex backend URL for REMOTE sandboxes
   * (e.g. https://<id>.trycloudflare.com). Empty while tunnels are down.
   */
  publicConvexUrl: string;
  /**
   * Public Centrifugo relay URL for REMOTE sandboxes
   * (e.g. wss://<id>.trycloudflare.com/connection/websocket).
   * Empty while tunnels are down.
   */
  publicCentrifugoWsUrl: string;
  /** Relay URL served to clients (shared public URL for all sandboxes). */
  localCentrifugoWsUrl: string;
  /** True when at least one public tunnel is currently usable. */
  tunnelsReady: boolean;
}

export type TunnelStateFile = {
  convex?: { hostname?: string };
  centrifugo?: { hostname?: string };
};

const readTunnelStateFile = (): TunnelStateFile => {
  try {
    const statePath = path.join(
      process.cwd(),
      ".convex",
      "tmp",
      "public-tunnels.json",
    );
    if (!existsSync(statePath)) return {};
    return JSON.parse(readFileSync(statePath, "utf8")) as TunnelStateFile;
  } catch {
    return {};
  }
};

const isHttpUrl = (value: string): boolean =>
  value.startsWith("https://") || value.startsWith("http://");

const isWsUrl = (value: string): boolean =>
  value.startsWith("wss://") || value.startsWith("ws://");

/**
 * A PUBLIC callback must be reachable from another machine. Loopback values
 * here mean misconfiguration (the exact bug this feature fixes: remote
 * sandboxes handed a localhost URL they can never dial), so they are treated
 * as unset and the UI shows "tunnel not ready" instead of a broken command.
 */
const isLoopbackUrl = (value: string): boolean => {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return true;
  }
};

/**
 * Pure URL resolution: live tunnel state wins, process env is the fallback.
 * Exported for unit tests — production callers use getPublicTunnelUrls().
 */
export const resolvePublicTunnelUrls = (
  state: TunnelStateFile,
  env: NodeJS.ProcessEnv,
): PublicTunnelUrls => {
  const stateConvex = state.convex?.hostname
    ? `https://${state.convex.hostname}`
    : "";
  const stateCentrifugo = state.centrifugo?.hostname
    ? `wss://${state.centrifugo.hostname}/connection/websocket`
    : "";

  const envConvex = env.PUBLIC_CONVEX_URL ?? "";
  const envCentrifugo = env.CENTRIFUGO_PUBLIC_WS_URL ?? "";

  const usable = (value: string, ok: (v: string) => boolean): string =>
    ok(value) && !isLoopbackUrl(value) ? value : "";

  const publicConvexUrl =
    usable(stateConvex, isHttpUrl) || usable(envConvex, isHttpUrl);
  const publicCentrifugoWsUrl =
    usable(stateCentrifugo, isWsUrl) || usable(envCentrifugo, isWsUrl);

  return {
    publicConvexUrl,
    publicCentrifugoWsUrl,
    localCentrifugoWsUrl:
      env.CENTRIFUGO_WS_URL ?? "ws://localhost:8001/connection/websocket",
    tunnelsReady: publicConvexUrl !== "" || publicCentrifugoWsUrl !== "",
  };
};

/**
 * Resolve the public callback URLs remote sandboxes must use.
 *
 * The tunnel state file is read live on every call because quick-tunnel
 * hostnames change whenever cloudflared restarts — a value baked into
 * NEXT_PUBLIC_* at build time (or captured at Next.js boot) would go stale.
 * Falls back to the process env snapshot taken when the server started.
 */
export const getPublicTunnelUrls = (): PublicTunnelUrls =>
  resolvePublicTunnelUrls(readTunnelStateFile(), process.env);
