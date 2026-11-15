type Listener = (ctx: any) => void;

const makeFakeSubscription = () => {
  const listeners = new Map<string, Listener[]>();
  return {
    published: [] as unknown[],
    on: jest.fn((event: string, cb: Listener) => {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
    }),
    publish: jest.fn(async (payload: unknown) => {
      (this as any).published?.push?.(payload);
    }),
    subscribe: jest.fn(),
    unsubscribe: jest.fn(),
    removeAllListeners: jest.fn(),
    __emit: (event: string, ctx: any) => {
      for (const cb of listeners.get(event) ?? []) cb(ctx);
    },
  };
};

// The publish mock needs access to the subscription's `published` array;
// bind it after creation in the Centrifuge mock below.
const fakeSubscriptions: ReturnType<typeof makeFakeSubscription>[] = [];
let fakeClient: any;

jest.mock("centrifuge", () => ({
  Centrifuge: jest.fn().mockImplementation(() => {
    const subscription = makeFakeSubscription();
    subscription.publish = jest.fn(async (payload: unknown) => {
      subscription.published.push(payload);
    });
    fakeSubscriptions.push(subscription);
    fakeClient = {
      subscription,
      newSubscription: jest.fn(() => subscription),
      connect: jest.fn(),
      disconnect: jest.fn(),
      on: jest.fn(),
    };
    return fakeClient;
  }),
}));

import {
  attachToCentrifugoPtyHandle,
  createCentrifugoPtyHandle,
} from "../utils/centrifugo-pty-adapter";
import type { CentrifugoSandbox } from "../utils/centrifugo-sandbox";

const makeSandbox = (): CentrifugoSandbox =>
  ({
    getUserId: () => "user-1",
    getConnectionId: () => "conn-1",
    getWsUrl: () => "wss://relay.example/connection/websocket",
    issueToken: jest.fn(async () => "tok-1"),
  }) as unknown as CentrifugoSandbox;

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("centrifugo-pty-adapter attach", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fakeSubscriptions.length = 0;
  });

  it("create publishes pty_create and resolves on pty_ready with a sessionKey", async () => {
    const promise = createCentrifugoPtyHandle(makeSandbox(), {
      command: "sleep 300",
      cols: 120,
      rows: 30,
    });
    await flush();
    const sub = fakeSubscriptions[0];
    sub.__emit("subscribed", {});
    await flush();

    expect(sub.published).toHaveLength(1);
    const create = sub.published[0] as Record<string, unknown>;
    expect(create.type).toBe("pty_create");
    expect(create.command).toBe("sleep 300");
    expect(typeof create.sessionId).toBe("string");

    sub.__emit("publication", {
      data: { type: "pty_ready", sessionId: create.sessionId, pid: 777 },
    });
    const handle = await promise;
    expect(handle.pid).toBe(777);
    expect(handle.sessionKey).toBe(create.sessionId);
  });

  it("attach publishes pty_status, replays the tail, and streams live data", async () => {
    const promise = attachToCentrifugoPtyHandle(makeSandbox(), {
      sessionId: "handle-uuid-1",
      cols: 120,
      rows: 30,
    });
    await flush();
    const sub = fakeSubscriptions[0];
    sub.__emit("subscribed", {});
    await flush();

    expect(sub.published).toHaveLength(1);
    const status = sub.published[0] as Record<string, unknown>;
    expect(status).toMatchObject({
      type: "pty_status",
      sessionId: "handle-uuid-1",
      targetConnectionId: "conn-1",
    });
    expect(typeof status.requestId).toBe("string");

    // Live data racing the status answer queues behind the tail.
    sub.__emit("publication", {
      data: { type: "pty_data", sessionId: "handle-uuid-1", data: "live1" },
    });
    sub.__emit("publication", {
      data: {
        type: "pty_status_result",
        sessionId: "handle-uuid-1",
        requestId: status.requestId,
        status: "running",
        pid: 555,
        outputTail: "tail-bytes",
      },
    });
    const handle = await promise;
    expect(handle.pid).toBe(555);
    expect(handle.sessionKey).toBe("handle-uuid-1");

    const seen: string[] = [];
    handle.onData((bytes) => seen.push(new TextDecoder().decode(bytes)));
    expect(seen).toEqual(["tail-bytes", "live1"]);

    // Post-attach live data fans out directly.
    sub.__emit("publication", {
      data: { type: "pty_data", sessionId: "handle-uuid-1", data: "live2" },
    });
    expect(seen).toEqual(["tail-bytes", "live1", "live2"]);
  });

  it("attach to an exited session resolves exited with the exit code", async () => {
    const promise = attachToCentrifugoPtyHandle(makeSandbox(), {
      sessionId: "handle-uuid-1",
      cols: 120,
      rows: 30,
    });
    await flush();
    const sub = fakeSubscriptions[0];
    sub.__emit("subscribed", {});
    await flush();
    const status = sub.published[0] as Record<string, unknown>;

    sub.__emit("publication", {
      data: {
        type: "pty_status_result",
        sessionId: "handle-uuid-1",
        requestId: status.requestId,
        status: "exited",
        pid: 555,
        exitCode: 3,
        outputTail: "final",
      },
    });
    const handle = await promise;
    await expect(handle.exited).resolves.toEqual({ exitCode: 3 });
    const seen: string[] = [];
    handle.onData((bytes) => seen.push(new TextDecoder().decode(bytes)));
    expect(seen).toEqual(["final"]);
  });

  it("attach rejects when the agent reports the session unknown", async () => {
    const promise = attachToCentrifugoPtyHandle(makeSandbox(), {
      sessionId: "handle-uuid-1",
      cols: 120,
      rows: 30,
    });
    await flush();
    const sub = fakeSubscriptions[0];
    sub.__emit("subscribed", {});
    await flush();
    const status = sub.published[0] as Record<string, unknown>;

    sub.__emit("publication", {
      data: {
        type: "pty_status_result",
        sessionId: "handle-uuid-1",
        requestId: status.requestId,
        status: "unknown",
      },
    });
    await expect(promise).rejects.toThrow(/unknown to the sandbox runner/);
  });

  it("attach rejects on status timeout after retrying the query", async () => {
    jest.useFakeTimers();
    try {
      const promise = attachToCentrifugoPtyHandle(makeSandbox(), {
        sessionId: "handle-uuid-1",
        cols: 120,
        rows: 30,
      });
      await jest.advanceTimersByTimeAsync(0);
      const sub = fakeSubscriptions[0];
      sub.__emit("subscribed", {});
      const assertion = expect(promise).rejects.toThrow(/pty_status timed out/);
      await jest.advanceTimersByTimeAsync(20_000);
      await assertion;
      // Initial publish + 2 retries before the timeout.
      expect(sub.published).toHaveLength(3);
      for (const p of sub.published) {
        expect((p as Record<string, unknown>).type).toBe("pty_status");
      }
    } finally {
      jest.useRealTimers();
    }
  });
});
