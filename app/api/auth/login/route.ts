import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { isPersonalMode } from "@/lib/auth/personal-mode";
import {
  clientKey,
  loginStore,
  sameOrigin,
  SESSION_SECONDS,
  verifyLoginCredentials,
} from "@/lib/auth/login-security";
import {
  serializePersonalSessionCookie,
  signPersonalSessionToken,
} from "@/lib/auth/personal-jwt";

export async function POST(request: NextRequest) {
  const headers = { "Cache-Control": "no-store" };
  if (!isPersonalMode())
    return NextResponse.json({ error: "Not found" }, { status: 404, headers });
  if (!sameOrigin(request))
    return NextResponse.json(
      { error: "Invalid request origin" },
      { status: 403, headers },
    );
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return NextResponse.json(
      { error: "JSON required" },
      { status: 415, headers },
    );
  if (Number(request.headers.get("content-length")) > 4096)
    return NextResponse.json(
      { error: "Request too large" },
      { status: 413, headers },
    );
  try {
    const limit = await loginStore("consumeAttempt", {
      clientKey: clientKey(request),
    });
    if (!limit.allowed)
      return NextResponse.json(
        { error: "Too many login attempts. Try again later." },
        {
          status: 429,
          headers: { ...headers, "Retry-After": String(limit.retryAfter) },
        },
      );
    const body = await request.text();
    if (Buffer.byteLength(body) > 4096)
      return NextResponse.json(
        { error: "Request too large" },
        { status: 413, headers },
      );
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return NextResponse.json(
        { error: "Invalid request" },
        { status: 400, headers },
      );
    }
    if (!data || !(await verifyLoginCredentials(data.email, data.password)))
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401, headers },
      );
    const sessionId = randomBytes(32).toString("hex");
    const token = await signPersonalSessionToken(sessionId);
    await loginStore("createSession", {
      sessionId,
      expiresAt: Date.now() + SESSION_SECONDS * 1000 - 1000,
    });
    const response = NextResponse.json({ success: true }, { headers });
    response.headers.append(
      "Set-Cookie",
      serializePersonalSessionCookie(token),
    );
    return response;
  } catch {
    // No credentials, tokens, submitted bodies, or configuration values in logs.
    return NextResponse.json(
      { error: "Login temporarily unavailable" },
      { status: 503, headers },
    );
  }
}
