import { afterEach, describe, expect, it, jest } from "@jest/globals";

const originalIssuer = process.env.PERSONAL_JWT_ISSUER;
const originalJwks = process.env.PERSONAL_JWT_JWKS_URL;
const originalAudience = process.env.PERSONAL_JWT_AUDIENCE;

function restoreEnvironmentVariable(
  name: "PERSONAL_JWT_ISSUER" | "PERSONAL_JWT_JWKS_URL" | "PERSONAL_JWT_AUDIENCE",
  value: string | undefined,
) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function loadAuthConfig({
  issuer,
  jwks,
  audience,
}: {
  issuer?: string;
  jwks?: string;
  audience?: string;
}) {
  jest.resetModules();
  restoreEnvironmentVariable("PERSONAL_JWT_ISSUER", issuer);
  restoreEnvironmentVariable("PERSONAL_JWT_JWKS_URL", jwks);
  restoreEnvironmentVariable("PERSONAL_JWT_AUDIENCE", audience);
  return (await import("../auth.config")).default;
}

afterEach(() => {
  restoreEnvironmentVariable("PERSONAL_JWT_ISSUER", originalIssuer);
  restoreEnvironmentVariable("PERSONAL_JWT_JWKS_URL", originalJwks);
  restoreEnvironmentVariable("PERSONAL_JWT_AUDIENCE", originalAudience);
  jest.resetModules();
});

describe("Convex personal auth configuration", () => {
  it("uses the personal JWT provider", async () => {
    const authConfig = await loadAuthConfig({
      issuer: "http://localhost:3000",
      jwks: "http://127.0.0.1:3000/.well-known/jwks.json",
      audience: "hackerai-personal",
    });

    expect(authConfig.providers).toEqual([
      {
        type: "customJwt",
        applicationID: "hackerai-personal",
        issuer: "http://localhost:3000",
        algorithm: "RS256",
        jwks: "http://127.0.0.1:3000/.well-known/jwks.json",
      },
    ]);
  });

  it("defaults the audience when it is omitted", async () => {
    const authConfig = await loadAuthConfig({
      issuer: "http://localhost:3000",
      jwks: "http://127.0.0.1:3000/.well-known/jwks.json",
    });

    expect(authConfig.providers[0]).toMatchObject({
      applicationID: "hackerai-personal",
    });
  });

  it("rejects missing issuer or JWKS URL", async () => {
    await expect(
      loadAuthConfig({
        issuer: "http://localhost:3000",
      }),
    ).rejects.toThrow(
      "PERSONAL_JWT_ISSUER and PERSONAL_JWT_JWKS_URL must be set",
    );
  });
});
