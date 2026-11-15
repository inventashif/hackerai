const mockSave = jest.fn();
const mockDelete = jest.fn();

jest.mock("../utils/pty-session-registry", () => ({
  savePtySessionRecord: (...args: unknown[]) => mockSave(...args),
  deletePtySessionRecord: (...args: unknown[]) => mockDelete(...args),
}));

import { PtySessionManager } from "../utils/pty-session-manager";
import type { PtyHandle } from "../utils/e2b-pty-adapter";
import type { PtySessionRecord } from "../utils/pty-session-registry";

const makeHandle = (opts: { sessionKey?: string; pid?: number } = {}): {
  handle: PtyHandle;
  kill: jest.Mock;
  emit: (bytes: Uint8Array) => void;
} => {
  const kill = jest.fn(async () => undefined);
  let listener: ((bytes: Uint8Array) => void) | undefined;
  const handle: PtyHandle = {
    pid: opts.pid ?? 4242,
    ...(opts.sessionKey ? { sessionKey: opts.sessionKey } : {}),
    sendInput: jest.fn(async () => undefined),
    resize: jest.fn(async () => undefined),
    kill,
    onData: jest.fn((cb: (bytes: Uint8Array) => void) => {
      listener = cb;
      return () => {
        listener = undefined;
      };
    }),
    exited: new Promise(() => {}),
  };
  return {
    handle,
    kill,
    emit: (bytes: Uint8Array) => listener?.(bytes),
  };
};

describe("PtySessionManager durable sessions", () => {
  let manager: PtySessionManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new PtySessionManager();
  });

  afterEach(async () => {
    await manager.closeAll("chat-1");
  });

  it("persists a record for handles with a sessionKey", async () => {
    const { handle } = makeHandle({ sessionKey: "uuid-1" });
    const session = await manager.create("chat-1", {
      createHandle: async () => handle,
      cols: 120,
      rows: 30,
      kind: "command",
      sandboxIdentity: "connection:conn-1",
      originalCommand: "sleep 300",
    });

    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        handleUuid: "uuid-1",
        managerId: session.sessionId,
        chatId: "chat-1",
        sandboxIdentity: "connection:conn-1",
        originalCommand: "sleep 300",
        kind: "command",
        pid: 4242,
      }),
    );
  });

  it("does not persist records for handles without a sessionKey", async () => {
    const { handle } = makeHandle();
    await manager.create("chat-1", {
      createHandle: async () => handle,
      cols: 120,
      rows: 30,
      sandboxIdentity: "e2b",
      originalCommand: "echo hi",
    });
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("closeAll detaches sessionKey handles without killing or deleting the record", async () => {
    const { handle, kill } = makeHandle({ sessionKey: "uuid-1" });
    const session = await manager.create("chat-1", {
      createHandle: async () => handle,
      cols: 120,
      rows: 30,
      kind: "command",
      sandboxIdentity: "connection:conn-1",
      originalCommand: "sleep 300",
    });

    await manager.closeAll("chat-1");

    expect(kill).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(manager.get("chat-1", session.sessionId)).toBeUndefined();
  });

  it("closeAll still kills handles without a sessionKey", async () => {
    const { handle, kill } = makeHandle();
    const session = await manager.create("chat-1", {
      createHandle: async () => handle,
      cols: 120,
      rows: 30,
      sandboxIdentity: "e2b",
      originalCommand: "echo hi",
    });

    await manager.closeAll("chat-1");

    expect(kill).toHaveBeenCalledTimes(1);
    expect(manager.get("chat-1", session.sessionId)).toBeUndefined();
  });

  it("restore registers under the original id and refreshes the record", async () => {
    const record: PtySessionRecord = {
      handleUuid: "uuid-1",
      managerId: "abcd1234",
      chatId: "chat-1",
      sandboxIdentity: "connection:conn-1",
      originalCommand: "sleep 300",
      kind: "command",
      pid: 4242,
      createdAt: Date.now(),
      cols: 120,
      rows: 30,
    };
    const { handle, emit } = makeHandle({ sessionKey: "uuid-1" });

    const restored = await manager.restore("chat-1", record, handle);
    expect(restored.sessionId).toBe("abcd1234");
    expect(manager.get("chat-1", "abcd1234")).toBe(restored);
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ handleUuid: "uuid-1", managerId: "abcd1234" }),
    );

    // Output flows into the restored session's buffer.
    emit(new TextEncoder().encode("hello"));
    expect(manager.snapshot(restored).byteLength).toBeGreaterThan(0);
  });

  it("close deletes the registry record", async () => {
    const { handle } = makeHandle({ sessionKey: "uuid-1" });
    const session = await manager.create("chat-1", {
      createHandle: async () => handle,
      cols: 120,
      rows: 30,
      kind: "command",
      sandboxIdentity: "connection:conn-1",
      originalCommand: "sleep 300",
    });

    await manager.close("chat-1", session.sessionId);

    expect(mockDelete).toHaveBeenCalledWith("chat-1", session.sessionId);
  });

  it("setSessionKey binds a key to a keyless command session and persists it", async () => {
    const { handle } = makeHandle();
    const session = await manager.create("chat-1", {
      createHandle: async () => handle,
      cols: 120,
      rows: 30,
      kind: "command",
      sandboxIdentity: "connection:conn-1",
      originalCommand: "nuclei -u http://example.com",
    });
    expect(mockSave).not.toHaveBeenCalled();

    const ok = await manager.setSessionKey(
      "chat-1",
      session.sessionId,
      "cmd-uuid-9",
    );

    expect(ok).toBe(true);
    expect(session.sessionKey).toBe("cmd-uuid-9");
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        handleUuid: "cmd-uuid-9",
        managerId: session.sessionId,
        kind: "command",
      }),
    );
  });

  it("setSessionKey returns false for a missing session", async () => {
    const ok = await manager.setSessionKey("chat-1", "nope1234", "cmd-uuid-9");
    expect(ok).toBe(false);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("closeAll detaches a command session once its key is bound", async () => {
    const { handle, kill } = makeHandle();
    const session = await manager.create("chat-1", {
      createHandle: async () => handle,
      cols: 120,
      rows: 30,
      kind: "command",
      sandboxIdentity: "connection:conn-1",
      originalCommand: "nuclei -u http://example.com",
    });
    await manager.setSessionKey("chat-1", session.sessionId, "cmd-uuid-9");

    await manager.closeAll("chat-1");

    expect(kill).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(manager.get("chat-1", session.sessionId)).toBeUndefined();
  });
});
