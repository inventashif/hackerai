import { signOut } from "@workos-inc/authkit-nextjs";
import { isPersonalMode } from "@/lib/auth/personal-mode";
import { NextRequest, NextResponse } from "next/server";

export const GET = async () => {
  if (isPersonalMode()) {
    return new NextResponse(
      '<!doctype html><html><head><title>Sign out</title></head><body><form method="post" action="/logout"><button type="submit">Confirm sign out</button></form></body></html>',
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  return signOut();
};

export const POST = async (request: NextRequest) => {
  const { POST } = await import("../api/auth/logout/route");
  const result = await POST(request);
  if (!result.ok) return result;
  const response = NextResponse.redirect(new URL("/login", request.url), 303);
  for (const cookie of result.headers.getSetCookie())
    response.headers.append("Set-Cookie", cookie);
  return response;
};
