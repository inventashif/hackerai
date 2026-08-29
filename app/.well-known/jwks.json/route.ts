import { NextResponse } from "next/server";
import { createPublicKey } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

let cachedJwks: string | null = null;

async function getJwksJson(): Promise<string | null> {
  if (cachedJwks) {
    return cachedJwks;
  }

  const publicKeyPath =
    process.env.PERSONAL_JWT_PUBLIC_KEY_PATH || ".personal/jwt-public.pem";
  const absolutePath = path.resolve(
    /* turbopackIgnore: true */ process.cwd(),
    publicKeyPath,
  );

  try {
    const publicPem = await fs.readFile(absolutePath, "utf8");
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
    cachedJwks = JSON.stringify(jwks);
    return cachedJwks;
  } catch {
    return null;
  }
}

export async function GET() {
  const jwks = await getJwksJson();
  if (!jwks) {
    return new NextResponse("JWKS not available", { status: 500 });
  }
  return new NextResponse(jwks, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
