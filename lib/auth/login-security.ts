import {
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
  createHmac,
} from "node:crypto";
import { makeFunctionReference } from "convex/server";
import { getConvexClient } from "@/lib/db/convex-client";

export const SESSION_SECONDS = 8 * 3600;

export function sameOrigin(request: Request): boolean {
  try {
    const expected = new URL(
      process.env.PERSONAL_JWT_ISSUER ||
        process.env.NEXT_PUBLIC_BASE_URL ||
        request.url,
    ).origin;
    return (
      request.headers.get("origin") === expected &&
      request.headers.get("sec-fetch-site") !== "cross-site"
    );
  } catch {
    return false;
  }
}

export async function verifyLoginCredentials(
  email: unknown,
  password: unknown,
): Promise<boolean> {
  const stored = process.env.PERSONAL_LOGIN_PASSWORD_HASH || "";
  const expectedEmail = process.env.PERSONAL_LOGIN_EMAIL?.trim().toLowerCase();
  const [algorithm, salt, digest] = stored.split("$");
  if (
    !expectedEmail ||
    algorithm !== "scrypt" ||
    !/^[0-9a-f]{32}$/.test(salt || "") ||
    !/^[0-9a-f]{128}$/.test(digest || "")
  )
    throw new Error("Login credentials not configured");
  const validInput =
    typeof email === "string" &&
    email.length <= 254 &&
    typeof password === "string" &&
    password.length >= 1 &&
    password.length <= 1024;
  // Fixed cost even for invalid accounts. Hash is salted; plaintext is never persisted.
  const actual = await new Promise<Buffer>((resolve, reject) =>
    scryptCallback(
      validInput ? (password as string) : "invalid-input",
      salt,
      64,
      { N: 65536, r: 8, p: 2, maxmem: 128 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
  const emailHash = createHash("sha256")
    .update(
      typeof email === "string" ? email.trim().toLowerCase().slice(0, 254) : "",
    )
    .digest();
  const expectedEmailHash = createHash("sha256").update(expectedEmail).digest();
  return (
    timingSafeEqual(actual, Buffer.from(digest, "hex")) &&
    timingSafeEqual(emailHash, expectedEmailHash) &&
    validInput
  );
}

export function clientKey(request: Request): string {
  const address = process.env.VERCEL
    ? request.headers.get("x-vercel-forwarded-for") ||
      request.headers.get("x-forwarded-for") ||
      "unknown"
    : "local";
  const secret = process.env.CONVEX_SERVICE_ROLE_KEY;
  if (!secret) throw new Error("Login storage unavailable");
  return createHmac("sha256", secret)
    .update(address.split(",")[0].trim())
    .digest("hex");
}

export async function loginStore(
  operation:
    "consumeAttempt" | "createSession" | "validSession" | "revokeSession",
  args: Record<string, string | number>,
) {
  const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error("Login storage unavailable");
  const client = getConvexClient();
  const input = { ...args, serviceKey };
  if (operation === "validSession")
    return client.query(
      makeFunctionReference<"query">(`personalLogin:${operation}`),
      input,
    );
  return client.mutation(
    makeFunctionReference<"mutation">(`personalLogin:${operation}`),
    input,
  );
}
