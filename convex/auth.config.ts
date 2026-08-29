import type { AuthConfig } from "convex/server";

function createPersonalProvider() {
  const issuer = process.env.PERSONAL_JWT_ISSUER?.trim();
  const jwks = process.env.PERSONAL_JWT_JWKS_URL?.trim();
  const audience =
    process.env.PERSONAL_JWT_AUDIENCE?.trim() || "hackerai-personal";

  if (!issuer || !jwks) {
    throw new Error(
      "PERSONAL_JWT_ISSUER and PERSONAL_JWT_JWKS_URL must be set for personal Convex auth",
    );
  }

  return {
    type: "customJwt" as const,
    applicationID: audience,
    issuer,
    algorithm: "RS256" as const,
    jwks,
  };
}

const authConfig = {
  providers: [createPersonalProvider()],
} satisfies AuthConfig;

export default authConfig;
