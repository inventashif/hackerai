import { NextRequest, NextResponse } from "next/server";
import { PERSONAL_COOKIE_NAME } from "./personal-mode";
import {
  signPersonalAccessToken,
  verifyPersonalSessionToken,
} from "./personal-jwt";
import { createPersonalAuth, type PersonalAuth } from "./personal-user";

type AuthkitOptions = {
  redirectUri?: string;
  eagerAuth?: boolean;
  onSessionRefreshError?: (args: { error: unknown }) => void;
};

async function resolveTokenFromRequest(
  request?: NextRequest,
): Promise<string | null> {
  if (request) {
    const cookieToken = request.cookies.get(PERSONAL_COOKIE_NAME)?.value;
    if (cookieToken) return cookieToken;
    return null;
  }

  const { cookies } = await import("next/headers");

  const cookieStore = await cookies();
  return cookieStore.get(PERSONAL_COOKIE_NAME)?.value ?? null;
}

async function authFromToken(token: string): Promise<PersonalAuth> {
  await verifyPersonalSessionToken(token);
  return createPersonalAuth(await signPersonalAccessToken());
}

export async function withAuth(): Promise<PersonalAuth | { user: null }> {
  try {
    const token = await resolveTokenFromRequest();
    if (!token) return { user: null };
    return await authFromToken(token);
  } catch {
    return { user: null };
  }
}

export async function authkit(
  request: NextRequest,
  _options?: AuthkitOptions,
): Promise<{
  session: PersonalAuth | { user: null };
  headers: Headers;
  authorizationUrl: undefined;
}> {
  const token = await resolveTokenFromRequest(request);
  let session: PersonalAuth | { user: null } = { user: null };
  if (token) {
    try {
      session = await authFromToken(token);
    } catch {
      /* Fail closed. Never mint a visitor session. */
    }
  }
  const headersOut = new Headers();
  headersOut.set("x-workos-middleware", "true");

  return {
    session,
    headers: headersOut,
    authorizationUrl: undefined,
  };
}

export async function signOut() {
  const response = NextResponse.redirect(
    new URL(
      "/logout",
      process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000",
    ),
  );
  return response;
}

export async function getSignInUrl(): Promise<string> {
  return "/inventashif-login";
}

export async function getSignUpUrl(): Promise<string> {
  throw new Error("Signup is disabled");
}

export function handleAuth() {
  return async (request: NextRequest) => {
    return NextResponse.redirect(new URL("/", request.url));
  };
}

export type { PersonalAuth as UserInfo };
export type NoUserInfo = { user: null };
