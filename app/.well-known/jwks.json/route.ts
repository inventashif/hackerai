import { NextResponse } from "next/server";
import { getPersonalJwks } from "@/lib/auth/personal-jwt";

// Use the same decoder and key ID as the signer. This endpoint contains public
// verification material only; base64/PEM env keys and file keys follow one path.
export async function GET() {
  try {
    return NextResponse.json(await getPersonalJwks(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return new NextResponse("JWKS not available", { status: 503 });
  }
}
