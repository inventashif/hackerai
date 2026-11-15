/**
 * Per-chat terminal session store.
 *
 * Lifetime model: the sandbox-side PTY outlives any single server instance.
 * `closeAll` (called at the end of every assistant turn) DETACHES
 * Centrifugo-backed sessions — it drops only the local bookkeeping and
 * keeps the process running plus its durable registry record, so a later
 * turn (usually on a different serverless instance) can re-attach via
 * `restore()`. Explicit `close()`/kill, idle expiry, and lifetime expiry
 * still terminate the process. E2B sessions keep the old closeAll-kills
 * behavior (no durable registry for them). The agent enforces a PTY
 * lifetime cap, so a detached session can never leak forever.
 *
 * Most sessions are interactive PTYs. A foreground non-interactive command
 * that outlives its initial wait window is registered as `kind="command"` so
 * the model receives a real opaque session id instead of trying to derive one
 * from an OS PID. Command sessions on a Centrifugo sandbox are durable too:
 * once the command starts, its commandId is bound via `setSessionKey` and
 * persisted, so later turns re-attach with a `command_status` query instead
 * of finding the session gone.
 */

import type { PtyHandle } from "./e2b-pty-adapter";
import { isExpectedAlreadyGoneCleanupError } from "@/lib/utils/cleanup-errors";
import type { AgentApprovalSandboxIdentity } from "@/types";
import {
  deletePtySessionRecord,
  savePtySessionRecord,
  type PtySessionRecord,
} from "./pty-session-registry";

export const MAX_CONCURRENT_PTYS_PER_CHAT = 10;
export const SESSION_IDLE_TIMEOUT_MS = 10 * 60_000;
export const SESSION_MAX_LIFETIME_MS = 60 * 60_000;
export const MAX_BUFFER_BYTES = 256 * 1024;

/**
 * Fixed PTY geometry. We DO NOT let the AI model pick these — a terminal
 * size should match a real display, not a model-chosen value. UIs that
 * render the PTY elsewhere (xterm.js in the sidebar, a real TTY on the
 * Tauri side) can still call `PtyHandle.resize()` directly.
 */
export const DEFAULT_PTY_COLS = 120;
export const DEFAULT_PTY_ROWS = 30;

const CLOSE_EXIT_FALLBACK_MS = 2_000;
const FAILED_COMMAND_CLEANUP_RETRY_BASE_MS = 5_000;
const FAILED_COMMAND_CLEANUP_RETRY_MAX_MS = 30_000;
const MAX_FAILED_COMMAND_CLEANUP_ATTEMPTS = 6;

export interface PtySession {
  readonly sessionId: string;
  readonly chatId: string;
  readonly kind: "pty" | "command";
  readonly sandboxIdentity: AgentApprovalSandboxIdentity;
  /** Exact command that created the process represented by this session. */
  readonly originalCommand: string;
  /** Working directory used when the originating command was started. */
  readonly workingDirectory?: string;
  readonly pid: number;
  /**
   * Durable agent-side key for this session: the PTY handle UUID or the
   * one-shot commandId. Present exactly when the session is re-attachable
   * across turns (persisted in the registry, detached — never killed — at
   * turn end). For command sessions it is set after creation, once the
   * command starts, via `setSessionKey`.
   */
  sessionKey?: string;
  cols: number;
  rows: number;
  readonly createdAt: number;
  lastActivityAt: number;
  readonly handle: PtyHandle;
  /**
   * Appended raw bytes. Ring: when total size exceeds `MAX_BUFFER_BYTES`,
   * old chunks are dropped (FIFO).
   */
  buffer: Uint8Array[];
  /**
   * Byte offset of last model-visible read; used by wait/view to compute
   * deltas. Tracked relative to the *current* `buffer` contents — when the
   * ring drops bytes before the cursor, the cursor is clamped to `0` and
   * `bufferTruncated` is set to `true`.
   */
  readCursor: number;
  /** Flipped once when the ring first drops any bytes. Never reset. */
  bufferTruncated: boolean;
}

export interface CreateSessionOpts {
  /** Factory — called by the manager; allows tests to inject a fake handle. */
  createHandle: () => Promise<PtyHandle>;
  cols: number;
  rows: number;
  kind?: "pty" | "command";
  /** Sandbox/connection that owns the underlying process. */
  sandboxIdentity: AgentApprovalSandboxIdentity;
  /** Exact command that created the process represented by this session. */
  originalCommand: string;
  /** Working directory used when the originating command was started. */
  workingDirectory?: string;
}

interface InternalSession extends PtySession {
  /** Total bytes dropped from the front of the ring since session start. */
  droppedBytes: number;
  /** idle-timeout timer — reset on every input/output byte. */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** hard cap timer — set at create, never reset. */
  lifetimeTimer: ReturnType<typeof setTimeout> | null;
  /** bounded retry timer after command transport termination fails. */
  cleanupRetryTimer: ReturnType<typeof setTimeout> | null;
  /** consecutive unexpected command cleanup failures. */
  cleanupFailureCount: number;
  /** onData unsubscribe function. */
  unsubscribe: (() => void) | null;
  /** True once close() has been initiated — prevents re-entry. */
  closing: boolean;
  /** Set when the process exits naturally — session stays around for view/wait. */
  exitedNaturally: { exitCode: number | null } | null;
}

/**
 * 8 hex chars = 32 bits of entropy. With MAX_CONCURRENT_PTYS_PER_CHAT
 * collisions are negligible (~10^-8 per chat at the cap), but we still
 * retry a handful of times on the off chance.
 *
 * Short ids matter because the agent has to copy this value into every
 * `interact_terminal_session` call — full UUIDs cost tokens and make
 * tool args more error-prone.
 */
function shortSessionId(
  taken: ReadonlyMap<string, unknown> | undefined,
): string {
  for (let i = 0; i < 5; i++) {
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    if (!taken || !taken.has(id)) return id;
  }
  throw new Error("Failed to generate unique session id after 5 attempts");
}

export class PtySessionManager {
  private chats = new Map<string, Map<string, InternalSession>>();

  async create(chatId: string, opts: CreateSessionOpts): Promise<PtySession> {
    const chat = this.chats.get(chatId);
    const count = chat ? chat.size : 0;
    if (count >= MAX_CONCURRENT_PTYS_PER_CHAT) {
      throw new Error(
        `MAX_CONCURRENT_PTYS_PER_CHAT reached (limit=${MAX_CONCURRENT_PTYS_PER_CHAT}) for chatId=${chatId}`,
      );
    }

    // The factory is invoked BY the manager so that concurrency cap rejection
    // above happens without spawning anything. If the factory itself throws,
    // nothing leaks — there is no handle to clean up. If wiring the handle
    // *after* it's spawned throws, we best-effort kill the orphan so it
    // doesn't leak in the sandbox.
    const handle = await opts.createHandle();
    const sessionId = shortSessionId(chat);
    const now = Date.now();

    try {
      const session = this.registerSession(chatId, sessionId, handle, {
        kind: opts.kind ?? "pty",
        sandboxIdentity: opts.sandboxIdentity ?? "e2b",
        originalCommand: opts.originalCommand,
        workingDirectory: opts.workingDirectory,
        cols: opts.cols,
        rows: opts.rows,
        createdAt: now,
      });
      await this.persistSession(session);
      return session;
    } catch (wiringErr) {
      // Handle was spawned but we failed to wire it up — kill it to avoid
      // leaking a live PTY in the sandbox.
      try {
        await handle.kill();
      } catch (killErr) {
        if (isExpectedAlreadyGoneCleanupError(killErr)) {
          console.debug(
            "[pty-session-manager] orphan already gone pid=" + handle.pid + ":",
            killErr,
          );
          throw wiringErr;
        }
        console.error(
          "[pty-session-manager] orphan kill failed pid=" + handle.pid + ":",
          killErr,
        );
      }
      throw wiringErr;
    }
  }

  /**
   * Re-attach a session created by an earlier turn (usually on another
   * serverless instance) from its durable registry record. The caller
   * supplies an already-attached handle; this wires it under the ORIGINAL
   * manager id so the model-visible id stays stable across turns. The
   * registry record is re-saved to refresh its TTL. Never kills the
   * sandbox process on failure — it belongs to an earlier turn.
   */
  async restore(
    chatId: string,
    record: PtySessionRecord,
    handle: PtyHandle,
  ): Promise<PtySession> {
    const existing = this.chats.get(chatId)?.get(record.managerId);
    if (existing) return existing;
    const chat = this.chats.get(chatId);
    if (chat && chat.size >= MAX_CONCURRENT_PTYS_PER_CHAT) {
      throw new Error(
        `MAX_CONCURRENT_PTYS_PER_CHAT reached (limit=${MAX_CONCURRENT_PTYS_PER_CHAT}) for chatId=${chatId}`,
      );
    }
    const session = this.registerSession(
      chatId,
      record.managerId,
      handle,
      {
        kind: record.kind,
        sandboxIdentity: record.sandboxIdentity,
        originalCommand: record.originalCommand,
        workingDirectory: record.workingDirectory,
        cols: record.cols,
        rows: record.rows,
        createdAt: record.createdAt,
      },
    );
    await this.persistSession(session);
    return session;
  }

  /**
   * Bind a durable agent-side key to an existing session and persist its
   * registry record. Command sessions are created before their command
   * starts, so the commandId is only known afterwards — the caller reports
   * it here. Returns false when the session is already gone (nothing to
   * persist). Safe to call twice with the same key (re-save refreshes TTL).
   */
  async setSessionKey(
    chatId: string,
    sessionId: string,
    key: string,
  ): Promise<boolean> {
    const session = this.chats.get(chatId)?.get(sessionId);
    if (!session || !key) return false;
    session.sessionKey = key;
    await this.persistSession(session);
    return true;
  }

  private registerSession(
    chatId: string,
    sessionId: string,
    handle: PtyHandle,
    opts: {
      kind: "pty" | "command";
      sandboxIdentity: AgentApprovalSandboxIdentity;
      originalCommand: string;
      workingDirectory?: string;
      cols: number;
      rows: number;
      createdAt: number;
    },
  ): InternalSession {
    const session: InternalSession = {
      sessionId,
      chatId,
      kind: opts.kind,
      sandboxIdentity: opts.sandboxIdentity,
      originalCommand: opts.originalCommand,
      ...(opts.workingDirectory
        ? { workingDirectory: opts.workingDirectory }
        : {}),
      // PTY handles carry their key from creation; command handles get
      // theirs later via setSessionKey.
      ...(handle.sessionKey ? { sessionKey: handle.sessionKey } : {}),
      get pid() {
        return handle.pid;
      },
      cols: opts.cols,
      rows: opts.rows,
      createdAt: opts.createdAt,
      lastActivityAt: Date.now(),
      handle,
      buffer: [],
      readCursor: 0,
      bufferTruncated: false,
      droppedBytes: 0,
      idleTimer: null,
      lifetimeTimer: null,
      cleanupRetryTimer: null,
      cleanupFailureCount: 0,
      unsubscribe: null,
      closing: false,
      exitedNaturally: null,
    };

    // Subscribe to handle output
    session.unsubscribe = handle.onData((bytes) => {
      this.onData(session, bytes);
    });

    // idle + lifetime timers
    this.armIdleTimer(session);
    const lifetimeRemaining =
      session.createdAt + SESSION_MAX_LIFETIME_MS - Date.now();
    session.lifetimeTimer = setTimeout(
      () => {
        void this.killAndRemove(session, "lifetime").catch(() => {});
      },
      Math.max(0, lifetimeRemaining),
    );

    // Natural exit — mark as exited but keep session around so the model
    // can still call view/wait to read the final output. closeAll() or
    // kill will do the actual cleanup.
    handle.exited
      .then(
        (info) => {
          session.exitedNaturally = { exitCode: info.exitCode };
        },
        () => {
          session.exitedNaturally = { exitCode: null };
        },
      )
      .catch((err) =>
        console.error("[pty-session-manager] exited handler failed:", err),
      );

    // Register
    let chatMap = this.chats.get(chatId);
    if (!chatMap) {
      chatMap = new Map();
      this.chats.set(chatId, chatMap);
    }
    chatMap.set(sessionId, session);

    return session;
  }

  private async persistSession(session: PtySession): Promise<void> {
    const handleUuid = session.sessionKey;
    if (!handleUuid) return;
    await savePtySessionRecord({
      handleUuid,
      managerId: session.sessionId,
      chatId: session.chatId,
      sandboxIdentity: session.sandboxIdentity,
      originalCommand: session.originalCommand,
      workingDirectory: session.workingDirectory,
      kind: session.kind,
      pid: session.handle.pid,
      createdAt: session.createdAt,
      cols: session.cols,
      rows: session.rows,
    });
  }

  get(chatId: string, sessionId: string): PtySession | undefined {
    return this.chats.get(chatId)?.get(sessionId);
  }

  list(chatId: string): PtySession[] {
    const chat = this.chats.get(chatId);
    if (!chat) return [];
    return Array.from(chat.values());
  }

  /**
   * Returns bytes currently available starting at `session.readCursor`.
   * Does not advance the cursor.
   */
  peekBufferSize(session: PtySession): number {
    const total = this.totalBufferBytes(session);
    return Math.max(0, total - session.readCursor);
  }

  /**
   * Returns (and copies) bytes since `readCursor`, then advances the cursor.
   */
  consumeDelta(session: PtySession): Uint8Array {
    const total = this.totalBufferBytes(session);
    const start = Math.min(session.readCursor, total);
    const out = this.sliceBuffer(session, start, total);
    session.readCursor = total;
    return out;
  }

  /**
   * Returns the full accumulated buffer without advancing `readCursor`.
   * Intended for `action=view`.
   */
  snapshot(session: PtySession): Uint8Array {
    const total = this.totalBufferBytes(session);
    return this.sliceBuffer(session, 0, total);
  }

  async close(chatId: string, sessionId: string): Promise<void> {
    const chat = this.chats.get(chatId);
    const session = chat?.get(sessionId);
    if (!session) return;
    await this.killAndRemove(session, "close");
  }

  async closeAll(chatId: string): Promise<void> {
    const chat = this.chats.get(chatId);
    if (!chat) return;
    const sessions = Array.from(chat.values());
    await Promise.all(
      sessions.map((s) =>
        // Durable (Centrifugo-backed) sessions DETACH at turn end: the
        // sandbox process keeps running and the registry record stays, so
        // the next turn can re-attach. Killing here would destroy exactly
        // the long-running work the model parked in the session. E2B
        // sessions and keyless command sessions have no registry record
        // and keep the old kill behavior.
        s.sessionKey
          ? this.detachSession(s)
          : this.killAndRemove(s, "closeAll"),
      ),
    );
  }

  /**
   * Drop local bookkeeping for a session WITHOUT terminating the sandbox
   * process and WITHOUT deleting its registry record. The next turn
   * re-attaches via `restore()`. The agent-side lifetime cap bounds how
   * long a detached process can run.
   */
  private detachSession(session: InternalSession): void {
    this.unregisterSession(session);
  }

  /**
   * Remove a completed, unexposed session without sending a redundant kill.
   * Used for ordinary non-interactive commands that finish inside the initial
   * run_terminal_cmd wait window.
   */
  forget(chatId: string, sessionId: string): void {
    const session = this.chats.get(chatId)?.get(sessionId);
    if (!session) return;
    this.removeSession(session);
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private onData(session: InternalSession, bytes: Uint8Array): void {
    if (session.closing) return;
    // Copy into an owned Uint8Array so callers can recycle buffers
    const chunk = new Uint8Array(bytes);
    session.buffer.push(chunk);
    session.lastActivityAt = Date.now();
    this.enforceRing(session);
    this.armIdleTimer(session);
  }

  private armIdleTimer(session: InternalSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      void this.killAndRemove(session, "idle").catch(() => {});
    }, SESSION_IDLE_TIMEOUT_MS);
  }

  private enforceRing(session: InternalSession): void {
    let total = session.buffer.reduce((n, c) => n + c.byteLength, 0);
    while (total > MAX_BUFFER_BYTES && session.buffer.length > 0) {
      const dropped = session.buffer.shift()!;
      total -= dropped.byteLength;
      session.droppedBytes += dropped.byteLength;
      session.bufferTruncated = true;
      // Adjust readCursor — if bytes we had not yet shown were dropped,
      // clamp to 0 relative to the new buffer start.
      if (session.readCursor >= dropped.byteLength) {
        session.readCursor -= dropped.byteLength;
      } else {
        session.readCursor = 0;
      }
    }
  }

  private totalBufferBytes(session: PtySession): number {
    let n = 0;
    for (const chunk of session.buffer) n += chunk.byteLength;
    return n;
  }

  private sliceBuffer(
    session: PtySession,
    start: number,
    end: number,
  ): Uint8Array {
    if (end <= start) return new Uint8Array(0);
    const out = new Uint8Array(end - start);
    let outOffset = 0;
    let cursor = 0;
    for (const chunk of session.buffer) {
      const chunkStart = cursor;
      const chunkEnd = cursor + chunk.byteLength;
      if (chunkEnd <= start) {
        cursor = chunkEnd;
        continue;
      }
      if (chunkStart >= end) break;
      const sliceStart = Math.max(0, start - chunkStart);
      const sliceEnd = Math.min(chunk.byteLength, end - chunkStart);
      out.set(chunk.subarray(sliceStart, sliceEnd), outOffset);
      outOffset += sliceEnd - sliceStart;
      cursor = chunkEnd;
    }
    return out;
  }

  private async killAndRemove(
    session: InternalSession,
    _reason: "close" | "closeAll" | "idle" | "lifetime",
  ): Promise<void> {
    if (session.closing) {
      // Another caller is already closing — wait for removal to finish.
      const chat = this.chats.get(session.chatId);
      if (!chat || !chat.has(session.sessionId)) return;
      // Best-effort: await the handle's exited promise (still safe).
      await Promise.race([
        session.handle.exited.catch(() => undefined),
        new Promise<void>((r) => setTimeout(r, CLOSE_EXIT_FALLBACK_MS)),
      ]);
      return;
    }
    session.closing = true;

    // Stop timers before kicking kill — avoids the timer re-entering kill.
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    if (session.lifetimeTimer) {
      clearTimeout(session.lifetimeTimer);
      session.lifetimeTimer = null;
    }
    if (session.cleanupRetryTimer) {
      clearTimeout(session.cleanupRetryTimer);
      session.cleanupRetryTimer = null;
    }

    let unexpectedKillError: unknown;
    try {
      await session.handle.kill();
    } catch (err) {
      if (isExpectedAlreadyGoneCleanupError(err)) {
        console.debug(
          "[pty-session-manager] session already gone pid=" + session.pid + ":",
          err,
        );
      } else {
        console.error(
          "[pty-session-manager] kill failed pid=" + session.pid + ":",
          err,
        );
        unexpectedKillError = err;
      }
    }

    // A command session represents a still-running foreground execution. If
    // its transport could not confirm termination, keep the handle and output
    // buffer registered rather than claiming success and losing the only safe
    // way to retry cleanup. Natural exit or a later cleanup attempt can still
    // settle and remove it.
    if (unexpectedKillError && session.kind === "command") {
      session.closing = false;
      session.cleanupFailureCount += 1;
      const lifetimeRemaining =
        session.createdAt + SESSION_MAX_LIFETIME_MS - Date.now();
      const cleanupExhausted =
        session.cleanupFailureCount >= MAX_FAILED_COMMAND_CLEANUP_ATTEMPTS ||
        lifetimeRemaining <= 0;

      if (cleanupExhausted) {
        // The transport repeatedly failed to terminate a command. Drop only
        // the local bookkeeping at the bounded retry/lifetime cap so one
        // broken handle cannot permanently consume a per-chat session slot.
        this.removeSession(session);
        throw unexpectedKillError;
      }

      const retryDelayMs = Math.min(
        FAILED_COMMAND_CLEANUP_RETRY_BASE_MS *
          2 ** (session.cleanupFailureCount - 1),
        FAILED_COMMAND_CLEANUP_RETRY_MAX_MS,
      );
      session.cleanupRetryTimer = setTimeout(() => {
        void this.killAndRemove(session, "idle").catch(() => {});
      }, retryDelayMs);
      session.lifetimeTimer = setTimeout(() => {
        void this.killAndRemove(session, "lifetime").catch(() => {});
      }, lifetimeRemaining);
      throw unexpectedKillError;
    }

    await Promise.race([
      session.handle.exited.catch(() => undefined),
      new Promise<void>((resolve) =>
        setTimeout(resolve, CLOSE_EXIT_FALLBACK_MS),
      ),
    ]);

    this.removeSession(session);
  }

  private removeSession(session: InternalSession): void {
    this.unregisterSession(session);
    // Best-effort: the registry record must not outlive a killed session,
    // or a later turn would re-attach to a dead process id.
    void deletePtySessionRecord(session.chatId, session.sessionId);
  }

  private unregisterSession(session: InternalSession): void {
    if (session.unsubscribe) {
      try {
        session.unsubscribe();
      } catch (err) {
        console.error("[pty-session-manager] unsubscribe failed:", err);
      }
      session.unsubscribe = null;
    }
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    if (session.lifetimeTimer) {
      clearTimeout(session.lifetimeTimer);
      session.lifetimeTimer = null;
    }
    if (session.cleanupRetryTimer) {
      clearTimeout(session.cleanupRetryTimer);
      session.cleanupRetryTimer = null;
    }
    const chat = this.chats.get(session.chatId);
    if (chat) {
      chat.delete(session.sessionId);
      if (chat.size === 0) this.chats.delete(session.chatId);
    }
  }
}

/** Process-wide singleton used by `run_terminal_cmd` and `chat-handler`. */
export const ptySessionManager = new PtySessionManager();
