import { NextResponse } from "next/server";
import { isPersonalMode } from "@/lib/auth/personal-mode";
import { getPersonalJwks } from "@/lib/auth/personal-jwt";

export async function GET() {
  if (!isPersonalMode()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(await getPersonalJwks(), {
    headers: {
      "Cache-Control": "public, max-age=3600",
    },
  });
}
