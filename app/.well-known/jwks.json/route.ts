import { NextResponse } from "next/server";
import { createPublicKey } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

let cachedJwks: string | null = null;

async function getJwksJson(): Promise<string | null> {
  if (cachedJwks) {
    return cachedJwks;
  }

  // On hosts without the key file (e.g. Vercel), the public key comes from
  // the PERSONAL_JWT_PUBLIC_KEY env var instead. Same decoding as
  // lib/auth/personal-jwt.ts: a PEM string, with literal \n sequences
  // converted to real newlines.
  const fromEnv = process.env.PERSONAL_JWT_PUBLIC_KEY?.trim().replace(
    /\\n/g,
    "\n",
  );
  if (fromEnv?.includes("BEGIN ")) {
    try {
      const jwk = createPublicKey(fromEnv).export({ format: "jwk" });
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
