#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
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

// ── kill stale dev processes (previous hackerai / personal:dev runs) ───────
{
  const stale = [
    ["-9", "-f", "next-server"],
    ["-9", "-f", "convex-local-backend"],
    ["-9", "-f", "concurrently.*dev:local"],
    ["-9", "-f", "packages/local/dist"],
  ];
  let killed = false;
  for (const args of stale) {
    const r = spawnSync("pkill", args, { stdio: "ignore" });
    if (r.status === 0) killed = true;
  }
  if (killed) {
    log("Cleaned up stale dev processes");
    spawnSync("sleep", ["1.5"]);
  }
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

// ── start Next.js + Convex ───────────────────────────────────────────────
log("Syncing local Convex env ...");
syncConvexEnv(2);
log("Starting Next.js + local Convex — Agent mode runs in-process.");
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
          console.log("\x1b[2m  Centrifugo: ws://localhost:8001\x1b[0m");
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
const shutdown = () => {
  if (sandboxProc) sandboxProc.kill("SIGTERM");
  child.kill("SIGTERM");
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
child.on("exit", (code) => {
  if (sandboxProc) sandboxProc.kill("SIGTERM");
  process.exit(code ?? 0);
});
