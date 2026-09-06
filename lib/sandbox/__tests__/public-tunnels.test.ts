import { describe, it, expect } from "@jest/globals";
import { resolvePublicTunnelUrls } from "../public-tunnels";

describe("resolvePublicTunnelUrls", () => {
  it("prefers live tunnel state over the process env snapshot", () => {
    const result = resolvePublicTunnelUrls(
      {
        convex: { hostname: "live-convex.trycloudflare.com" },
        centrifugo: { hostname: "live-cent.trycloudflare.com" },
      },
      {
        PUBLIC_CONVEX_URL: "https://stale-convex.trycloudflare.com",
        CENTRIFUGO_PUBLIC_WS_URL:
          "wss://stale-cent.trycloudflare.com/connection/websocket",
      },
    );

    expect(result.publicConvexUrl).toBe(
      "https://live-convex.trycloudflare.com",
    );
    expect(result.publicCentrifugoWsUrl).toBe(
      "wss://live-cent.trycloudflare.com/connection/websocket",
    );
    expect(result.tunnelsReady).toBe(true);
  });

  it("falls back to env when the state file has no entries", () => {
    const result = resolvePublicTunnelUrls(
      {},
      {
        PUBLIC_CONVEX_URL: "https://env-convex.trycloudflare.com",
        CENTRIFUGO_PUBLIC_WS_URL:
          "wss://env-cent.trycloudflare.com/connection/websocket",
      },
    );

    expect(result.publicConvexUrl).toBe(
      "https://env-convex.trycloudflare.com",
    );
    expect(result.publicCentrifugoWsUrl).toBe(
      "wss://env-cent.trycloudflare.com/connection/websocket",
    );
    expect(result.tunnelsReady).toBe(true);
  });

  it("reports not-ready with empty strings when tunnels are down", () => {
    const result = resolvePublicTunnelUrls({}, {});

    expect(result.publicConvexUrl).toBe("");
    expect(result.publicCentrifugoWsUrl).toBe("");
    expect(result.tunnelsReady).toBe(false);
  });

  it("rejects loopback values so localhost never leaks into remote commands", () => {
    const result = resolvePublicTunnelUrls(
      {},
      {
        PUBLIC_CONVEX_URL: "http://127.0.0.1:3210",
        CENTRIFUGO_PUBLIC_WS_URL: "ws://localhost:8001/connection/websocket",
      },
    );

    expect(result.publicConvexUrl).toBe("");
    expect(result.publicCentrifugoWsUrl).toBe("");
    expect(result.tunnelsReady).toBe(false);
  });

  it("accepts LAN addresses as remote callbacks (reachable, just not loopback)", () => {
    const result = resolvePublicTunnelUrls(
      {},
      {
        PUBLIC_CONVEX_URL: "http://192.168.1.5:3210",
        CENTRIFUGO_PUBLIC_WS_URL: "ws://192.168.1.5:8001/connection/websocket",
      },
    );

    expect(result.publicConvexUrl).toBe("http://192.168.1.5:3210");
    expect(result.publicCentrifugoWsUrl).toBe(
      "ws://192.168.1.5:8001/connection/websocket",
    );
    expect(result.tunnelsReady).toBe(true);
  });

  it("keeps the localhost relay as the permanent local URL", () => {
    const result = resolvePublicTunnelUrls(
      {},
      { CENTRIFUGO_WS_URL: "ws://localhost:8001/connection/websocket" },
    );

    expect(result.localCentrifugoWsUrl).toBe(
      "ws://localhost:8001/connection/websocket",
    );
  });
});
