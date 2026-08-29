export const PERSONAL_COOKIE_NAME = "personal-session";
export const PERSONAL_ACCESS_TOKEN_HEADER = "x-personal-access-token";
export const PERSONAL_USER_ID = "user_personal_local";
export const PERSONAL_JWT_AUDIENCE = "hackerai-personal";
export const PERSONAL_ENTITLEMENTS = ["ultra-plan"] as const;

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function envFlag(value: string | undefined): boolean {
  return TRUTHY.has((value ?? "").trim().toLowerCase());
}

export function isPersonalMode(): boolean {
  return (
    envFlag(process.env.PERSONAL_MODE) ||
    envFlag(process.env.NEXT_PUBLIC_PERSONAL_MODE)
  );
}

export function isE2BDisabled(): boolean {
  return (
    isPersonalMode() ||
    envFlag(process.env.DISABLE_E2B) ||
    envFlag(process.env.NEXT_PUBLIC_DISABLE_E2B)
  );
}

export function isInProcessAgentEnabled(): boolean {
  return (
    isPersonalMode() ||
    envFlag(process.env.PERSONAL_IN_PROCESS_AGENT) ||
    envFlag(process.env.NEXT_PUBLIC_PERSONAL_IN_PROCESS_AGENT)
  );
}

export function isOpenCodeZenEnabled(): boolean {
  return (
    envFlag(process.env.OPENCODE_ZEN_ENABLED) ||
    Boolean(process.env.OPENCODE_ZEN_API_KEY?.trim())
  );
}

export function getPersonalJwtAudience(): string {
  return process.env.PERSONAL_JWT_AUDIENCE?.trim() || PERSONAL_JWT_AUDIENCE;
}

export function getPersonalJwtIssuer(): string {
  const configured = process.env.PERSONAL_JWT_ISSUER?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL?.trim();
  if (baseUrl) return baseUrl.replace(/\/+$/, "");
  return "http://localhost:3000";
}

export function getPersonalUserEmail(): string {
  return process.env.PERSONAL_USER_EMAIL?.trim() || "you@localhost";
}

export function getPersonalUserName(): { firstName: string; lastName: string } {
  const firstName = process.env.PERSONAL_USER_FIRST_NAME?.trim() || "Personal";
  const lastName = process.env.PERSONAL_USER_LAST_NAME?.trim() || "User";
  return { firstName, lastName };
}
