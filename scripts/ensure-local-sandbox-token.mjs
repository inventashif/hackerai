#!/usr/bin/env node

import { ConvexHttpClient } from "convex/browser";
import { SignJWT } from "jose";
import { createPrivateKey } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

const resolveRootPath = (value) => {
  if (!value) return "";
  return path.isAbsolute(value) ? value : path.join(root, value);
};

const setEnvValue = (key, value) => {
  const text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const line = `${key}=${value}`;
  const next = new RegExp(`^${key}=.*$`, "m").test(text)
    ? text.replace(new RegExp(`^${key}=.*$`, "m"), line)
    : `${text.replace(/\s*$/, "")}\n${line}\n`;
  writeFileSync(envPath, next);
};

const env = {
  ...process.env,
  ...readEnvFile(envPath),
};

if (env.NODE_EXTRA_CA_CERTS && !existsSync(env.NODE_EXTRA_CA_CERTS)) {
  delete env.NODE_EXTRA_CA_CERTS;
  delete process.env.NODE_EXTRA_CA_CERTS;
}

const privateKeyPath = resolveRootPath(
  env.PERSONAL_JWT_PRIVATE_KEY_PATH || ".personal/jwt-private.pem",
);
const privateKeyPem =
  env.PERSONAL_JWT_PRIVATE_KEY?.replace(/\\n/g, "\n") ||
  readFileSync(privateKeyPath, "utf8");

const issuer = (env.PERSONAL_JWT_ISSUER || "http://localhost:3000").replace(
  /\/+$/,
  "",
);
const audience = env.PERSONAL_JWT_AUDIENCE || "hackerai-personal";
const email = env.PERSONAL_USER_EMAIL || "you@localhost";
const convexUrl = env.NEXT_PUBLIC_CONVEX_URL || "http://127.0.0.1:3210";

const jwt = await new SignJWT({
  email,
  name: email,
  entitlements: ["ultra-plan"],
})
  .setProtectedHeader({ alg: "RS256", kid: "hackerai-personal", typ: "JWT" })
  .setSubject("user_personal_local")
  .setIssuer(issuer)
  .setAudience(audience)
  .setIssuedAt()
  .setExpirationTime("30d")
  .sign(createPrivateKey(privateKeyPem));

const client = new ConvexHttpClient(convexUrl);
client.setAuth(jwt);

const result = await client.mutation("localSandbox:getToken", {});
if (!result?.token) {
  throw new Error("localSandbox:getToken returned no token");
}

setEnvValue("LOCAL_SANDBOX_TOKEN", result.token);
console.log("[local-sandbox-token] ready");
