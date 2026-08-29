import { NextRequest, NextResponse } from "next/server";
import {
  PERSONAL_ACCESS_TOKEN_HEADER,
  PERSONAL_COOKIE_NAME,
} from "./personal-mode";
import {
  clearPersonalSessionCookie,
  serializePersonalSessionCookie,
  signPersonalAccessToken,
  verifyPersonalAccessToken,
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
    const headerToken = request.headers.get(PERSONAL_ACCESS_TOKEN_HEADER);
    if (headerToken) return headerToken;
    const cookieToken = request.cookies.get(PERSONAL_COOKIE_NAME)?.value;
    if (cookieToken) return cookieToken;
    return null;
  }

  const { cookies, headers } = await import("next/headers");
  const requestHeaders = await headers();
  const headerToken = requestHeaders.get(PERSONAL_ACCESS_TOKEN_HEADER);
  if (headerToken) return headerToken;

  const cookieStore = await cookies();
  return cookieStore.get(PERSONAL_COOKIE_NAME)?.value ?? null;
}

async function authFromToken(token: string): Promise<PersonalAuth> {
  await verifyPersonalAccessToken(token);
  return createPersonalAuth(token);
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
  session: PersonalAuth;
  headers: Headers;
  authorizationUrl: undefined;
}> {
  const existing = await resolveTokenFromRequest(request);
  let token = existing;
  let issuedFresh = false;

  if (token) {
    try {
      await verifyPersonalAccessToken(token);
    } catch {
      token = null;
    }
  }

  if (!token) {
    token = await signPersonalAccessToken();
    issuedFresh = true;
  }

  const session = await authFromToken(token);
  const headersOut = new Headers();
  headersOut.set("x-workos-middleware", "true");
  headersOut.set(PERSONAL_ACCESS_TOKEN_HEADER, token);
  if (issuedFresh) {
    headersOut.append("set-cookie", serializePersonalSessionCookie(token));
  }

  return {
    session,
    headers: headersOut,
    authorizationUrl: undefined,
  };
}

export async function signOut() {
  const response = NextResponse.redirect(
    new URL("/", process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"),
  );
  response.headers.append("set-cookie", clearPersonalSessionCookie());
  return response;
}

export async function getSignInUrl(): Promise<string> {
  return "/";
}

export async function getSignUpUrl(): Promise<string> {
  return "/";
}

export function handleAuth() {
  return async (request: NextRequest) => {
    return NextResponse.redirect(new URL("/", request.url));
  };
}

export type { PersonalAuth as UserInfo };
export type NoUserInfo = { user: null };