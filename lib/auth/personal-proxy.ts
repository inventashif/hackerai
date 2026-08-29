import { NextRequest, NextResponse } from "next/server";
import { isPersonalMode } from "@/lib/auth/personal-mode";
import { authkit } from "@/lib/auth/personal-authkit";
import { PERSONAL_ACCESS_TOKEN_HEADER } from "@/lib/auth/personal-mode";

export async function handlePersonalProxy(
  request: NextRequest,
): Promise<NextResponse> {
  if (!isPersonalMode()) {
    throw new Error("handlePersonalProxy called outside personal mode");
  }

  const { session, headers: authHeaders } = await authkit(request);
  const requestHeaders = new Headers(request.headers);
  authHeaders.forEach((value, key) => {
    if (key.startsWith("x-")) {
      requestHeaders.set(key, value);
    }
  });

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  const setCookie = authHeaders.get("set-cookie");
  if (setCookie) {
    response.headers.append("set-cookie", setCookie);
  }
  response.headers.set("x-workos-middleware", "true");
  response.headers.delete(PERSONAL_ACCESS_TOKEN_HEADER);

  if (!session.user) {
    return response;
  }

  return response;
}
