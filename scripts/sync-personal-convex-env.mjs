#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env.local");

const readEnvFile = (filePath) => {
  if (!existsSync(filePath)) return {};
  const values = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
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
    values[key] = value;
  }
  return values;
};

const fileEnv = readEnvFile(envPath);
const get = (key, fallback = "") =>
  process.env[key] || fileEnv[key] || fallback;

const vars = {
  PERSONAL_JWT_ISSUER: get("PERSONAL_JWT_ISSUER", "http://localhost:3000"),
  PERSONAL_JWT_JWKS_URL: get(
    "PERSONAL_JWT_JWKS_URL",
    "http://127.0.0.1:3000/.well-known/jwks.json",
  ),
  PERSONAL_JWT_AUDIENCE: get("PERSONAL_JWT_AUDIENCE", "hackerai-personal"),
  CONVEX_SERVICE_ROLE_KEY: get("CONVEX_SERVICE_ROLE_KEY"),
  CENTRIFUGO_TOKEN_SECRET: get("CENTRIFUGO_TOKEN_SECRET"),
  CENTRIFUGO_WS_URL: get(
    "CENTRIFUGO_WS_URL",
    "ws://localhost:8001/connection/websocket",
  ),
  LOCAL_STORAGE_DIR: get("LOCAL_STORAGE_DIR", path.join(root, ".local-storage")),
};

const env = {
  ...process.env,
  ...fileEnv,
};

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
if (env.NODE_EXTRA_CA_CERTS && !existsSync(env.NODE_EXTRA_CA_CERTS)) {
  delete env.NODE_EXTRA_CA_CERTS;
  delete process.env.NODE_EXTRA_CA_CERTS;
}

for (const [key, value] of Object.entries(vars)) {
  if (!value) continue;
  const result = spawnSync(
    pnpmCommand,
    ["exec", "convex", "env", "set", key, value],
    {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    console.warn(`[convex-env] could not set ${key}: ${output || result.status}`);
    continue;
  }
  console.log(`[convex-env] set ${key}`);
}
