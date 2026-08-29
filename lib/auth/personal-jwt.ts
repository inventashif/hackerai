import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { exportJWK, SignJWT, jwtVerify, type JWTPayload } from "jose";
import {
  PERSONAL_COOKIE_NAME,
  PERSONAL_USER_ID,
  getPersonalJwtAudience,
  getPersonalJwtIssuer,
  getPersonalUserEmail,
} from "./personal-mode";

const JWT_ALG = "RS256";
const JWT_TTL = "30d";

function readOptionalFile(pathValue: string | undefined): string | undefined {
  const filePath = pathValue?.trim();
  if (!filePath) return undefined;
  return readFileSync(filePath, "utf8");
}

function decodeKeyMaterial(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes("BEGIN ")) {
    return trimmed.replace(/\\n/g, "\n");
  }
  try {
    return Buffer.from(trimmed, "base64").toString("utf8");
  } catch {
    return trimmed;
  }
}

function getPrivateKeyPem(): string {
  const fromFile = readOptionalFile(process.env.PERSONAL_JWT_PRIVATE_KEY_PATH);
  const fromEnv = decodeKeyMaterial(process.env.PERSONAL_JWT_PRIVATE_KEY);
  const pem = fromFile || fromEnv;
  if (!pem) {
    throw new Error(
      "PERSONAL_JWT_PRIVATE_KEY or PERSONAL_JWT_PRIVATE_KEY_PATH is required in personal mode",
    );
  }
  return pem;
}

function getPublicKeyPem(): string {
  const fromFile = readOptionalFile(process.env.PERSONAL_JWT_PUBLIC_KEY_PATH);
  const fromEnv = decodeKeyMaterial(process.env.PERSONAL_JWT_PUBLIC_KEY);
  const pem = fromFile || fromEnv;
  if (!pem) {
    throw new Error(
      "PERSONAL_JWT_PUBLIC_KEY or PERSONAL_JWT_PUBLIC_KEY_PATH is required in personal mode",
    );
  }
  return pem;
}

export async function getPersonalJwks() {
  const publicKey = createPublicKey(getPublicKeyPem());
  const jwk = await exportJWK(publicKey);
  return {
    keys: [
      {
        ...jwk,
        kid: "hackerai-personal",
        alg: JWT_ALG,
        use: "sig",
      },
    ],
  };
}

export async function signPersonalAccessToken(): Promise<string> {
  const privateKey = createPrivateKey(getPrivateKeyPem());
  const issuer = getPersonalJwtIssuer();
  const audience = getPersonalJwtAudience();
  const email = getPersonalUserEmail();

  return new SignJWT({
    email,
    name: email,
    entitlements: ["ultra-plan"],
  })
    .setProtectedHeader({ alg: JWT_ALG, kid: "hackerai-personal", typ: "JWT" })
    .setSubject(PERSONAL_USER_ID)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(JWT_TTL)
    .sign(privateKey);
}

export async function verifyPersonalAccessToken(
  token: string,
): Promise<JWTPayload> {
  const publicKey = createPublicKey(getPublicKeyPem());
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: getPersonalJwtIssuer(),
    audience: getPersonalJwtAudience(),
    algorithms: [JWT_ALG],
  });
  return payload;
}

export function serializePersonalSessionCookie(token: string): string {
  const maxAge = 60 * 60 * 24 * 30;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${PERSONAL_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function clearPersonalSessionCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${PERSONAL_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
