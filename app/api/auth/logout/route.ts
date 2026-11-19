import { NextRequest, NextResponse } from "next/server";
import { PERSONAL_COOKIE_NAME, isPersonalMode } from "@/lib/auth/personal-mode";
import {
  clearPersonalSessionCookie,
  verifyPersonalSessionToken,
} from "@/lib/auth/personal-jwt";
import { loginStore, sameOrigin } from "@/lib/auth/login-security";

export async function POST(request: NextRequest) {
  if (!isPersonalMode()) return new NextResponse(null, { status: 404 });
  if (!sameOrigin(request))
    return NextResponse.json(
      { error: "Invalid request origin" },
      { status: 403 },
    );
  const token = request.cookies.get(PERSONAL_COOKIE_NAME)?.value;
  try {
    if (token) {
      const payload = await verifyPersonalSessionToken(token);
      await loginStore("revokeSession", { sessionId: payload.jti! });
    }
  } catch {
    // Fail closed on the next request; do not create a replacement session.
    return NextResponse.json(
      { error: "Unable to revoke session. Please retry." },
      { status: 503 },
    );
  }
  const response = NextResponse.json(
    { success: true },
    { headers: { "Cache-Control": "no-store" } },
  );
  response.headers.append("Set-Cookie", clearPersonalSessionCookie());
  response.cookies.delete("personal-session");
  return response;
}
