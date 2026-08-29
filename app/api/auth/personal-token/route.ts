import { NextResponse } from "next/server";
import { isPersonalMode } from "@/lib/auth/personal-mode";
import { withAuth } from "@/lib/auth/personal-authkit";

export async function GET() {
  if (!isPersonalMode()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const auth = await withAuth();
  if (!auth.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    accessToken: "accessToken" in auth ? auth.accessToken : undefined,
  });
}
