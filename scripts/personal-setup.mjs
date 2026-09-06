#!/usr/bin/env node

import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import path from "node:path";

const root = process.cwd();
const envPath = path.join(root, ".env.local");
const personalDir = path.join(root, ".personal");
const privateKeyPath = path.join(personalDir, "jwt-private.pem");
const publicKeyPath = path.join(personalDir, "jwt-public.pem");
const jwksPath = path.join(root, "public", ".well-known", "jwks.json");

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

const existing = readEnvFile(envPath);
const secret = (bytes = 32) => randomBytes(bytes).toString("base64");

mkdirSync(personalDir, { recursive: true });
mkdirSync(path.dirname(jwksPath), { recursive: true });

if (!existsSync(privateKeyPath) || !existsSync(publicKeyPath)) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
  writeFileSync(publicKeyPath, publicKey);
  console.log("Generated personal JWT keypair in .personal/");
} else {
  console.log("Reusing existing personal JWT keypair in .personal/");
}

const publicPem = readFileSync(publicKeyPath, "utf8");
const jwk = createPublicKey(publicPem).export({ format: "jwk" });
const jwks = {
  keys: [
    {
      ...jwk,
      kid: "hackerai-personal",
      alg: "RS256",
      use: "sig",
    },
  ],
};

// JWKS is served dynamically by app/.well-known/jwks.json/route.ts. Do not
// write public/.well-known/jwks.json: Next.js blocks dotfolders in public/
// and a stale file there conflicts with the route (500).
console.log("JWKS served dynamically via app/.well-known/jwks.json/route.ts");

const baseUrl = existing.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
const values = {
  PERSONAL_MODE: "true",
  NEXT_PUBLIC_PERSONAL_MODE: "true",
  PERSONAL_IN_PROCESS_AGENT: "true",
  NEXT_PUBLIC_PERSONAL_IN_PROCESS_AGENT: "true",
  DISABLE_E2B: "true",
  NEXT_PUBLIC_DISABLE_E2B: "true",
  OPENCODE_ZEN_ENABLED: "true",
  OPENCODE_ZEN_BASE_URL:
    existing.OPENCODE_ZEN_BASE_URL || "https://opencode.ai/zen/v1",
  OPENCODE_ZEN_API_KEY: existing.OPENCODE_ZEN_API_KEY || "",
  OPENCODE_ZEN_MODEL: existing.OPENCODE_ZEN_MODEL || "deepseek-v4-flash-free",
  OPENCODE_ZEN_MODEL_STANDARD:
    existing.OPENCODE_ZEN_MODEL_STANDARD || "deepseek-v4-flash-free",
  OPENCODE_ZEN_MODEL_PRO:
    existing.OPENCODE_ZEN_MODEL_PRO || "mimo-v2.5-free",
  OPENCODE_ZEN_MODEL_MAX:
    existing.OPENCODE_ZEN_MODEL_MAX || "nemotron-3-ultra-free",
  OPENCODE_ZEN_MODEL_VISION:
    existing.OPENCODE_ZEN_MODEL_VISION || "mimo-v2.5-free",
  PERSONAL_USER_EMAIL: existing.PERSONAL_USER_EMAIL || "you@localhost",
  PERSONAL_USER_FIRST_NAME: existing.PERSONAL_USER_FIRST_NAME || "Personal",
  PERSONAL_USER_LAST_NAME: existing.PERSONAL_USER_LAST_NAME || "User",
  PERSONAL_JWT_ISSUER: existing.PERSONAL_JWT_ISSUER || baseUrl,
  PERSONAL_JWT_AUDIENCE: existing.PERSONAL_JWT_AUDIENCE || "hackerai-personal",
  PERSONAL_JWT_JWKS_URL:
    existing.PERSONAL_JWT_JWKS_URL ||
    "http://127.0.0.1:3000/.well-known/jwks.json",
  PERSONAL_JWT_PRIVATE_KEY_PATH: ".personal/jwt-private.pem",
  PERSONAL_JWT_PUBLIC_KEY_PATH: ".personal/jwt-public.pem",
  NEXT_PUBLIC_BASE_URL: baseUrl,
  CONVEX_DEPLOYMENT:
    existing.CONVEX_DEPLOYMENT && existing.CONVEX_DEPLOYMENT.includes(":")
      ? existing.CONVEX_DEPLOYMENT
      : "",
  NEXT_PUBLIC_CONVEX_URL:
    existing.NEXT_PUBLIC_CONVEX_URL &&
    existing.NEXT_PUBLIC_CONVEX_URL !== "http://localhost:3210" &&
    !existing.NEXT_PUBLIC_CONVEX_URL.includes("your-deployment")
      ? existing.NEXT_PUBLIC_CONVEX_URL
      : "http://127.0.0.1:3210",
  CONVEX_SERVICE_ROLE_KEY:
    existing.CONVEX_SERVICE_ROLE_KEY || secret(32),
  ACCOUNT_IDENTITY_HMAC_SECRET:
    existing.ACCOUNT_IDENTITY_HMAC_SECRET || secret(32),
  CENTRIFUGO_TOKEN_SECRET:
    existing.CENTRIFUGO_TOKEN_SECRET || randomBytes(32).toString("hex"),
  CENTRIFUGO_API_KEY:
    existing.CENTRIFUGO_API_KEY || randomBytes(32).toString("hex"),
  CENTRIFUGO_WS_URL:
    existing.CENTRIFUGO_WS_URL || "ws://localhost:8001/connection/websocket",
  // Public (cloudflared) endpoints for REMOTE sandboxes. Quick-tunnel hostnames
  // are ephemeral, so these are filled in at runtime by
  // scripts/ensure-public-tunnels.mjs (started from ./hackerai) and left empty
  // here. Local sandboxes always use the localhost URLs above, which are
  // permanent; only the Remote Control "remote machine" command uses these.
  CENTRIFUGO_PUBLIC_WS_URL: existing.CENTRIFUGO_PUBLIC_WS_URL || "",
  PUBLIC_CONVEX_URL: existing.PUBLIC_CONVEX_URL || "",
};

const body = `# Personal / local HackerAI configuration
# Generated by: pnpm personal:setup
# Get a free OpenCode Zen key at https://opencode.ai/zen then paste it below.

PERSONAL_MODE=${values.PERSONAL_MODE}
NEXT_PUBLIC_PERSONAL_MODE=${values.NEXT_PUBLIC_PERSONAL_MODE}
PERSONAL_IN_PROCESS_AGENT=${values.PERSONAL_IN_PROCESS_AGENT}
NEXT_PUBLIC_PERSONAL_IN_PROCESS_AGENT=${values.NEXT_PUBLIC_PERSONAL_IN_PROCESS_AGENT}
DISABLE_E2B=${values.DISABLE_E2B}
NEXT_PUBLIC_DISABLE_E2B=${values.NEXT_PUBLIC_DISABLE_E2B}

OPENCODE_ZEN_ENABLED=${values.OPENCODE_ZEN_ENABLED}
OPENCODE_ZEN_BASE_URL=${values.OPENCODE_ZEN_BASE_URL}
OPENCODE_ZEN_API_KEY=${values.OPENCODE_ZEN_API_KEY}
OPENCODE_ZEN_MODEL=${values.OPENCODE_ZEN_MODEL}
OPENCODE_ZEN_MODEL_STANDARD=${values.OPENCODE_ZEN_MODEL_STANDARD}
OPENCODE_ZEN_MODEL_PRO=${values.OPENCODE_ZEN_MODEL_PRO}
OPENCODE_ZEN_MODEL_MAX=${values.OPENCODE_ZEN_MODEL_MAX}
OPENCODE_ZEN_MODEL_VISION=${values.OPENCODE_ZEN_MODEL_VISION}

PERSONAL_USER_EMAIL=${values.PERSONAL_USER_EMAIL}
PERSONAL_USER_FIRST_NAME=${values.PERSONAL_USER_FIRST_NAME}
PERSONAL_USER_LAST_NAME=${values.PERSONAL_USER_LAST_NAME}
PERSONAL_JWT_ISSUER=${values.PERSONAL_JWT_ISSUER}
PERSONAL_JWT_AUDIENCE=${values.PERSONAL_JWT_AUDIENCE}
PERSONAL_JWT_JWKS_URL=${values.PERSONAL_JWT_JWKS_URL}
PERSONAL_JWT_PRIVATE_KEY_PATH=${values.PERSONAL_JWT_PRIVATE_KEY_PATH}
PERSONAL_JWT_PUBLIC_KEY_PATH=${values.PERSONAL_JWT_PUBLIC_KEY_PATH}

NEXT_PUBLIC_BASE_URL=${values.NEXT_PUBLIC_BASE_URL}
${values.CONVEX_DEPLOYMENT ? `CONVEX_DEPLOYMENT=${values.CONVEX_DEPLOYMENT}\n` : ""}NEXT_PUBLIC_CONVEX_URL=${values.NEXT_PUBLIC_CONVEX_URL}
CONVEX_SERVICE_ROLE_KEY=${values.CONVEX_SERVICE_ROLE_KEY}
ACCOUNT_IDENTITY_HMAC_SECRET=${values.ACCOUNT_IDENTITY_HMAC_SECRET}

CENTRIFUGO_TOKEN_SECRET=${values.CENTRIFUGO_TOKEN_SECRET}
CENTRIFUGO_API_KEY=${values.CENTRIFUGO_API_KEY}
CENTRIFUGO_WS_URL=${values.CENTRIFUGO_WS_URL}
CENTRIFUGO_PUBLIC_WS_URL=${values.CENTRIFUGO_PUBLIC_WS_URL}
PUBLIC_CONVEX_URL=${values.PUBLIC_CONVEX_URL}

# Optional: stable hostnames via Cloudflare Zero Trust named tunnels.
# Set a token + its PUBLIC_* URL above and that target runs
# cloudflared tunnel run instead of an ephemeral quick tunnel.
# CLOUDFLARED_CONVEX_TUNNEL_TOKEN=
# CLOUDFLARED_CENTRIFUGO_TUNNEL_TOKEN=
`;

writeFileSync(envPath, body);
console.log(`Wrote ${path.relative(root, envPath)}`);
console.log(`Wrote ${path.relative(root, jwksPath)}`);

if (!values.OPENCODE_ZEN_API_KEY) {
  console.log(`
Add your OpenCode Zen API key to .env.local:

  OPENCODE_ZEN_API_KEY=...

Create a key at https://opencode.ai/zen (sign in, then copy an API key).
Free models such as deepseek-v4-flash-free work with that key.
`);
}

console.log(`Next:
  1. pnpm install
  2. Put OPENCODE_ZEN_API_KEY in .env.local if you have not already
  3. pnpm personal:dev
  4. Open http://localhost:3000
  5. Settings → Remote Control → Generate Token
  6. pnpm local-sandbox --token hsb_... --convex-url http://127.0.0.1:3210
`);
