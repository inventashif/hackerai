// Production Convex URL (must match @hackerai/local@latest package)
const PRODUCTION_CONVEX_URL = "https://convex.haiusercontent.com";

// Add --convex-url flag if running against non-production backend
export const convexUrlFlag =
  process.env.NEXT_PUBLIC_CONVEX_URL &&
  process.env.NEXT_PUBLIC_CONVEX_URL !== PRODUCTION_CONVEX_URL
    ? ` --convex-url ${process.env.NEXT_PUBLIC_CONVEX_URL}`
    : "";

// Use local path in dev (next dev), npx in production/preview
export const runCommand =
  process.env.NODE_ENV === "development"
    ? "node packages/local/dist/index.js"
    : "npx @hackerai/local@latest";

// Remote machines don't have this repo, so `node packages/local/...` is
// meaningless there. The remote command always uses the published package.
export const REMOTE_RUN_COMMAND = "npx @hackerai/local@latest";

// Minimum published @hackerai/local with --centrifugo-url + public fallback.
// Older clients ignore the flag and try localhost, which can never work
// from another machine.
export const MIN_REMOTE_CLIENT_VERSION = "0.8.6";

// Permanent localhost backend — same-machine sandboxes only.
export const LOCAL_CONVEX_URL = "http://127.0.0.1:3210";

/**
 * Connect command for a sandbox on THIS machine. Talks to the local Convex
 * backend directly; the command relay is the shared public URL the server
 * returns, same as remote sandboxes.
 */
export const buildLocalSandboxCommand = (token: string): string =>
  `${runCommand} --token ${token} --convex-url ${LOCAL_CONVEX_URL}`;

/**
 * Connect command for a sandbox on ANOTHER machine. A remote machine cannot
 * reach localhost, so both the Convex backend and the Centrifugo relay must
 * use the public cloudflared callback URLs. Returns null while the tunnels
 * are down (caller should show "starting…" instead of a broken command).
 */
export const buildRemoteSandboxCommand = (
  token: string,
  publicConvexUrl: string,
  publicCentrifugoWsUrl: string,
): string | null => {
  if (!publicConvexUrl || !publicCentrifugoWsUrl) return null;
  return (
    `${REMOTE_RUN_COMMAND} --token ${token} ` +
    `--convex-url ${publicConvexUrl} ` +
    `--centrifugo-url ${publicCentrifugoWsUrl}`
  );
};
