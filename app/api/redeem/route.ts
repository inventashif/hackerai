import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { getUserID } from "@/lib/auth/get-user-id";

function convexClient() {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL not set");
  return new ConvexHttpClient(url);
}

export async function POST(req: NextRequest) {
  let userId: string;
  try {
    userId = await getUserID(req);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const code = typeof body.code === "string" ? body.code : "";
  if (!code.trim()) return NextResponse.json({ error: "Missing code" }, { status: 400 });

  const client = convexClient();
  try {
    const result = await client.mutation(api.redeemCodes.redeemCode as any, { code });
    // Optionally also call backend grant application if service key available
    const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
    if (serviceKey) {
      try {
        await client.mutation(api.redeemCodes.applyRedeemGrant as any, {
          serviceKey,
          userId,
          code: code.trim().toUpperCase(),
          tier: result.tier,
          duration_type: result.duration_type,
          duration_value: result.duration_value,
        });
      } catch (e) {
        console.warn("applyRedeemGrant failed", e);
      }
    }
    return NextResponse.json({ success: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Map ConvexError to HTTP
    if (msg.includes("ALREADY_REDEEMED")) return NextResponse.json({ error: "Code already redeemed" }, { status: 409 });
    if (msg.includes("EXPIRED")) return NextResponse.json({ error: "Code expired" }, { status: 410 });
    if (msg.includes("NOT_FOUND") || msg.includes("Invalid code")) return NextResponse.json({ error: "Invalid code" }, { status: 404 });
    if (msg.includes("FORBIDDEN")) return NextResponse.json({ error: "Not allowed" }, { status: 403 });
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function GET(req: NextRequest) {
  // Admin list (requires auth, returns codes created by caller)
  try {
    await getUserID(req);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ error: "Use POST to redeem. Admin generation is via Convex mutation generateCodes." }, { status: 400 });
}
