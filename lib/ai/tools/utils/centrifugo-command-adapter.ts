/**
 * Centrifugo one-shot-command re-attach adapter.
 *
 * Re-attaches to a foreground command started by an earlier turn (usually on
 * another serverless instance) via its commandId, which the originating turn
 * persisted in the session registry. The agent retains each streamed
 * command's output tail, PID, and exit code (see CommandHistory in
 * packages/local), so a fresh instance can resume the session instead of
 * reporting it lost.
 *
 * Re-attach flow:
 *   Server  →  command_status        →  Local runner (retried: the query
 *                                        can be lost if the runner is
 *                                        mid-reconnect when it is sent,
 *                                        and Centrifugo history is off)
 *   Local   →  command_status_result →  Server (running/exited/unknown + tail)
 *   Local   →  stdout/stderr         →  Server (live chunks, filtered by
 *                                        commandId, queued behind the tail)
 *   Local   →  exit                  →  Server (resolves exited promise)
 *   Server  →  command_cancel        →  Local runner (kill)
 *
 * The returned handle is non-interactive: sendInput throws, matching the
 * command-session handle the originating turn used. Its sessionKey is the
 * commandId, so the manager persists/detaches it like any durable session.
 */

import { Centrifuge, type Subscription } from "centrifuge";

import { sandboxConnectionChannel } from "@/lib/centrifugo/types";
import {
  CentrifugoMessageReassembler,
  fragmentMatchesCorrelation,
} from "@/packages/local/src/centrifugo-transport";
import type { PtyHandle } from "./e2b-pty-adapter";
import type { CentrifugoSandbox } from "./centrifugo-sandbox";
import { createResolvableExited } from "./pty-exited-promise";

const LOG_PREFIX = "[centrifugo-command-adapter]";

/** Options for re-attaching to an existing sandbox-side command. */
export interface CentrifugoCommandAttachOptions {
  /** Agent-side command key (the commandId from the registry record). */
  commandId: string;
}

// ── Internal message types ─────────────────────────────────────────────

interface CommandStatusPayload {
  type: "command_status";
  commandId: string;
  requestId: string;
  targetConnectionId: string;
}

interface CommandCancelPayload {
  type: "command_cancel";
  commandId: string;
  targetConnectionId: string;
}

type ParsedCommandMessage =
  | { type: "stdout"; commandId: string; data: string }
  | { type: "stderr"; commandId: string; data: string }
  | { type: "exit"; commandId: string; exitCode: number }
  | { type: "error"; commandId: string; message: string }
  | { type: "command_cancel_result"; commandId: string; canceled: boolean }
  | {
      type: "command_status_result";
      commandId: string;
      requestId: string;
      status: "running" | "exited" | "unknown";
      pid?: number;
      exitCode?: number | null;
      outputTail?: string;
    };

function parseCommandMessage(msg: unknown): ParsedCommandMessage | null {
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (typeof m.type !== "string") return null;
  if (typeof m.commandId !== "string") return null;

  switch (m.type) {
    case "stdout":
    case "stderr":
      if (typeof m.data !== "string") return null;
      return { type: m.type, commandId: m.commandId, data: m.data };
    case "exit":
      if (typeof m.exitCode !== "number") return null;
      return { type: "exit", commandId: m.commandId, exitCode: m.exitCode };
    case "error":
      if (typeof m.message !== "string") return null;
      return { type: "error", commandId: m.commandId, message: m.message };
    case "command_cancel_result":
      if (typeof m.canceled !== "boolean") return null;
      return {
        type: "command_cancel_result",
        commandId: m.commandId,
        canceled: m.canceled,
      };
    case "command_status_result": {
      if (typeof m.requestId !== "string") return null;
      if (
        m.status !== "running" &&
        m.status !== "exited" &&
        m.status !== "unknown"
      ) {
        return null;
      }
      return {
        type: "command_status_result",
        commandId: m.commandId,
        requestId: m.requestId,
        status: m.status,
        ...(typeof m.pid === "number" ? { pid: m.pid } : {}),
        ...(typeof m.exitCode === "number" || m.exitCode === null
          ? { exitCode: m.exitCode }
          : {}),
        ...(typeof m.outputTail === "string"
          ? { outputTail: m.outputTail }
          : {}),
      };
    }
    default:
      return null;
  }
}

// ── Public factory ─────────────────────────────────────────────────────

/**
 * Re-attach to an existing sandbox-side command. Subscribes to the same
 * channel, queries `command_status` (with retries), and replays the
 * retained output tail to the first onData subscriber. Rejects when the
 * agent reports the command unknown or the query times out.
 */
export async function attachToCentrifugoCommandHandle(
  sandbox: CentrifugoSandbox,
  opts: CentrifugoCommandAttachOptions,
): Promise<PtyHandle> {
  const commandId = opts.commandId;
  const statusRequestId = crypto.randomUUID();
  const userId = sandbox.getUserId();
  const connectionId = sandbox.getConnectionId();
  const channel = sandboxConnectionChannel(userId, connectionId);

  const tokenExpSeconds = 600;
  const token = await sandbox.issueToken(tokenExpSeconds);

  const client = new Centrifuge(sandbox.getWsUrl(), { token });

  const listeners = new Set<(bytes: Uint8Array) => void>();
  const encoder = new TextEncoder();
  // Bytes that arrive before the first onData subscriber (status tail +
  // live chunks racing the status answer) are queued here and replayed
  // once, in order, so the re-attaching instance starts with the same
  // output history instead of a gap.
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

  const publish = async (
    payload: CommandStatusPayload | CommandCancelPayload,
  ): Promise<void> => {
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

  const handle: PtyHandle = {
    get pid() {
      return pid;
    },

    sessionKey: commandId,

    async sendInput(): Promise<void> {
      throw new Error(
        "This is a non-interactive command session and does not accept input.",
      );
    },

    async resize(): Promise<void> {
      // Non-interactive commands have no terminal geometry.
    },

    async kill(): Promise<void> {
      const payload: CommandCancelPayload = {
        type: "command_cancel",
        commandId,
        targetConnectionId: connectionId,
      };
      try {
        await publish(payload);
      } catch (err) {
        // Publish can fail if the command is already gone; don't mask the
        // rest of kill(), but do log so silent IPC errors stay visible.
        console.warn(`${LOG_PREFIX} command_cancel publish failed:`, err);
      }
      // Give the runner a short window to emit the exit so callers
      // awaiting `exited` see the real outcome. Fall back to null if it
      // doesn't arrive — cleanup would otherwise tear down the
      // subscription and the reply would be dropped. An already-gone
      // command is a success, not an error.
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 1500)),
      ]);
      resolveExitedOnce({ exitCode: null });
      cleanup();
    },

    onData(cb: (bytes: Uint8Array) => void): () => void {
      listeners.add(cb);
      if (!replayDelivered) {
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

  return new Promise<PtyHandle>((resolve, reject) => {
    // The status query can be lost when the runner is mid-reconnect
    // (Centrifugo history is disabled, so nothing replays it). Re-publish
    // a few times before giving up: a lost query must not look like a
    // dead command.
    const STATUS_ATTEMPTS = 3;
    const STATUS_RETRY_DELAY_MS = 5_000;
    const TIMEOUT_MS =
      STATUS_ATTEMPTS * STATUS_RETRY_DELAY_MS + STATUS_RETRY_DELAY_MS;
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
            `${LOG_PREFIX} command_status timed out after ${TIMEOUT_MS}ms`,
          ),
        );
      }
    }, TIMEOUT_MS);

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
      const statusPayload: CommandStatusPayload = {
        type: "command_status",
        commandId,
        requestId: statusRequestId,
        targetConnectionId: connectionId,
      };
      publish(statusPayload).catch((err: unknown) => {
        failTransport(
          `failed to publish command_status: ${err instanceof Error ? err.message : String(err)}`,
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
      if (!fragmentMatchesCorrelation(ctx.data, "commandId", commandId)) {
        return;
      }
      const reassembled = reassembler.accept(ctx.data);
      if (!reassembled) return;
      const msg = parseCommandMessage(reassembled);
      if (!msg || msg.commandId !== commandId) return;

      switch (msg.type) {
        case "stdout":
        case "stderr": {
          const bytes = encoder.encode(msg.data);
          if (!replayDelivered) {
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

        case "command_status_result": {
          if (msg.requestId !== statusRequestId) break;
          if (msg.status === "unknown") {
            if (!settled) {
              settled = true;
              clearTimeout(timeoutId);
              clearRetryTimers();
              cleanup();
              reject(
                new Error(
                  `${LOG_PREFIX} command ${commandId} is unknown to the sandbox runner`,
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

        case "exit":
          resolveExitedOnce({ exitCode: msg.exitCode });
          cleanup();
          break;

        case "command_cancel_result":
          // The runner confirms cancellation by publishing `exit`; the
          // result alone carries no output. Nothing to do here.
          break;

        case "error":
          if (!settled) {
            settled = true;
            clearTimeout(timeoutId);
            clearRetryTimers();
            cleanup();
            reject(new Error(`${LOG_PREFIX} error: ${msg.message}`));
          } else {
            console.error(`${LOG_PREFIX} error after ready: ${msg.message}`);
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
      publishStatusQuery(0);
    });

    subscription.subscribe();
    client.connect();

    client.on("error", (ctx) => {
      failTransport(`client error: ${ctx.error?.message ?? "unknown"}`);
    });
  });
}
