import { getSignInUrl } from "@workos-inc/authkit-nextjs";
import { redirectToAuthorizationUrl } from "@/lib/auth/auth-redirect-intents";
import { isPersonalMode } from "@/lib/auth/personal-mode";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  if (isPersonalMode()) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  const url = new URL(request.url);
  const authorizationUrl = await getSignInUrl();
  return redirectToAuthorizationUrl(authorizationUrl, url);
}
