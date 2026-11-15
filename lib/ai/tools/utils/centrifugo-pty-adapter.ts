/**
 * Centrifugo PTY adapter.
 *
 * Creates a PtyHandle that communicates with the local runner via Centrifugo
 * pub/sub. Mirrors the interface of e2b-pty-adapter.ts so the interactive
 * exec branch in run_terminal_cmd.ts can treat both sandbox types identically.
 *
 * Message flow:
 *   Server  →  pty_create   →  Local runner
 *   Local   →  pty_ready    →  Server  (resolves create promise)
 *   Local   →  pty_data     →  Server  (fans out to onData listeners)
 *   Local   →  pty_exit     →  Server  (resolves exited promise)
 *   Local   →  pty_error    →  Server  (rejects / emits error)
 *   Server  →  pty_input    →  Local runner
 *   Server  →  pty_resize   →  Local runner
 *   Server  →  pty_kill     →  Local runner
 *
 * Re-attach flow (a later server instance resuming an existing session):
 *   Server  →  pty_status        →  Local runner (no pty_create sent)
 *   Local   →  pty_status_result →  Server  (running/exited/unknown + tail)
 * The status tail is replayed to the first onData subscriber so the
 * re-attaching instance starts with the same output history; live data
 * arriving before the status answer is queued behind the tail.
 */

import { Centrifuge, type Subscription } from "centrifuge";

import { sandboxConnectionChannel } from "@/lib/centrifugo/types";
import {
  CentrifugoMessageReassembler,
  fragmentMatchesCorrelation,
} from "@/packages/local/src/centrifugo-transport";
import type { PtyHandle, CreatePtyOptions } from "./e2b-pty-adapter";
import type { CentrifugoSandbox } from "./centrifugo-sandbox";
import { createResolvableExited } from "./pty-exited-promise";

// ── Options ────────────────────────────────────────────────────────────

export interface CentrifugoPtyOptions extends CreatePtyOptions {
  /** Shell command to execute. Sent inside pty_create — NOT via sendInput. */
  command: string;
}

/** Options for re-attaching to an existing sandbox-side PTY session. */
export interface CentrifugoPtyAttachOptions {
  /** Agent-side session key (the handle UUID from the registry record). */
  sessionId: string;
  cols: number;
  rows: number;
}

// ── Internal message types (outgoing to local runner) ──────────────────

interface PtyCreatePayload {
  type: "pty_create";
  sessionId: string;
  command: string;
  cols: number;
  rows: number;
  cwd?: string;
  env?: Record<string, string>;
  targetConnectionId: string;
}

interface PtyInputPayload {
  type: "pty_input";
  sessionId: string;
  data: string;
  targetConnectionId: string;
}

interface PtyResizePayload {
  type: "pty_resize";
  sessionId: string;
  cols: number;
  rows: number;
  targetConnectionId: string;
}

interface PtyKillPayload {
  type: "pty_kill";
  sessionId: string;
  targetConnectionId: string;
}

interface PtyStatusPayload {
  type: "pty_status";
  sessionId: string;
  requestId: string;
  targetConnectionId: string;
}

type PtyOutgoingPayload =
  | PtyCreatePayload
  | PtyInputPayload
  | PtyResizePayload
  | PtyKillPayload
  | PtyStatusPayload;

// ── Incoming message shapes from the local runner ──────────────────────

interface PtyReadyMsg {
  type: "pty_ready";
  sessionId: string;
  pid: number;
}

interface PtyDataMsg {
  type: "pty_data";
  sessionId: string;
  data: string;
}

interface PtyExitMsg {
  type: "pty_exit";
  sessionId: string;
  exitCode: number;
}

interface PtyErrorMsg {
  type: "pty_error";
  sessionId: string;
  message: string;
}

interface PtyStatusResultMsg {
  type: "pty_status_result";
  sessionId: string;
  requestId: string;
  status: "running" | "exited" | "unknown";
  pid?: number;
  exitCode?: number | null;
  outputTail?: string;
}

type PtyIncomingMsg =
  | PtyReadyMsg
  | PtyDataMsg
  | PtyExitMsg
  | PtyErrorMsg
  | PtyStatusResultMsg;

// ── Helpers ────────────────────────────────────────────────────────────

const LOG_PREFIX = "[centrifugo-pty]";

function parsePtyMessage(data: unknown): PtyIncomingMsg | null {
  if (typeof data !== "object" || data === null) return null;
  const msg = data as Record<string, unknown>;
  if (typeof msg.type !== "string") return null;
  if (typeof msg.sessionId !== "string") return null;

  switch (msg.type) {
    case "pty_ready":
      if (typeof msg.pid !== "number") return null;
      return {
        type: "pty_ready",
        sessionId: msg.sessionId,
        pid: msg.pid,
      };
    case "pty_data":
      if (typeof msg.data !== "string") return null;
      return {
        type: "pty_data",
        sessionId: msg.sessionId,
        data: msg.data,
      };
    case "pty_exit":
      if (typeof msg.exitCode !== "number") return null;
      return {
        type: "pty_exit",
        sessionId: msg.sessionId,
        exitCode: msg.exitCode,
      };
    case "pty_error":
      if (typeof msg.message !== "string") return null;
      return {
        type: "pty_error",
        sessionId: msg.sessionId,
        message: msg.message,
      };
    case "pty_status_result": {
      if (typeof msg.requestId !== "string") return null;
      if (
        msg.status !== "running" &&
        msg.status !== "exited" &&
        msg.status !== "unknown"
      ) {
        return null;
      }
      return {
        type: "pty_status_result",
        sessionId: msg.sessionId,
        requestId: msg.requestId,
        status: msg.status,
        ...(typeof msg.pid === "number" ? { pid: msg.pid } : {}),
        ...(typeof msg.exitCode === "number" || msg.exitCode === null
          ? { exitCode: msg.exitCode }
          : {}),
        ...(typeof msg.outputTail === "string"
          ? { outputTail: msg.outputTail }
          : {}),
      };
    }
    default:
      return null;
  }
}

// ── Public factory ─────────────────────────────────────────────────────

/**
 * Create a PtyHandle that tunnels through Centrifugo to a local runner.
 *
 * Uses the same per-connection channel as one-shot commands.
 * Filters incoming publications by `sessionId`.
 */
export async function createCentrifugoPtyHandle(
  sandbox: CentrifugoSandbox,
  opts: CentrifugoPtyOptions,
): Promise<PtyHandle> {
  return createOrAttachCentrifugoPtyHandle(sandbox, opts);
}

/**
 * Re-attach to an existing sandbox-side PTY session (created by an earlier
 * turn, usually on another server instance). Subscribes to the same channel,
 * queries `pty_status` instead of sending `pty_create`, and replays the
 * retained output tail to the first onData subscriber. Rejects when the
 * agent reports the session unknown or the query times out.
 */
export async function attachToCentrifugoPtyHandle(
  sandbox: CentrifugoSandbox,
  opts: CentrifugoPtyAttachOptions,
): Promise<PtyHandle> {
  return createOrAttachCentrifugoPtyHandle(sandbox, {
    cols: opts.cols,
    rows: opts.rows,
    command: "",
    existingSessionId: opts.sessionId,
  });
}

async function createOrAttachCentrifugoPtyHandle(
  sandbox: CentrifugoSandbox,
  opts: Omit<CentrifugoPtyOptions, "command"> & {
    command?: string;
    existingSessionId?: string;
  },
): Promise<PtyHandle> {
  const attaching = !!opts.existingSessionId;
  const sessionId = opts.existingSessionId ?? crypto.randomUUID();
  const statusRequestId = attaching ? crypto.randomUUID() : "";
  const userId = sandbox.getUserId();
  const connectionId = sandbox.getConnectionId();
  const channel = sandboxConnectionChannel(userId, connectionId);

  // Long-lived token: PTY sessions can last minutes.
  const tokenExpSeconds = 600;
  const token = await sandbox.issueToken(tokenExpSeconds);

  const client = new Centrifuge(sandbox.getWsUrl(), { token });

  const listeners = new Set<(bytes: Uint8Array) => void>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  // Attach mode: bytes that arrive before the first onData subscriber
  // (status tail + live data racing the status answer) are queued here and
  // replayed once, in order, so the re-attaching instance starts with the
  // same output history instead of a gap.
  const replayQueue: Uint8Array[] = [];
  let replayDelivered = false;

  let pid = 0;
  let subscription: Subscription | undefined;
  let settled = false;
  let cleanedUp = false;
  const reassembler = new CentrifugoMessageReassembler();

  const { exited, resolveOnce: resolveExitedOnce } = createResolvableExited();

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (subscription) {
      try {
        subscription.unsubscribe();
        subscription.removeAllListeners();
      } catch {
        // ignore
      }
    }
    try {
      client.disconnect();
    } catch {
      // ignore
    }
  };

  // Helper to publish a message on the subscription. Wraps Centrifuge
  // errors (which may be plain objects) as Error instances so callers
  // don't see "[object Object]" from String(err).
  const publish = async (payload: PtyOutgoingPayload): Promise<void> => {
    if (!subscription) throw new Error(`${LOG_PREFIX} subscription not ready`);
    try {
      await subscription.publish(payload);
    } catch (err) {
      if (err instanceof Error) throw err;
      const msg =
        typeof err === "string"
          ? err
          : (err as { message?: string })?.message ||
            JSON.stringify(err) ||
            "publish failed";
      throw new Error(`${LOG_PREFIX} ${payload.type} publish failed: ${msg}`);
    }
  };

  // Build the handle that will be returned once pty_ready arrives
  const handle: PtyHandle = {
    get pid() {
      return pid;
    },

    sessionKey: sessionId,

    async sendInput(bytes: Uint8Array): Promise<void> {
      const payload: PtyInputPayload = {
        type: "pty_input",
        sessionId,
        data: decoder.decode(bytes),
        targetConnectionId: connectionId,
      };
      await publish(payload);
    },

    async resize(cols: number, rows: number): Promise<void> {
      const payload: PtyResizePayload = {
        type: "pty_resize",
        sessionId,
        cols,
        rows,
        targetConnectionId: connectionId,
      };
      await publish(payload);
    },

    async kill(): Promise<void> {
      const payload: PtyKillPayload = {
        type: "pty_kill",
        sessionId,
        targetConnectionId: connectionId,
      };
      try {
        await publish(payload);
      } catch (err) {
        // Publish can fail if the PTY is already gone; don't mask the rest
        // of kill(), but do log so silent IPC errors stay visible.
        console.warn(`${LOG_PREFIX} pty_kill publish failed:`, err);
      }
      // Give the local runner a short window to emit pty_exit so callers
      // awaiting `exited` see the real exit code. Fall back to null if it
      // doesn't arrive — cleanup would otherwise tear down the subscription
      // and the reply would be dropped.
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 1500)),
      ]);
      resolveExitedOnce({ exitCode: null });
      cleanup();
    },

    onData(cb: (bytes: Uint8Array) => void): () => void {
      listeners.add(cb);
      if (attaching && !replayDelivered) {
        replayDelivered = true;
        for (const queued of replayQueue) {
          try {
            cb(queued);
          } catch (err) {
            console.error(`${LOG_PREFIX} listener threw:`, err);
          }
        }
        replayQueue.length = 0;
      }
      return () => {
        listeners.delete(cb);
      };
    },

    get exited() {
      return exited;
    },
  };

  // Wait for subscription + pty_ready before returning
  return new Promise<PtyHandle>((resolve, reject) => {
    // Attach mode: the status query can be lost when the runner is
    // mid-reconnect (Centrifugo history is disabled, so nothing replays
    // it). Re-publish a few times before giving up: a lost query must
    // not look like a dead session.
    const STATUS_ATTEMPTS = 3;
    const STATUS_RETRY_DELAY_MS = 5_000;
    const TIMEOUT_MS = attaching
      ? STATUS_ATTEMPTS * STATUS_RETRY_DELAY_MS + STATUS_RETRY_DELAY_MS
      : 15_000;
    const retryTimers: ReturnType<typeof setTimeout>[] = [];
    const clearRetryTimers = () => {
      for (const t of retryTimers) clearTimeout(t);
      retryTimers.length = 0;
    };
    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        clearRetryTimers();
        cleanup();
        reject(
          new Error(
            `${LOG_PREFIX} ${attaching ? "pty_status" : "pty_create"} timed out after ${TIMEOUT_MS}ms`,
          ),
        );
      }
    }, TIMEOUT_MS);

    // Transport failure handler: pre-ready we reject the create promise;
    // post-ready we resolve `exited` with a null exitCode so awaiters of
    // handle.exited don't hang forever on a dropped subscription.
    const failTransport = (message: string) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        clearRetryTimers();
        cleanup();
        reject(new Error(`${LOG_PREFIX} ${message}`));
      } else {
        console.error(`${LOG_PREFIX} transport failed after ready: ${message}`);
        resolveExitedOnce({ exitCode: null });
        cleanup();
      }
    };

    const publishStatusQuery = (attempt: number) => {
      if (settled) return;
      const statusPayload: PtyStatusPayload = {
        type: "pty_status",
        sessionId,
        requestId: statusRequestId,
        targetConnectionId: connectionId,
      };
      subscription!.publish(statusPayload).catch((err: unknown) => {
        failTransport(
          `failed to publish pty_status: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      if (attempt + 1 < STATUS_ATTEMPTS) {
        retryTimers.push(
          setTimeout(
            () => publishStatusQuery(attempt + 1),
            STATUS_RETRY_DELAY_MS,
          ),
        );
      }
    };

    subscription = client.newSubscription(channel);

    subscription.on("publication", (ctx) => {
      if (!fragmentMatchesCorrelation(ctx.data, "sessionId", sessionId)) {
        return;
      }
      const reassembled = reassembler.accept(ctx.data);
      if (!reassembled) return;
      const msg = parsePtyMessage(reassembled);
      if (!msg || msg.sessionId !== sessionId) return;

      switch (msg.type) {
        case "pty_ready":
          pid = msg.pid;
          if (!settled) {
            settled = true;
            clearTimeout(timeoutId);
            clearRetryTimers();
            resolve(handle);
          }
          break;

        case "pty_data": {
          const bytes = encoder.encode(msg.data);
          if (attaching && !replayDelivered) {
            // Queue behind the status tail so the re-attaching instance
            // sees output in order instead of live bytes before history.
            replayQueue.push(bytes);
            break;
          }
          const snapshot = Array.from(listeners);
          for (const listener of snapshot) {
            try {
              listener(bytes);
            } catch (err) {
              console.error(`${LOG_PREFIX} listener threw:`, err);
            }
          }
          break;
        }

        case "pty_status_result": {
          if (!attaching || msg.requestId !== statusRequestId) break;
          if (msg.status === "unknown") {
            if (!settled) {
              settled = true;
              clearTimeout(timeoutId);
              clearRetryTimers();
              cleanup();
              reject(
                new Error(
                  `${LOG_PREFIX} session ${sessionId} is unknown to the sandbox runner`,
                ),
              );
            }
            break;
          }
          if (typeof msg.pid === "number") pid = msg.pid;
          if (msg.outputTail) {
            // Tail first: it is the history snapshot, and live bytes queued
            // while the query was in flight come after it.
            replayQueue.unshift(encoder.encode(msg.outputTail));
          }
          if (!settled) {
            settled = true;
            clearTimeout(timeoutId);
            clearRetryTimers();
            resolve(handle);
          }
          if (msg.status === "exited") {
            resolveExitedOnce({ exitCode: msg.exitCode ?? null });
            cleanup();
          }
          break;
        }

        case "pty_exit":
          resolveExitedOnce({ exitCode: msg.exitCode });
          cleanup();
          break;

        case "pty_error":
          if (!settled) {
            settled = true;
            clearTimeout(timeoutId);
            clearRetryTimers();
            cleanup();
            reject(new Error(`${LOG_PREFIX} pty_error: ${msg.message}`));
          } else {
            console.error(
              `${LOG_PREFIX} pty_error after ready: ${msg.message}`,
            );
            resolveExitedOnce({ exitCode: null });
            cleanup();
          }
          break;
      }
    });

    subscription.on("error", (ctx) => {
      failTransport(`subscription error: ${ctx.error?.message ?? "unknown"}`);
    });

    subscription.on("subscribed", () => {
      if (attaching) {
        // Re-attach: ask the runner about the existing session instead of
        // creating a second PTY for the same work. Retried: the query can
        // be lost if the runner is mid-reconnect when it is sent.
        publishStatusQuery(0);
        return;
      }
      // Now that we are subscribed, publish pty_create
      const createPayload: PtyCreatePayload = {
        type: "pty_create",
        sessionId,
        command: opts.command ?? "",
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env: opts.envs,
        targetConnectionId: connectionId,
      };

      subscription!.publish(createPayload).catch((err: unknown) => {
        failTransport(
          `failed to publish pty_create: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });

    subscription.subscribe();
    client.connect();

    client.on("error", (ctx) => {
      failTransport(`client error: ${ctx.error?.message ?? "unknown"}`);
    });
  });
}
