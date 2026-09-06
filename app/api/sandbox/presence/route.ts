import { NextRequest, NextResponse } from "next/server";
import { Centrifuge, type Subscription } from "centrifuge";
import { getUserID } from "@/lib/auth/get-user-id";
import { generateCentrifugoToken } from "@/lib/centrifugo/jwt";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { phLogger } from "@/lib/posthog/server";
import { sandboxConnectionChannel } from "@/lib/centrifugo/types";
import {
  LOCAL_SANDBOX_PRESENCE_GRACE_MS,
  presenceHasConnectionId,
} from "@/lib/centrifugo/presence";

// Budget for one channel's subscribe+presence round trip, measured from AFTER
// the socket is connected.
const PRESENCE_PROBE_TIMEOUT_MS = 5_000;
// Separate budget for establishing the probe connection itself.
const PRESENCE_CONNECT_TIMEOUT_MS = 5_000;

export async function GET(request: NextRequest) {
  let userId: string;
  try {
    userId = await getUserID(request);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const wsUrl = process.env.CENTRIFUGO_WS_URL;
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;

  if (!wsUrl) {
    return NextResponse.json(
      { error: "Centrifugo not configured" },
      { status: 500 },
    );
  }

  // Fetch connection metadata from Convex before probing per-connection
  // Centrifugo channels. The previous shared per-user presence channel exposed
  // every connection id to any same-user subscriber.
  if (!convexUrl || !serviceKey) {
    return NextResponse.json({
      connections: [],
      onlineCount: 0,
    });
  }

  const convex = new ConvexHttpClient(convexUrl);
  const connections = await convex.query(
    api.localSandbox.listConnectionsForBackend,
    { serviceKey, userId },
  );

  const onlineConnectionIds = new Set<string>();
  // Connections whose own probe failed while the overall probe succeeded. Not
  // known to be offline, so they must never be swept/disconnected.
  const indeterminateConnectionIds = new Set<string>();
  let presenceReliable = false;

  let client: Centrifuge | null = null;
  const subscriptions: Subscription[] = [];
  const probeStart = Date.now();
  try {
    const token = await generateCentrifugoToken(userId, 30);
    client = new Centrifuge(wsUrl, { token });

    // Establish the transport BEFORE creating subscriptions, so the TCP+WS+auth
    // handshake is not billed against each channel's presence deadline. When the
    // relay was unreachable this made every probe fail at exactly the timeout.
    const connectingClient = client;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        detach();
        reject(new Error("Centrifugo presence connect timeout"));
      }, PRESENCE_CONNECT_TIMEOUT_MS);

      const detach = () => {
        clearTimeout(timer);
        connectingClient.removeListener("connected", onConnected);
        connectingClient.removeListener("error", onError);
      };
      const onConnected = () => {
        detach();
        resolve();
      };
      const onError = (ctx: { error?: { message?: string } }) => {
        detach();
        reject(
          new Error(ctx.error?.message ?? "Centrifugo presence connect error"),
        );
      };

      connectingClient.on("connected", onConnected);
      connectingClient.on("error", onError);
      connectingClient.connect();
    });

    const probes = connections.map(
      (connection) =>
        new Promise<void>((resolve, reject) => {
          const sub = client!.newSubscription(
            sandboxConnectionChannel(userId, connection.connectionId),
          );
          subscriptions.push(sub);

          const timeout = setTimeout(() => {
            cleanup();
            reject(
              new Error(
                `Centrifugo presence timeout for connection ${connection.connectionId}`,
              ),
            );
          }, PRESENCE_PROBE_TIMEOUT_MS);

          const cleanup = () => {
            clearTimeout(timeout);
            sub.removeAllListeners();
          };

          sub.on("subscribed", async () => {
            try {
              const result = await sub.presence();
              if (presenceHasConnectionId(result, connection.connectionId)) {
                onlineConnectionIds.add(connection.connectionId);
              }
              cleanup();
              resolve();
            } catch (e) {
              cleanup();
              reject(e);
            }
          });

          sub.on("error", (ctx) => {
            cleanup();
            reject(
              new Error(ctx.error?.message ?? "Centrifugo subscription error"),
            );
          });

          sub.subscribe();
        }),
    );

    // Independently settled: one unresponsive channel must not invalidate the
    // whole probe. Previously a single failure (common with several tabs open)
    // rejected Promise.all, left presenceReliable false, and skipped the sweep
    // entirely — or, once reliable, risked sweeping live connections.
    const settled = await Promise.allSettled(probes);
    settled.forEach((outcome, index) => {
      if (outcome.status === "rejected") {
        indeterminateConnectionIds.add(connections[index].connectionId);
      }
    });
    presenceReliable = true;

    if (indeterminateConnectionIds.size > 0) {
      phLogger.warn("sandbox_presence_probe_partial", {
        event: "sandbox.presence_probe_partial",
        userId,
        connection_count: connections.length,
        online_connection_count: onlineConnectionIds.size,
        indeterminate_connection_count: indeterminateConnectionIds.size,
        duration_ms: Date.now() - probeStart,
      });
    }
  } catch (err) {
    phLogger.warn("sandbox_presence_probe_unavailable", {
      event: "sandbox.presence_probe_unavailable",
      userId,
      connection_count: connections.length,
      online_connection_count: onlineConnectionIds.size,
      duration_ms: Date.now() - probeStart,
      error: err,
    });
  } finally {
    for (const sub of subscriptions) {
      sub.removeAllListeners();
      sub.unsubscribe();
    }
    if (client) {
      client.disconnect();
    }
  }

  // Mark each connection with live presence status
  const enriched = connections.map((conn) => ({
    ...conn,
    online: onlineConnectionIds.has(conn.connectionId),
  }));

  // Disconnect stale connections in Convex (connected in DB but not in presence).
  // Skip rows whose lastSeen is within the grace window — covers the race where a
  // client has just inserted its row but hasn't finished subscribing to Centrifugo,
  // and brief WebSocket reconnects on healthy clients (last_heartbeat is bumped on
  // a lightweight client heartbeat).
  if (presenceReliable) {
    const now = Date.now();
    const stale = connections.filter(
      (conn) =>
        !onlineConnectionIds.has(conn.connectionId) &&
        // A failed probe proves nothing — never disconnect on it.
        !indeterminateConnectionIds.has(conn.connectionId) &&
        now - conn.lastSeen > LOCAL_SANDBOX_PRESENCE_GRACE_MS,
    );
    if (stale.length > 0) {
      const results = await Promise.allSettled(
        stale.map((conn) =>
          convex.mutation(api.localSandbox.disconnectByBackend, {
            serviceKey,
            connectionId: conn.connectionId,
          }),
        ),
      );
      results.forEach((result, i) => {
        const conn = stale[i];
        if (result.status === "rejected") {
          phLogger.error("sandbox_presence_sweep_disconnect_failed", {
            userId,
            connectionId: conn.connectionId,
            isDesktop: conn.isDesktop,
            msSinceLastSeen: now - conn.lastSeen,
            error: result.reason,
          });
        } else {
          phLogger.warn("sandbox_presence_sweep_disconnect", {
            userId,
            connectionId: conn.connectionId,
            isDesktop: conn.isDesktop,
            msSinceLastSeen: now - conn.lastSeen,
          });
        }
      });
    }
  }

  return NextResponse.json({
    connections: enriched,
    onlineCount: onlineConnectionIds.size,
  });
}
