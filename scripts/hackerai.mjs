#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env.local");

// ── helpers ──────────────────────────────────────────────────────────────
const log = (m) => console.log(`\x1b[36m[hackerai]\x1b[0m ${m}`);
const ok = (m) => console.log(`\x1b[32m✔ ${m}\x1b[0m`);
const warn = (m) => console.warn(`\x1b[33m⚠ ${m}\x1b[0m`);
const fail = (m) => console.error(`\x1b[31m✖ ${m}\x1b[0m`);

if (process.getuid?.() === 0 && process.env.SUDO_USER) {
  fail("Do not run HackerAI with sudo.");
  console.error(
    "Run `./hackerai` as your normal user. The launcher will ask for sudo only if Docker needs to be started.",
  );
  process.exit(1);
}

const shellCommand = (command) =>
  spawnSync("sh", ["-lc", command], { encoding: "utf8" }).stdout?.trim() || "";

/** readlink that returns "" instead of throwing on ESRCH / EACCES / ENOENT. */
const readlinkSafe = (p) => {
  try { return readlinkSync(p); } catch { return ""; }
};

const resolveCommand = (name, extraCandidates = []) => {
  for (const candidate of extraCandidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  const resolved = shellCommand(`command -v ${name} 2>/dev/null || true`);
  return resolved || name;
};

const pnpmCommand = resolveCommand("pnpm", [
  path.join(process.env.HOME || "", ".local/bin/pnpm"),
]);

if (!existsSync(pnpmCommand) && pnpmCommand.includes(path.sep)) {
  fail(`pnpm was not found at ${pnpmCommand}`);
  console.error("Install dependencies with `corepack pnpm install --frozen-lockfile`, then rerun `./hackerai`.");
  process.exit(1);
}

const diskAvailableKb = (targetPath) => {
  const result = spawnSync("df", ["-Pk", targetPath], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const line = result.stdout.trim().split(/\r?\n/).at(-1);
  const parts = line?.trim().split(/\s+/) || [];
  const available = Number(parts[3]);
  return Number.isFinite(available) ? available : null;
};

const canConnect = (host, port, timeoutMs = 1000) =>
  new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });

const minFreeKb = 1024 * 1024;
const availableKb = diskAvailableKb(root);
if (availableKb !== null && availableKb < minFreeKb) {
  fail(
    `Not enough free space on ${root} (${Math.floor(availableKb / 1024)} MiB available).`,
  );
  console.error(
    "Free at least 1 GiB before starting HackerAI; Convex local SQLite will fail when the filesystem is full.",
  );
  process.exit(1);
}

if (!existsSync(envPath)) {
  console.error("Missing .env.local. Run `pnpm personal:setup` first.");
  process.exit(1);
}
const envText = readFileSync(envPath, "utf8");
if (!/PERSONAL_MODE=true/.test(envText)) {
  console.error(".env.local is not in personal mode. Run `pnpm personal:setup` first.");
  process.exit(1);
}

const loadEnv = () => {
  const values = { ...process.env };
  const text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.split(/\s+#/)[0].trim();
    }
    if (values[key] === undefined) values[key] = value;
  }
  return values;
};

let env = loadEnv();

if (env.NODE_EXTRA_CA_CERTS && !existsSync(env.NODE_EXTRA_CA_CERTS)) {
  warn(`Ignoring missing NODE_EXTRA_CA_CERTS=${env.NODE_EXTRA_CA_CERTS}`);
  delete env.NODE_EXTRA_CA_CERTS;
  delete process.env.NODE_EXTRA_CA_CERTS;
}

const convexTmpDir = env.CONVEX_TMPDIR || path.join(root, ".convex", "tmp");
mkdirSync(convexTmpDir, { recursive: true });
env.CONVEX_TMPDIR = convexTmpDir;

// node version fix — ensure Convex local actions have Node 20/22/24
{
  const cur = spawnSync("node", ["-v"], { encoding: "utf8", env }).stdout?.trim();
  const maj = Number(cur?.replace(/^v/, "").split(".")[0]);
  if (![20, 22, 24].includes(maj)) {
    const fnmDir = path.join(process.env.HOME || "", ".local/share/fnm/node-versions");
    let found = false;
    if (existsSync(fnmDir)) {
      const { readdirSync } = await import("node:fs");
      for (const v of readdirSync(fnmDir).sort().reverse()) {
        const mj = Number(v.replace(/^v/, "").split(".")[0]);
        if (![20, 22, 24].includes(mj)) continue;
        const bin = path.join(fnmDir, v, "installation", "bin");
        if (existsSync(path.join(bin, "node"))) {
          env.PATH = `${bin}${path.delimiter}${env.PATH || ""}`;
          log(`Using Node ${v} for Convex local actions.`);
          found = true;
          break;
        }
      }
    }
    if (!found) {
      for (const bm of ["24", "22", "20"]) {
        const brewBin = `/home/linuxbrew/.linuxbrew/opt/node@${bm}/bin`;
        if (existsSync(path.join(brewBin, "node"))) {
          env.PATH = `${brewBin}${path.delimiter}${env.PATH || ""}`;
          log(`Using Homebrew Node ${bm} for Convex local actions.`);
          break;
        }
      }
    }
  }
}

// ── kill stale dev processes from a previous run ────────────────────────
//
// Repo-scoped by matching this checkout's absolute path in the process
// cmdline. Naked `pkill -f next-server` would also hit `next-server`
// instances from other projects on the same machine, which was a real risk
// on a laptop that also runs opencode and other Node monorepos.
//
// Graceful first (SIGTERM), then SIGKILL only if the process refused to
// exit. Convex's local backend writes a SQLite journal on shutdown; hard-
// killing it can leave the DB in a state that costs a restart to recover.
//
// NOTE on patterns: match the supervisor (`concurrently`) by bare name, not
// by `concurrently.*dev:local` — the supervisor's own cmdline never contains
// "dev:local" (that's pnpm's argument), so the old pattern matched nothing
// and orphaned supervisors accumulated across restarts, each looping `convex
// dev` against the same ports.
// Every layer of the dev:local tree must be listed: killing only pnpm leaves
// concurrently orphaned (pnpm does not forward signals), and killing only
// concurrently leaves CLIs that restart backends mid-sweep. sh -c wrappers
// need no entry — they exit when their matched child dies.
const DEV_PROCESS_PATTERNS = [
  "next-server",
  "next/dist/bin/next",
  "convex-local-backend",
  "convex/bin/main",
  "concurrently",
  "pnpm run dev:local",
  "pnpm exec convex",
  "packages/local/dist",
];

const listRepoDevPids = () => {
  const targets = new Set();
  for (const pattern of DEV_PROCESS_PATTERNS) {
    const r = spawnSync("pgrep", ["-af", pattern], { encoding: "utf8" });
    if (r.status !== 0 || !r.stdout) continue;
    for (const line of r.stdout.split(/\r?\n/)) {
      const [pidStr, ...cmdParts] = line.trim().split(/\s+/);
      const pid = Number(pidStr);
      if (!pid || pid === process.pid) continue;
      const cmd = cmdParts.join(" ");
      // Never match this launcher itself.
      if (cmd.includes("scripts/hackerai.mjs")) continue;
      // Only include processes running inside THIS checkout. The absolute
      // path appears in either the cmdline (spawned with cwd embedded) or
      // in /proc/<pid>/cwd. A dev server for a different repo won't match.
      const inThisRepo = cmd.includes(root);
      const matchesCwd = readlinkSafe(`/proc/${pid}/cwd`) === root;
      if (inThisRepo || matchesCwd) targets.add(pid);
    }
  }
  return targets;
};

// Graceful-first kill used at startup AND shutdown. Returns true when every
// target exited (or none existed).
const killRepoDevProcesses = (label) => {
  const targets = listRepoDevPids();
  if (targets.size === 0) return true;
  log(`${label}: stopping ${targets.size} repo dev process(es)`);
  for (const pid of targets) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  // Give them up to 5s to flush and exit cleanly before escalating.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const alive = [...targets].filter((pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    });
    if (alive.length === 0) return true;
    spawnSync("sleep", ["0.25"]);
  }
  for (const pid of targets) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  return false;
};

{
  killRepoDevProcesses("Cleaning stale dev process(es) from a prior run");
}

// ── refuse to start on occupied Convex/Next ports ─────────────────────────
//
// `convex dev` silently hops to 3211/3212/... when 3210 is taken, which breaks
// every assumption downstream (Convex URL, tunnels, relay, sandbox
// --convex-url) — a backend left on a hopped port can even serve a forked
// view of the same SQLite file. So after the stale cleanup above, verify the
// well-known ports are actually free and abort with the culprit PID instead
// of launching a wrong-port stack.
{
  const holdersOf = (port) => {
    const r = spawnSync("ss", ["-ltnp"], { encoding: "utf8" });
    if (r.status !== 0 || !r.stdout) return null; // tooling glitch: don't block launch
    const holders = [];
    for (const line of r.stdout.split(/\r?\n/)) {
      if (!line.includes(`:${port} `)) continue;
      for (const m of line.matchAll(/pid=(\d+)/g)) {
        const pid = Number(m[1]);
        if (pid && pid !== process.pid) holders.push(pid);
      }
    }
    return holders;
  };
  const guardedPorts = [3000, 3210, 3211, 3212];
  const deadline = Date.now() + 10000;
  let blocked = new Map();
  while (Date.now() < deadline) {
    blocked = new Map();
    let ssOk = true;
    for (const port of guardedPorts) {
      const holders = holdersOf(port);
      if (holders === null) { ssOk = false; break; }
      if (holders.length > 0) blocked.set(port, holders);
    }
    if (!ssOk || blocked.size === 0) { blocked = ssOk ? blocked : new Map(); break; }
    spawnSync("sleep", ["0.5"]);
  }
  if (blocked.size > 0) {
    for (const [port, holders] of blocked) {
      for (const pid of holders) {
        const cmd = spawnSync("ps", ["-o", "cmd=", "-p", String(pid)], { encoding: "utf8" }).stdout?.trim();
        fail(`Port ${port} still held by PID ${pid} (${cmd || "unknown"}) — refusing to start a wrong-port stack.`);
      }
    }
    console.error("Free the port(s) above (kill -9 the PIDs if needed) and rerun ./hackerai.");
    process.exit(1);
  }

  // Normalize persisted Convex ports. A previous port-hop is remembered in
  // .convex/local/default/config.json and reused forever — reset to the
  // well-known ports while nothing is running so the new backend binds 3210.
  try {
    const cfgPath = path.join(root, ".convex", "local", "default", "config.json");
    const raw = readFileSync(cfgPath, "utf8");
    const cfg = JSON.parse(raw);
    if (cfg?.ports && (cfg.ports.cloud !== 3210 || cfg.ports.site !== 3211)) {
      log(`Resetting persisted Convex ports ${cfg.ports.cloud}/${cfg.ports.site} → 3210/3211`);
      cfg.ports = { cloud: 3210, site: 3211 };
      writeFileSync(cfgPath, JSON.stringify(cfg));
    }
  } catch {}
}

// ── ensure LOCAL_SANDBOX_TOKEN persisted ─────────────────────────────────
const KNOWN_TOKEN = "hsb_ad9f74170dc6df602e773e174dd345cdf97bffb7995120323f71c75cc728a0e6";
let sandboxToken = env.LOCAL_SANDBOX_TOKEN || env.HACKERAI_LOCAL_SANDBOX_TOKEN || "";
if (!sandboxToken) {
  // try to find any hsb_ token already in .env.local
  const m = envText.match(/hsb_[a-f0-9]+/);
  if (m) sandboxToken = m[0];
}
if (!sandboxToken) sandboxToken = KNOWN_TOKEN;
if (!envText.includes("LOCAL_SANDBOX_TOKEN")) {
  try {
    appendFileSync(envPath, `\nLOCAL_SANDBOX_TOKEN=${sandboxToken}\n`);
    log("Saved LOCAL_SANDBOX_TOKEN to .env.local");
  } catch {}
}
env.LOCAL_SANDBOX_TOKEN = sandboxToken;

const reloadSandboxToken = () => {
  env = loadEnv();
  sandboxToken = env.LOCAL_SANDBOX_TOKEN || env.HACKERAI_LOCAL_SANDBOX_TOKEN || sandboxToken;
  env.LOCAL_SANDBOX_TOKEN = sandboxToken;
};

// ── ensure local sandbox built ───────────────────────────────────────────
const localDist = path.join(root, "packages/local/dist/index.js");
if (!existsSync(localDist)) {
  log("Building local sandbox (packages/local) ...");
  const r = spawnSync(pnpmCommand, ["run", "local-sandbox:build"], { cwd: root, env, stdio: "inherit" });
  if (r.status !== 0) warn("local-sandbox build failed — sandbox relay will not start");
}

// ── ensure docker + centrifugo ───────────────────────────────────────────
const ensureDocker = () => {
  const check = spawnSync("docker", ["ps"], { encoding: "utf8", stdio: "pipe" });
  if (check.status === 0) return true;
  log("Docker not running — starting...");
  const up = spawnSync("sudo", ["-n", "systemctl", "start", "docker"], { encoding: "utf8", stdio: "pipe" });
  if (up.status !== 0) {
    // try without sudo -n (may prompt)
    spawnSync("sudo", ["systemctl", "start", "docker"], { stdio: "inherit" });
  }
  const check2 = spawnSync("docker", ["ps"], { encoding: "utf8", stdio: "pipe" });
  return check2.status === 0;
};

if (!ensureDocker()) {
  warn("Docker not available — Centrifugo (local sandbox relay) will not start.");
  warn("Install Docker and rerun `hackerai` or `pnpm hackerai`.");
} else {
  const composeFiles = [
    "-f", path.join(root, "docker/centrifugo/docker-compose.yml"),
    "-f", path.join(root, "docker/centrifugo/docker-compose.personal.yml"),
  ];
  log("Starting Centrifugo (local sandbox relay) ...");
  const docker = spawnSync("docker", ["compose", ...composeFiles, "up", "-d"], { cwd: root, env, stdio: "inherit" });
  if (docker.status !== 0) {
    warn("Could not start Centrifugo via Docker. Relay needs ws://localhost:8001.");
  } else {
    ok("Centrifugo listening on ws://localhost:8001");
  }
}

// ── sync convex env (jwt, centrifugo, local-storage) ────────────────────
const syncConvexEnv = (maxAttempts = 1) => {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = spawnSync(process.execPath, [path.join(root, "scripts/sync-personal-convex-env.mjs")], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    if (output) process.stdout.write(output);
    if (result.status === 0 && !output.includes("could not set")) return true;
    if (attempt + 1 < maxAttempts) spawnSync("sleep", ["2"]);
  }
  warn("Could not sync Convex env — auth may fail until `pnpm personal:dev` syncs.");
  return false;
};

const ensureSandboxToken = () => {
  const result = spawnSync(process.execPath, [path.join(root, "scripts/ensure-local-sandbox-token.mjs")], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 15000,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (output) process.stdout.write(output);
  if (result.status !== 0) return false;
  reloadSandboxToken();
  return true;
};

// ── public tunnels (cloudflared quick tunnels) ─────────────────────────────
//
// One shared Centrifugo relay URL for local AND remote sandboxes
// (CENTRIFUGO_WS_URL == CENTRIFUGO_PUBLIC_WS_URL), plus PUBLIC_CONVEX_URL for
// the remote-machine connect command (local sandboxes keep reaching Convex
// over localhost). Resolved here, before dev:local spawns, so Next.js and
// Convex both inherit them.
const killPublicTunnels = () => {
  const sigterm = (pid) => {
    if (!pid || pid === process.pid) return;
    try { process.kill(pid, "SIGTERM"); } catch {}
  };
  // Quick tunnels match by target port. Named `tunnel run` daemons carry no
  // target in their cmdline, so they are tracked by PID in the state file.
  for (const port of [3210, 8001]) {
    const r = spawnSync("pgrep", ["-f", `cloudflared.*127.0.0.1:${port}`], { encoding: "utf8" });
    if (r.status !== 0 || !r.stdout) continue;
    for (const line of r.stdout.split(/\r?\n/)) {
      sigterm(Number(line.trim().split(/\s+/)[0]));
    }
  }
  try {
    const stateText = readFileSync(path.join(root, ".convex", "tmp", "public-tunnels.json"), "utf8");
    const state = JSON.parse(stateText);
    for (const entry of Object.values(state)) {
      if (entry && typeof entry === "object" && entry.mode === "named") {
        sigterm(Number(entry.pid));
      }
    }
  } catch {}
};

{
  log("Starting public tunnels for remote sandboxes (local stays on localhost) ...");
  const r = spawnSync(process.execPath, [path.join(root, "scripts/ensure-public-tunnels.mjs")], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 120000,
  });
  const output = `${r.stdout || ""}${r.stderr || ""}`;
  if (output) process.stdout.write(output);
  // Inject resolved public URLs into the env inherited by dev:local.
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^(PUBLIC_CONVEX_URL|CENTRIFUGO_PUBLIC_WS_URL)=(.*)$/);
    if (m && m[2]) {
      env[m[1]] = m[2];
      process.env[m[1]] = m[2];
    }
  }
  if (env.PUBLIC_CONVEX_URL || env.CENTRIFUGO_PUBLIC_WS_URL) {
    ok(`Remote sandboxes: convex=${env.PUBLIC_CONVEX_URL || "n/a"} centrifugo=${env.CENTRIFUGO_PUBLIC_WS_URL || "n/a"}`);
  } else {
    warn("Public tunnels unavailable — local sandbox still works; remote needs a retry.");
  }
}

// ── start Next.js + Convex ───────────────────────────────────────────────
log("Syncing local Convex env ...");
syncConvexEnv(2);
log("Starting Next.js + local Convex — Agent mode runs in-process.");

// Cap V8 heap so a runaway Next/Convex worker cannot OOM the box.
// Chosen for a 7-8GB laptop: default is ~2GB per Node process which stacks
// badly across concurrently's children (next, convex CLI, esbuild workers).
// Only applied if the caller has not already set NODE_OPTIONS themselves.
const totalMemMb = Math.floor(os.totalmem() / 1024 / 1024);
if (!env.NODE_OPTIONS) {
  const heapMb = totalMemMb <= 8192 ? 2048 : totalMemMb <= 16384 ? 3072 : 4096;
  env.NODE_OPTIONS = `--max-old-space-size=${heapMb}`;
  log(`Capping Node heap at ${heapMb} MiB (RAM ${Math.round(totalMemMb / 1024)} GiB)`);
}

const child = spawn(pnpmCommand, ["run", "dev:local"], { cwd: root, env, stdio: "inherit" });
child.on("error", (error) => {
  fail(`Could not start pnpm: ${error.message}`);
  console.error("Make sure pnpm is installed and run `./hackerai` without sudo.");
  process.exit(1);
});

// ── start local sandbox relay (after Convex is reachable) ────────────────
let sandboxProc = null;
let sandboxExitCode = null;
const startSandbox = () => {
  if (!sandboxToken) {
    warn("No LOCAL_SANDBOX_TOKEN — generate one in HackerAI → Settings → Remote Control");
    warn("Then: pnpm local-sandbox --token hsb_... --convex-url http://127.0.0.1:3210");
    return;
  }
  if (!existsSync(localDist)) return;
  log(`Starting local sandbox relay ...`);
  sandboxProc = spawn("node", [localDist, "--token", sandboxToken, "--convex-url", "http://127.0.0.1:3210"], {
    cwd: root,
    env,
    stdio: "inherit",
  });
  sandboxProc.on("exit", (code) => {
    sandboxExitCode = code;
    if (code !== 0 && code !== null) warn(`Local sandbox exited with code ${code}`);
  });
};

// Revive dead public tunnels without touching the app. Quick-tunnel daemons
// can be reaped (laptop sleep, OOM, cloudflared crash); without this the
// remote sandbox stays dark until the next manual restart. Runs the same
// idempotent script: live tunnels are reused in milliseconds, missing ones
// are recreated and re-synced. Never kills or restarts dev:local.
setInterval(() => {
  if (shuttingDown) return;
  try {
    const r = spawnSync(process.execPath, [path.join(root, "scripts/ensure-public-tunnels.mjs"), "--wait-ms", "15000"], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 60000,
    });
    const output = `${r.stdout || ""}${r.stderr || ""}`;
    let changed = false;
    for (const line of output.split(/\r?\n/)) {
      const m = line.match(/^(PUBLIC_CONVEX_URL|CENTRIFUGO_PUBLIC_WS_URL)=(.*)$/);
      if (m && m[2] && env[m[1]] !== m[2]) {
        env[m[1]] = m[2];
        process.env[m[1]] = m[2];
        changed = true;
      }
    }
    if (changed) {
      log(`Public tunnel URLs refreshed: convex=${env.PUBLIC_CONVEX_URL || "n/a"} centrifugo=${env.CENTRIFUGO_PUBLIC_WS_URL || "n/a"}`);
    }
  } catch {}
}, 60000).unref?.();

// poll for Convex + Next readiness, then launch sandbox
let sandboxStarted = false;
const pollReady = async () => {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    if (sandboxStarted) return;
    try {
      const convexOk = await canConnect("127.0.0.1", 3210);
      const nextOk = await canConnect("127.0.0.1", 3000);
      if (convexOk && nextOk) {
        if (!ensureSandboxToken()) continue;
        await new Promise((r) => setTimeout(r, 2000));
        sandboxStarted = true;
        startSandbox();
        setTimeout(() => {
          ok("HackerAI ready → http://localhost:3000");
          console.log("\x1b[2m  Next.js  : http://localhost:3000  (or http://127.0.0.1:3000)\x1b[0m");
          console.log("\x1b[2m  Convex   : http://127.0.0.1:3210\x1b[0m");
          console.log("\x1b[2m  Centrifugo: ws://localhost:8001 (container) → relay: " + (env.CENTRIFUGO_WS_URL || "ws://localhost:8001/connection/websocket") + "\x1b[0m");
          if (env.CENTRIFUGO_PUBLIC_WS_URL) {
            console.log(`\x1b[2m  Remote sandbox callback: ${env.CENTRIFUGO_PUBLIC_WS_URL}\x1b[0m`);
          }
          if (env.PUBLIC_CONVEX_URL) {
            console.log(`\x1b[2m  Remote convex callback: ${env.PUBLIC_CONVEX_URL}\x1b[0m`);
          }
          console.log(
            "\x1b[2m  Sandbox  : local relay " +
              (sandboxProc && sandboxExitCode === null ? "started" : "not running") +
              "\x1b[0m",
          );
        }, 1000);
        return;
      }
    } catch {}
  }
  if (!sandboxStarted) {
    warn("App did not become ready in time — check logs above.");
    warn("Local sandbox was not started because Convex is not reachable at http://127.0.0.1:3210.");
  }
};
pollReady();

// ── graceful shutdown ────────────────────────────────────────────────────
//
// Convex writes a SQLite journal on shutdown; SIGKILL leaves it in a state
// that costs a restart to recover. Give SIGTERM up to 5s to propagate through
// pnpm → concurrently → next/convex before escalating.
let shuttingDown = false;
const waitFor = async (proc, timeoutMs) => {
  if (!proc || proc.exitCode !== null) return;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    proc.once("exit", finish);
    setTimeout(finish, timeoutMs);
  });
};
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  log("Shutting down...");
  killPublicTunnels();
  if (sandboxProc && sandboxProc.exitCode === null) sandboxProc.kill("SIGTERM");
  if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.all([waitFor(child, 5000), waitFor(sandboxProc, 3000)]);
  if (child.exitCode === null) {
    warn("dev:local did not exit within 5s, escalating to SIGKILL");
    try { child.kill("SIGKILL"); } catch {}
  }
  if (sandboxProc && sandboxProc.exitCode === null) {
    try { sandboxProc.kill("SIGKILL"); } catch {}
  }
  // pnpm does not forward signals to its children: killing only `child`
  // orphans concurrently/next/backend (they kept running — and looping `convex
  // dev` — after Ctrl+C). Sweep the whole repo-scoped tree so no strays
  // survive to fight the next start over ports.
  killRepoDevProcesses("Shutdown sweep");
  process.exit(child.exitCode ?? 0);
};
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
child.on("exit", (code) => {
  // If dev:local dies unexpectedly, kill the sandbox relay so it does not
  // linger holding a Convex WebSocket to a dead backend.
  if (shuttingDown) return;
  killPublicTunnels();
  if (sandboxProc && sandboxProc.exitCode === null) sandboxProc.kill("SIGTERM");
  killRepoDevProcesses("Unexpected dev:local exit sweep");
  process.exit(code ?? 0);
});
