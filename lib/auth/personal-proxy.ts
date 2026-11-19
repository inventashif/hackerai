import { NextRequest, NextResponse } from "next/server";
import { authkit } from "./personal-authkit";
import { PERSONAL_ACCESS_TOKEN_HEADER } from "./personal-mode";
import { sameOrigin } from "./login-security";

export async function handlePersonalProxy(
  request: NextRequest,
): Promise<NextResponse> {
  const pathname = request.nextUrl.pathname;
  const headers = new Headers(request.headers);
  // Client-supplied middleware/auth headers cannot establish identity.
  for (const key of [...headers.keys()]) {
    if (
      key.startsWith("x-middleware-") ||
      key.startsWith("x-workos-") ||
      key === PERSONAL_ACCESS_TOKEN_HEADER
    )
      headers.delete(key);
  }
  const next = () => NextResponse.next({ request: { headers } });
  let response: NextResponse;
  const read = request.method === "GET" || request.method === "HEAD";
  if (
    pathname === "/signup" ||
    pathname.startsWith("/signup/") ||
    pathname === "/register"
  ) {
    response = new NextResponse("Not found", { status: 404 });
  } else if (
    (pathname.startsWith("/_next/static/") ||
      pathname === "/favicon.ico" ||
      pathname === "/.well-known/jwks.json" ||
      pathname === "/api/auth/jwks" ||
      pathname === "/login" ||
      pathname === "/inventashif-login") &&
    read
  ) {
    response = next();
  } else if (pathname === "/api/auth/login" && request.method === "POST") {
    response = next();
  } else {
    const { session } = await authkit(request);
    if (!session.user) {
      response =
        pathname.startsWith("/api/") || pathname.startsWith("/trpc/") || !read
          ? NextResponse.json(
              { error: "Authentication required" },
              { status: 401 },
            )
          : NextResponse.redirect(new URL("/login", request.url));
    } else if (!read && request.method !== "OPTIONS" && !sameOrigin(request)) {
      response = NextResponse.json(
        { error: "Invalid request origin" },
        { status: 403 },
      );
    } else response = next();
  }
  // Login tokens, pages, and private API responses must not be shared by a cache.
  if (!pathname.startsWith("/_next/static/"))
    response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set(
    "Content-Security-Policy",
    "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  );
  if (process.env.NODE_ENV === "production")
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  return response;
}
