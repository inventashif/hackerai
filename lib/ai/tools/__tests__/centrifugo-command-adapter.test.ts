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
    publish: jest.fn(async (_payload: unknown) => undefined),
    subscribe: jest.fn(),
    unsubscribe: jest.fn(),
    removeAllListeners: jest.fn(),
    __emit: (event: string, ctx: any) => {
      for (const cb of listeners.get(event) ?? []) cb(ctx);
    },
  };
};

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

import { attachToCentrifugoCommandHandle } from "../utils/centrifugo-command-adapter";
import type { CentrifugoSandbox } from "../utils/centrifugo-sandbox";

const makeSandbox = (): CentrifugoSandbox =>
  ({
    getUserId: () => "user-1",
    getConnectionId: () => "conn-1",
    getWsUrl: () => "wss://relay.example/connection/websocket",
    issueToken: jest.fn(async () => "tok-1"),
  }) as unknown as CentrifugoSandbox;

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("centrifugo-command-adapter attach", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fakeSubscriptions.length = 0;
  });

  it("attach publishes command_status, replays the tail, and streams live chunks", async () => {
    const promise = attachToCentrifugoCommandHandle(makeSandbox(), {
      commandId: "cmd-uuid-1",
    });
    await flush();
    const sub = fakeSubscriptions[0];
    sub.__emit("subscribed", {});
    await flush();

    expect(sub.published).toHaveLength(1);
    const status = sub.published[0] as Record<string, unknown>;
    expect(status).toMatchObject({
      type: "command_status",
      commandId: "cmd-uuid-1",
      targetConnectionId: "conn-1",
    });
    expect(typeof status.requestId).toBe("string");

    // Live chunks racing the status answer queue behind the tail.
    sub.__emit("publication", {
      data: { type: "stdout", commandId: "cmd-uuid-1", data: "live1" },
    });
    sub.__emit("publication", {
      data: {
        type: "command_status_result",
        commandId: "cmd-uuid-1",
        requestId: status.requestId,
        status: "running",
        pid: 555,
        outputTail: "tail-bytes",
      },
    });
    const handle = await promise;
    expect(handle.pid).toBe(555);
    expect(handle.sessionKey).toBe("cmd-uuid-1");

    const seen: string[] = [];
    handle.onData((bytes) => seen.push(new TextDecoder().decode(bytes)));
    expect(seen).toEqual(["tail-bytes", "live1"]);

    // Post-attach live chunks (stdout and stderr) fan out directly.
    sub.__emit("publication", {
      data: { type: "stderr", commandId: "cmd-uuid-1", data: "live2" },
    });
    expect(seen).toEqual(["tail-bytes", "live1", "live2"]);

    // Chunks for other commands are ignored.
    sub.__emit("publication", {
      data: { type: "stdout", commandId: "cmd-other", data: "nope" },
    });
    expect(seen).toEqual(["tail-bytes", "live1", "live2"]);
  });

  it("attach to an exited command resolves exited with the exit code", async () => {
    const promise = attachToCentrifugoCommandHandle(makeSandbox(), {
      commandId: "cmd-uuid-1",
    });
    await flush();
    const sub = fakeSubscriptions[0];
    sub.__emit("subscribed", {});
    await flush();
    const status = sub.published[0] as Record<string, unknown>;

    sub.__emit("publication", {
      data: {
        type: "command_status_result",
        commandId: "cmd-uuid-1",
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

  it("attach rejects when the agent reports the command unknown", async () => {
    const promise = attachToCentrifugoCommandHandle(makeSandbox(), {
      commandId: "cmd-uuid-1",
    });
    await flush();
    const sub = fakeSubscriptions[0];
    sub.__emit("subscribed", {});
    await flush();
    const status = sub.published[0] as Record<string, unknown>;

    sub.__emit("publication", {
      data: {
        type: "command_status_result",
        commandId: "cmd-uuid-1",
        requestId: status.requestId,
        status: "unknown",
      },
    });
    await expect(promise).rejects.toThrow(/unknown to the sandbox runner/);
  });

  it("attach rejects on status timeout after retrying the query", async () => {
    jest.useFakeTimers();
    try {
      const promise = attachToCentrifugoCommandHandle(makeSandbox(), {
        commandId: "cmd-uuid-1",
      });
      await jest.advanceTimersByTimeAsync(0);
      const sub = fakeSubscriptions[0];
      sub.__emit("subscribed", {});
      const assertion = expect(promise).rejects.toThrow(
        /command_status timed out/,
      );
      await jest.advanceTimersByTimeAsync(20_000);
      await assertion;
      // Initial publish + 2 retries before the timeout.
      expect(sub.published).toHaveLength(3);
      for (const p of sub.published) {
        expect((p as Record<string, unknown>).type).toBe("command_status");
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it("a late status answer after the first retry still resolves", async () => {
    jest.useFakeTimers();
    try {
      const promise = attachToCentrifugoCommandHandle(makeSandbox(), {
        commandId: "cmd-uuid-1",
      });
      await jest.advanceTimersByTimeAsync(0);
      const sub = fakeSubscriptions[0];
      sub.__emit("subscribed", {});
      // First query lost (no answer); the retry fires at 5s.
      await jest.advanceTimersByTimeAsync(5_000);
      expect(sub.published).toHaveLength(2);
      const status = sub.published[1] as Record<string, unknown>;
      sub.__emit("publication", {
        data: {
          type: "command_status_result",
          commandId: "cmd-uuid-1",
          requestId: status.requestId,
          status: "running",
          pid: 777,
        },
      });
      const handle = await promise;
      expect(handle.pid).toBe(777);
    } finally {
      jest.useRealTimers();
    }
  });

  it("kill publishes command_cancel and resolves exited on exit", async () => {
    const promise = attachToCentrifugoCommandHandle(makeSandbox(), {
      commandId: "cmd-uuid-1",
    });
    await flush();
    const sub = fakeSubscriptions[0];
    sub.__emit("subscribed", {});
    await flush();
    const status = sub.published[0] as Record<string, unknown>;
    sub.__emit("publication", {
      data: {
        type: "command_status_result",
        commandId: "cmd-uuid-1",
        requestId: status.requestId,
        status: "running",
        pid: 555,
      },
    });
    const handle = await promise;

    const killPromise = handle.kill();
    sub.__emit("publication", {
      data: { type: "exit", commandId: "cmd-uuid-1", exitCode: 130 },
    });
    await killPromise;

    const cancel = sub.published.find(
      (p) => (p as Record<string, unknown>).type === "command_cancel",
    ) as Record<string, unknown>;
    expect(cancel).toMatchObject({
      commandId: "cmd-uuid-1",
      targetConnectionId: "conn-1",
    });
    await expect(handle.exited).resolves.toEqual({ exitCode: 130 });
  });

  it("sendInput throws for non-interactive command sessions", async () => {
    const promise = attachToCentrifugoCommandHandle(makeSandbox(), {
      commandId: "cmd-uuid-1",
    });
    await flush();
    const sub = fakeSubscriptions[0];
    sub.__emit("subscribed", {});
    await flush();
    const status = sub.published[0] as Record<string, unknown>;
    sub.__emit("publication", {
      data: {
        type: "command_status_result",
        commandId: "cmd-uuid-1",
        requestId: status.requestId,
        status: "running",
        pid: 555,
      },
    });
    const handle = await promise;
    await expect(handle.sendInput(new Uint8Array([65]))).rejects.toThrow(
      /non-interactive/,
    );
  });
});
