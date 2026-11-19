// Offline owner bootstrap. Never print passwords or keys and never overwrite them.
import { generateKeyPairSync, randomBytes, scryptSync } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const directory =
  process.env.PRIVATE_LOGIN_SETUP_DIR ||
  path.join(homedir(), ".config/hackerai/private-login");
const credentialsPath = path.join(directory, "credentials.json");
const environmentPath = path.join(directory, "server.env");
if (existsSync(credentialsPath) || existsSync(environmentPath))
  throw new Error("Private login files already exist; refusing to overwrite");
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
const email = process.env.PRIVATE_LOGIN_EMAIL || "admin@inventashif.tech";
const password = randomBytes(32).toString("base64url");
const salt = randomBytes(16).toString("hex");
const hash = scryptSync(password, salt, 64, {
  N: 65536,
  r: 8,
  p: 2,
  maxmem: 128 * 1024 * 1024,
}).toString("hex");
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const values = {
  PERSONAL_LOGIN_EMAIL: email,
  PERSONAL_LOGIN_PASSWORD_HASH: `scrypt$${salt}$${hash}`,
  PERSONAL_JWT_PRIVATE_KEY: Buffer.from(privateKey).toString("base64"),
  PERSONAL_JWT_PUBLIC_KEY: Buffer.from(publicKey).toString("base64"),
  PERSONAL_JWT_KEY_ID: `hackerai-private-${randomBytes(12).toString("hex")}`,
};
writeFileSync(
  credentialsPath,
  JSON.stringify(
    { email, password, loginUrl: "https://inventashif.tech/inventashif-login" },
    null,
    2,
  ) + "\n",
  { mode: 0o600, flag: "wx" },
);
writeFileSync(
  environmentPath,
  Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n") + "\n",
  { mode: 0o600, flag: "wx" },
);
console.log(
  `Private owner credentials saved to ${credentialsPath} (mode 600). No values printed.`,
);
