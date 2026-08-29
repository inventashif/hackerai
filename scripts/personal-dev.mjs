#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const envPath = path.join(root, ".env.local");

if (!existsSync(envPath)) {
  console.error("Missing .env.local. Run `pnpm personal:setup` first.");
  process.exit(1);
}

const envText = readFileSync(envPath, "utf8");
if (!/PERSONAL_MODE=true/.test(envText)) {
  console.error(
    ".env.local is not in personal mode. Run `pnpm personal:setup` first.",
  );
  process.exit(1);
}

const loadEnv = () => {
  const values = { ...process.env };
  for (const line of envText.split(/\r?\n/)) {
    if (!line || line.trim().startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.split(/\s+#/)[0].trim();
    }
    if (values[key] === undefined) values[key] = value;
  }
  return values;
};

const prependSupportedNode = (currentEnv) => {
  const nextEnv = { ...currentEnv };
  const currentVersion = spawnSync("node", ["-v"], {
    encoding: "utf8",
    env: nextEnv,
  }).stdout?.trim();
  const currentMajor = Number(currentVersion?.replace(/^v/, "").split(".")[0]);
  if ([20, 22, 24].includes(currentMajor)) {
    return nextEnv;
  }

  const fnmVersionsDir = path.join(
    process.env.HOME || "",
    ".local/share/fnm/node-versions",
  );
  if (existsSync(fnmVersionsDir)) {
    for (const version of readdirSync(fnmVersionsDir).sort().reverse()) {
      const major = Number(version.replace(/^v/, "").split(".")[0]);
      if (![20, 22, 24].includes(major)) continue;
      const binDir = path.join(fnmVersionsDir, version, "installation", "bin");
      if (existsSync(path.join(binDir, "node"))) {
        nextEnv.PATH = `${binDir}${path.delimiter}${nextEnv.PATH || ""}`;
        console.log(`Using Node ${version} for Convex local actions.`);
        return nextEnv;
      }
    }
  }

  for (const brewMajor of ["24", "22", "20"]) {
    const brewBin = `/home/linuxbrew/.linuxbrew/opt/node@${brewMajor}/bin`;
    if (existsSync(path.join(brewBin, "node"))) {
      nextEnv.PATH = `${brewBin}${path.delimiter}${nextEnv.PATH || ""}`;
      console.log(`Using Homebrew Node ${brewMajor} for Convex local actions.`);
      return nextEnv;
    }
  }

  console.warn(
    `Convex local node actions need Node 20, 22, or 24. Current: ${currentVersion || "unknown"}.`,
  );
  console.warn("Install one with: fnm install 24 && fnm use 24");
  return nextEnv;
};

const env = prependSupportedNode(loadEnv());
const composeFiles = [
  "-f",
  path.join(root, "docker/centrifugo/docker-compose.yml"),
  "-f",
  path.join(root, "docker/centrifugo/docker-compose.personal.yml"),
];

const docker = spawnSync("docker", ["compose", ...composeFiles, "up", "-d"], {
  cwd: root,
  env,
  stdio: "inherit",
});

if (docker.status !== 0) {
  console.warn(
    "Could not start Centrifugo via Docker. Agent local sandbox relay needs it on ws://localhost:8001.",
  );
  console.warn(
    "Install Docker and rerun `pnpm personal:dev`, or start Centrifugo yourself.",
  );
}

console.log("Starting Next.js + local Convex. Agent mode runs in-process.");
console.log("After the app is up: Settings → Remote Control → Generate Token");
console.log(
  "Then: pnpm local-sandbox --token hsb_... --convex-url http://127.0.0.1:3210",
);

const syncConvexEnv = (attempt = 0) => {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "scripts/sync-personal-convex-env.mjs")],
    { cwd: root, env, encoding: "utf8" },
  );
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (output) process.stdout.write(output);
  if (result.status === 0 && !output.includes("could not set")) {
    return;
  }
  if (attempt >= 15) {
    console.warn(
      "Could not sync personal JWT env vars into Convex. Auth may fail until they are set.",
    );
    return;
  }
  setTimeout(() => syncConvexEnv(attempt + 1), 2000);
};

setTimeout(() => syncConvexEnv(), 4000);

const child = spawn("pnpm", ["run", "dev:local"], {
  cwd: root,
  env,
  stdio: "inherit",
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
