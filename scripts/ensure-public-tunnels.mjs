#!/usr/bin/env node
/**
 * ensure-public-tunnels.mjs
 *
 * Starts cloudflared quick tunnels for the two endpoints a REMOTE sandbox
 * needs to reach this machine:
 *
 *   - Convex backend   (http://127.0.0.1:3210) -> PUBLIC_CONVEX_URL
 *   - Centrifugo relay (http://127.0.0.1:8001) -> CENTRIFUGO_PUBLIC_WS_URL
 *
 * The Centrifugo public URL is served as the single shared relay
 * (CENTRIFUGO_WS_URL == CENTRIFUGO_PUBLIC_WS_URL), so local and remote
 * sandboxes use the same address — including older clients that only read
 * the primary URL. The Convex backend stays localhost-only for same-machine
 * sandboxes; only the "remote machine" command uses PUBLIC_CONVEX_URL.
 *
 * Behaviour:
 *   - Reuses already-running tunnels for the same target ports (idempotent).
 *   - Writes resolved URLs to .env.local (CENTRIFUGO_PUBLIC_WS_URL,
 *     PUBLIC_CONVEX_URL) and to .convex/tmp/public-tunnels.json (live state
 *     the /api/sandbox/connect-info route reads at request time, so a tunnel
 *     restart is reflected without restarting Next.js).
 *   - Re-syncs the two keys to the local Convex env (connect returns the
 *     public WS URL to remote clients).
 *   - Prints `KEY=VALUE` lines to stdout for the caller (./hackerai) to
 *     inject into the dev:local child env. Exits 0 even when tunnels fail —
 *     local mode must keep working without them.
 *
 * Named tunnels (stable hostnames): set CLOUDFLARED_CONVEX_TUNNEL_TOKEN
 * and/or CLOUDFLARED_CENTRIFUGO_TUNNEL_TOKEN plus the matching PUBLIC_* URL.
 * That target then runs `cloudflared tunnel run` instead of a quick tunnel,
 * and its configured URL is left untouched.
 *
 * Usage:
 *   node scripts/ensure-public-tunnels.mjs [--wait-ms 45000] [--no-sync]
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  openSync,
  closeSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env.local");
const statePath = path.join(root, ".convex", "tmp", "public-tunnels.json");

// Optional stable hostnames via Cloudflare Zero Trust named tunnels.
// Set the token for a target to switch THAT target from an ephemeral quick
// tunnel to `cloudflared tunnel run`. The matching PUBLIC_* URL must already
// be set (it is the stable DNS you configured in Cloudflare) — named mode
// never overwrites it, it only keeps the daemon alive. Tokens are
// machine-local secrets: they are read from the environment, never written
// to files, and never synced to Convex.
const TUNNELS = [
  {
    name: "convex",
    port: 3210,
    tokenEnv: "CLOUDFLARED_CONVEX_TUNNEL_TOKEN",
    publicUrlEnv: "PUBLIC_CONVEX_URL",
    buildPublicUrl: (hostname) => `https://${hostname}`,
  },
  {
    name: "centrifugo",
    port: 8001,
    tokenEnv: "CLOUDFLARED_CENTRIFUGO_TUNNEL_TOKEN",
    publicUrlEnv: "CENTRIFUGO_PUBLIC_WS_URL",
    buildPublicUrl: (hostname) => `wss://${hostname}/connection/websocket`,
  },
];

/** Hostname from a configured public URL, or "" when missing/unusable. */
const hostnameFromPublicUrl = (value) => {
  if (!value) return "";
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (!host || host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return "";
    }
    return host;
  } catch {
    return "";
  }
};

const args = process.argv.slice(2);
const getArg = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const WAIT_MS = getArg("--wait-ms", 45000);
const DO_SYNC = !args.includes("--no-sync");

const log = (m) => console.log(`[public-tunnels] ${m}`);
const warn = (m) => console.warn(`[public-tunnels] ${m}`);

const targetOf = (port) => `http://127.0.0.1:${port}`;

const resolveCloudflared = () => {
  for (const c of [
    path.join(process.env.HOME || "", ".local/bin/cloudflared"),
    "/usr/local/bin/cloudflared",
  ]) {
    if (c && existsSync(c)) return c;
  }
  const r = spawnSync("sh", ["-lc", "command -v cloudflared 2>/dev/null || true"], {
    encoding: "utf8",
  });
  return r.stdout?.trim() || null;
};

const listTunnelPids = (port) => {
  const r = spawnSync("pgrep", ["-af", `cloudflared.*${targetOf(port)}`], {
    encoding: "utf8",
  });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((l) => Number(l.trim().split(/\s+/)[0]))
    .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid);
};

const readState = () => {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return {};
  }
};

const writeState = (state) => {
  mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2));
  renameSync(tmp, statePath);
};

const upsertEnvLine = (key, value) => {
  let text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(text)) {
    text = text.replace(re, line);
  } else {
    if (text && !text.endsWith("\n")) text += "\n";
    text += `${line}\n`;
  }
  writeFileSync(envPath, text);
};

/** Poll a cloudflared log file until a trycloudflare hostname appears. */
const waitForHostname = (logFile, timeoutMs) =>
  new Promise((resolve) => {
    const re = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/;
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      try {
        const m = readFileSync(logFile, "utf8").match(re);
        if (m) {
          clearInterval(timer);
          resolve(m[1]);
          return;
        }
      } catch {
        // Log file not written yet.
      }
      if (Date.now() >= deadline) {
        clearInterval(timer);
        resolve(null);
      }
    }, 500);
  });

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const ensureNamedTunnel = async (cloudflaredBin, spec) => {
  const { name, port, tokenEnv, publicUrlEnv, buildPublicUrl } = spec;
  const target = targetOf(port);
  const token = (process.env[tokenEnv] || "").trim();
  const publicUrl = (process.env[publicUrlEnv] || "").trim();
  const hostname = hostnameFromPublicUrl(publicUrl);
  if (!hostname) {
    warn(`${name}: ${tokenEnv} is set but ${publicUrlEnv} is missing — cannot use named tunnel`);
    return null;
  }

  // Reuse the recorded daemon when it is still alive.
  const prev = readState()[name];
  if (prev?.mode === "named" && Number.isFinite(prev?.pid) && pidAlive(prev.pid)) {
    log(`${name}: reusing named tunnel https://${hostname} (pid ${prev.pid})`);
    return { port, target, hostname, pid: prev.pid, mode: "named", publicUrl };
  }

  const logFile = `/tmp/hackerai-tunnel-${port}.log`;
  try {
    writeFileSync(logFile, "");
  } catch (e) {
    warn(`${name}: cannot write log file: ${e.message}`);
    return null;
  }
  let errFd;
  try {
    errFd = openSync(logFile, "a");
  } catch (e) {
    warn(`${name}: cannot open log file: ${e.message}`);
    return null;
  }
  // Token via env (not argv) so it never appears in the process list.
  const daemon = spawn(cloudflaredBin, ["tunnel", "run"], {
    detached: true,
    stdio: ["ignore", "ignore", errFd],
    env: { ...process.env, TUNNEL_TOKEN: token },
  });
  daemon.on("error", (err) => {
    warn(`${name}: failed to spawn cloudflared: ${err.message}`);
  });
  daemon.unref();
  try {
    closeSync(errFd);
  } catch {}

  // Named tunnels have no hostname to wait for — the DNS already exists.
  // Give the daemon a moment, then confirm it stayed alive.
  await new Promise((r) => setTimeout(r, 3000));
  if (daemon.pid && pidAlive(daemon.pid)) {
    log(`${name}: named tunnel live at https://${hostname} (pid ${daemon.pid})`);
    return { port, target, hostname, pid: daemon.pid, mode: "named", publicUrl };
  }
  warn(`${name}: named tunnel daemon exited immediately — see ${logFile}`);
  return null;
};

const ensureTunnel = async (cloudflaredBin, spec) => {
  // Named tunnel takes precedence when its token is configured.
  if ((process.env[spec.tokenEnv] || "").trim()) {
    return ensureNamedTunnel(cloudflaredBin, spec);
  }
  const { name, port } = spec;
  const target = targetOf(port);
  const logFile = `/tmp/hackerai-tunnel-${port}.log`;

  // Reuse a live tunnel for the same target when the previous state still
  // matches a running process.
  const existing = listTunnelPids(port);
  const prev = readState()[name];
  if (existing.length > 0 && prev?.hostname) {
    try {
      process.kill(existing[0], 0);
      log(`${name}: reusing tunnel https://${prev.hostname} (pid ${existing[0]})`);
      return { port, target, hostname: prev.hostname, pid: existing[0], mode: "quick" };
    } catch {
      // PID stale — fall through and start fresh.
    }
  }
  for (const pid of existing) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }

  // Truncate the log so we never match a hostname from a previous run.
  try {
    writeFileSync(logFile, "");
  } catch (e) {
    warn(`${name}: cannot write log file: ${e.message}`);
    return null;
  }

  let errFd;
  try {
    errFd = openSync(logFile, "a");
  } catch (e) {
    warn(`${name}: cannot open log file: ${e.message}`);
    return null;
  }
  const daemon = spawn(cloudflaredBin, ["tunnel", "--url", target], {
    detached: true,
    stdio: ["ignore", "ignore", errFd],
  });
  daemon.on("error", (err) => {
    warn(`${name}: failed to spawn cloudflared: ${err.message}`);
  });
  daemon.unref();
  try {
    closeSync(errFd);
  } catch {}

  log(`${name}: waiting for public hostname (pid ${daemon.pid})...`);
  const hostname = await waitForHostname(logFile, WAIT_MS);
  if (!hostname) {
    warn(`${name}: no hostname within ${WAIT_MS}ms — remote unavailable`);
    try {
      process.kill(daemon.pid, "SIGTERM");
    } catch {}
    return null;
  }
  log(`${name}: live at https://${hostname}`);
  return { port, target, hostname, pid: daemon.pid ?? null, mode: "quick" };
};

const main = async () => {
  const cloudflaredBin = resolveCloudflared();
  const state = readState();
  const next = { ...state };
  const results = {};

  if (!cloudflaredBin) {
    warn("cloudflared not found — remote sandboxes unavailable (local still works)");
  } else {
    for (const t of TUNNELS) {
      results[t.name] = await ensureTunnel(cloudflaredBin, t);
      if (results[t.name]) {
        next[t.name] = results[t.name];
      } else {
        delete next[t.name];
      }
    }
  }
  writeState(next);

  // Named mode keeps the user-configured URLs untouched; quick mode writes
  // the freshly resolved hostnames so restarts and UI pick them up.
  const publicUrlFor = (spec, result) => {
    if (!result) return "";
    if (result.mode === "named") return result.publicUrl;
    return spec.buildPublicUrl(result.hostname);
  };
  const publicConvexUrl = publicUrlFor(TUNNELS[0], results.convex);
  const publicWsUrl = publicUrlFor(TUNNELS[1], results.centrifugo);

  if (publicConvexUrl && results.convex?.mode !== "named") {
    upsertEnvLine("PUBLIC_CONVEX_URL", publicConvexUrl);
  }
  if (publicWsUrl && results.centrifugo?.mode !== "named") {
    upsertEnvLine("CENTRIFUGO_PUBLIC_WS_URL", publicWsUrl);
    // The relay primary MUST track the live public URL: older clients only
    // read CENTRIFUGO_WS_URL, so a rotation that updates PUBLIC_* without
    // the primary leaves them dialing a dead tunnel (silent 20s timeouts).
    upsertEnvLine("CENTRIFUGO_WS_URL", publicWsUrl);
  }

  if (DO_SYNC && (publicConvexUrl || publicWsUrl)) {
    const r = spawnSync(
      process.execPath,
      [path.join(root, "scripts/sync-personal-convex-env.mjs")],
      { cwd: root, encoding: "utf8", timeout: 60000 },
    );
    const out = `${r.stdout || ""}${r.stderr || ""}`;
    if (out) process.stdout.write(out);
  }

  // Machine-readable output for ./hackerai to inject into the child env.
  console.log(`PUBLIC_CONVEX_URL=${publicConvexUrl}`);
  console.log(`CENTRIFUGO_PUBLIC_WS_URL=${publicWsUrl}`);

  if (!publicConvexUrl && !publicWsUrl) {
    warn("no public tunnels — local sandboxes still work; remote needs a retry");
  }
};

await main();
