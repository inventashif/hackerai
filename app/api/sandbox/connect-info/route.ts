import { NextResponse, type NextRequest } from "next/server";
import { getUserID } from "@/lib/auth/get-user-id";
import { getPublicTunnelUrls } from "@/lib/sandbox/public-tunnels";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Connection endpoints for the Settings → Remote Control tab.
 *
 * Same-machine ("local") sandboxes always use localhost — permanent, no
 * tunnel dependency. Remote sandboxes (another machine) cannot reach
 * localhost, so they need the public cloudflared callback URLs, which are
 * resolved live here because quick-tunnel hostnames rotate on restart.
 */
export async function GET(request: NextRequest) {
  try {
    await getUserID(request);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tunnels = getPublicTunnelUrls();

  return NextResponse.json({
    // Permanent: this machine only.
    localConvexUrl: "http://127.0.0.1:3210",
    localCentrifugoWsUrl: tunnels.localCentrifugoWsUrl,
    // Rotating: for remote machines. Empty strings while tunnels are down.
    publicConvexUrl: tunnels.publicConvexUrl,
    publicCentrifugoWsUrl: tunnels.publicCentrifugoWsUrl,
    tunnelsReady:
      tunnels.publicConvexUrl !== "" &&
      tunnels.publicCentrifugoWsUrl !== "",
  });
}
