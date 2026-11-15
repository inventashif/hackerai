/**
 * Retained history for one-shot streamed commands (the `command` protocol).
 *
 * The server parks a long foreground command in a `kind="command"` session
 * when its wait window expires, and a LATER turn (usually on another
 * serverless instance) re-attaches via `command_status`. That only works if
 * the agent remembers the command: its output tail, its PID, and — after it
 * exits — its exit code for a retention window. Without this store, a
 * re-attaching turn has no way to learn what a command printed or whether
 * it finished, and the session is reported unrecoverable.
 *
 * Mirrors the retention semantics of ProcessRunner's PTY history: a 64KB
 * FIFO ring per command, a 16KB status tail, and 30-minute retention after
 * exit. The cap is deliberately large (256) and eviction NEVER removes a
 * running command: one-shot commands are far more frequent than PTY
 * sessions (dozens per turn across concurrent turns), so a small FIFO cap
 * evicted commands that later turns still needed to re-attach to.
 */

export interface CommandStatus {
  status: "running" | "exited" | "unknown";
  pid?: number;
  exitCode?: number | null;
  /** Last STATUS_TAIL_BYTES of retained output (empty when nothing kept). */
  outputTail?: string;
}

const HISTORY_MAX_BYTES = 64 * 1024; // 64 KB ring per command
const STATUS_TAIL_BYTES = 16 * 1024; // bytes returned by a status query
const COMMAND_RETENTION_MS = 30 * 60 * 1000; // exited commands stay queryable
// Large on purpose: a busy agent runs dozens of commands per turn (polls,
// scans, installs) across concurrent turns. Worst case 256 x 64KB rings is
// ~16MB, and typical output is far smaller.
const MAX_RETAINED_COMMANDS = 256;

interface RetainedCommand {
  history: string;
  pid?: number;
  exitCode?: number | null;
  exitedAt?: number;
  retentionTimer?: ReturnType<typeof setTimeout>;
}

export class CommandHistory {
  private readonly commands = new Map<string, RetainedCommand>();

  /** Register a command when it starts so status queries work while running. */
  start(commandId: string, pid?: number): void {
    const existing = this.commands.get(commandId);
    if (existing?.retentionTimer) {
      clearTimeout(existing.retentionTimer);
    }
    this.commands.set(commandId, { history: "", pid });
    this.enforceCap(commandId);
  }

  /** Append an output chunk (stdout or stderr) to the retained ring. */
  append(commandId: string, chunk: string): void {
    let entry = this.commands.get(commandId);
    if (!entry) {
      entry = { history: "" };
      this.commands.set(commandId, entry);
      this.enforceCap(commandId);
    }
    entry.history += chunk;
    if (entry.history.length > HISTORY_MAX_BYTES) {
      entry.history = entry.history.slice(-HISTORY_MAX_BYTES);
    }
  }

  /** Record the exit; the entry stays queryable for the retention window. */
  recordExit(commandId: string, exitCode: number | null): void {
    let entry = this.commands.get(commandId);
    if (!entry) {
      entry = { history: "" };
      this.commands.set(commandId, entry);
      this.enforceCap(commandId);
    }
    entry.exitCode = exitCode;
    entry.exitedAt = Date.now();
    if (entry.retentionTimer) clearTimeout(entry.retentionTimer);
    const timer = setTimeout(() => {
      this.commands.delete(commandId);
    }, COMMAND_RETENTION_MS);
    // Guarded: jest fake timers return objects without unref.
    (timer as unknown as { unref?: () => void }).unref?.();
    entry.retentionTimer = timer;
  }

  getStatus(commandId: string): CommandStatus {
    const entry = this.commands.get(commandId);
    if (!entry) return { status: "unknown" };
    const outputTail = entry.history.slice(-STATUS_TAIL_BYTES);
    if (entry.exitedAt !== undefined) {
      return {
        status: "exited",
        ...(entry.pid !== undefined ? { pid: entry.pid } : {}),
        exitCode: entry.exitCode ?? null,
        ...(outputTail ? { outputTail } : {}),
      };
    }
    return {
      status: "running",
      ...(entry.pid !== undefined ? { pid: entry.pid } : {}),
      ...(outputTail ? { outputTail } : {}),
    };
  }

  dispose(): void {
    for (const entry of this.commands.values()) {
      if (entry.retentionTimer) clearTimeout(entry.retentionTimer);
    }
    this.commands.clear();
  }

  private enforceCap(exceptId: string): void {
    // Evict ONLY exited entries, oldest first. A running command must stay
    // queryable: a later turn re-attaches to it via command_status, and
    // evicting it mid-run makes the session unrecoverable. If every entry
    // is still running, allow a temporary overflow — running commands are
    // bounded by real concurrency, and the next start() after one exits
    // trims the store back down.
    while (this.commands.size > MAX_RETAINED_COMMANDS) {
      let oldestExited: string | undefined;
      for (const [id, entry] of this.commands) {
        if (id === exceptId) continue;
        if (entry.exitedAt !== undefined) {
          oldestExited = id;
          break;
        }
      }
      if (oldestExited === undefined) break;
      const entry = this.commands.get(oldestExited);
      if (entry?.retentionTimer) clearTimeout(entry.retentionTimer);
      this.commands.delete(oldestExited);
    }
  }
}
