import * as os from "os";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface ProcessRunOptions {
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export interface ProcessRunResult {
  pid: number;
}

/** Answer to a `pty_status` query from a (possibly new) server instance. */
export interface PtySessionStatus {
  status: "running" | "exited" | "unknown";
  pid?: number;
  exitCode?: number | null;
  /** Last STATUS_TAIL_BYTES of retained output (empty when nothing kept). */
  outputTail?: string;
}

export interface ProcessRunnerEvents {
  data: (sessionId: string, data: string) => void;
  exit: (sessionId: string, exitCode: number) => void;
  error: (sessionId: string, error: Error) => void;
}

interface PtyProcess {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode?: number }) => void): void;
}

interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
    },
  ): PtyProcess;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FLUSH_INTERVAL_MS = 16;
const FLUSH_THRESHOLD_BYTES = 32 * 1024; // 32 KB
const SIGTERM_GRACE_MS = 5_000;
// Retained PTY history: the flush buffer above is emptied on every publish,
// so a server that attaches to an existing session later would see nothing.
// Keep a bounded ring of all output per session plus the exit record, so a
// pty_status query can backfill a re-attaching server with the tail.
const HISTORY_MAX_BYTES = 64 * 1024; // 64 KB ring per session
const STATUS_TAIL_BYTES = 16 * 1024; // bytes returned by a status query
const SESSION_RETENTION_MS = 30 * 60 * 1000; // exited sessions stay queryable
const MAX_RETAINED_SESSIONS = 32;
// Hard cap on a PTY session's life: the server detaches (rather than kills)
// sessions at turn end so later turns can re-attach, so the agent itself
// must bound how long an abandoned session can run.
const PTY_MAX_LIFETIME_MS = 60 * 60 * 1000;
export const NODE_PTY_UNAVAILABLE_MESSAGE =
  "Interactive terminal sessions are unavailable because node-pty could not be loaded. Non-interactive commands still work.";

const isExpectedAlreadyStoppedKillError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const text = [record.name, record.message, record.code]
    .filter((value) => typeof value === "string" || typeof value === "number")
    .join(" ");
  return /\b(?:ESRCH|already (?:exited|gone|killed|stopped)|no such process|not[_\s-]?found)\b/i.test(
    text,
  );
};

export function isPtyAvailable(): boolean {
  try {
    require("node-pty");
    return true;
  } catch {
    return false;
  }
}

function loadPty(): PtyModule {
  try {
    return require("node-pty") as PtyModule;
  } catch (error: unknown) {
    const cause = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(`${NODE_PTY_UNAVAILABLE_MESSAGE}${cause}`);
  }
}

// ---------------------------------------------------------------------------
// ProcessRunner
// ---------------------------------------------------------------------------

export class ProcessRunner {
  private readonly activeProcesses: Map<string, PtyProcess> = new Map();
  private readonly outputBuffers: Map<string, string> = new Map();
  private readonly killTimers: Map<string, NodeJS.Timeout> = new Map();
  /** Bounded ring of ALL output per session (unlike outputBuffers, never flushed away). */
  private readonly historyBuffers: Map<string, string> = new Map();
  private readonly sessionPids: Map<string, number> = new Map();
  private readonly exitedSessions: Map<
    string,
    { exitCode: number; exitedAt: number }
  > = new Map();
  private readonly retentionTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly lifetimeTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly listeners: Map<
    keyof ProcessRunnerEvents,
    ProcessRunnerEvents[keyof ProcessRunnerEvents]
  > = new Map();
  private flushTimer: NodeJS.Timeout | undefined;

  constructor() {
    this.flushTimer = setInterval(() => this.flushAll(), FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
  }

  // -----------------------------------------------------------------------
  // Event registration
  // -----------------------------------------------------------------------

  on<K extends keyof ProcessRunnerEvents>(
    event: K,
    listener: ProcessRunnerEvents[K],
  ): void {
    this.listeners.set(event, listener);
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  run(
    sessionId: string,
    command: string,
    opts: ProcessRunOptions = {},
  ): ProcessRunResult {
    const cwd = opts.cwd ?? process.cwd();
    const cols = opts.cols ?? 120;
    const rows = opts.rows ?? 40;

    const shell = os.platform() === "darwin" ? "/bin/zsh" : "/bin/bash";

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TERM: "xterm-256color",
    };

    if (opts.env) {
      Object.assign(env, opts.env);
    }

    const pty = loadPty();
    const proc = pty.spawn(shell, ["-l", "-c", command], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env,
    });

    this.activeProcesses.set(sessionId, proc);
    this.outputBuffers.set(sessionId, "");
    this.historyBuffers.set(sessionId, "");
    this.sessionPids.set(sessionId, proc.pid);
    this.exitedSessions.delete(sessionId);
    this.clearRetentionTimer(sessionId);
    this.clearLifetimeTimer(sessionId);
    const lifetimeTimer = setTimeout(() => {
      this.lifetimeTimers.delete(sessionId);
      this.stop(sessionId);
    }, PTY_MAX_LIFETIME_MS);
    lifetimeTimer.unref?.();
    this.lifetimeTimers.set(sessionId, lifetimeTimer);

    proc.onData((data: string) => {
      const current = this.outputBuffers.get(sessionId) ?? "";
      const updated = current + data;
      this.outputBuffers.set(sessionId, updated);
      this.appendHistory(sessionId, data);

      if (updated.length >= FLUSH_THRESHOLD_BYTES) {
        this.flush(sessionId);
      }
    });

    proc.onExit(({ exitCode }) => {
      this.flush(sessionId);
      this.activeProcesses.delete(sessionId);
      this.outputBuffers.delete(sessionId);
      this.clearKillTimer(sessionId);
      this.clearLifetimeTimer(sessionId);
      // Retain history + exit record so a later server instance can attach
      // and learn the outcome instead of seeing "session not found".
      const code = exitCode ?? -1;
      this.exitedSessions.set(sessionId, { exitCode: code, exitedAt: Date.now() });
      this.evictOldRetainedSessions();
      this.armRetentionTimer(sessionId);
      this.emit("exit", sessionId, code);
    });

    return { pid: proc.pid };
  }

  write(sessionId: string, data: string): boolean {
    const proc = this.activeProcesses.get(sessionId);
    if (!proc) {
      return false;
    }
    proc.write(data);
    return true;
  }

  resize(sessionId: string, cols: number, rows: number): boolean {
    const proc = this.activeProcesses.get(sessionId);
    if (!proc) {
      return false;
    }
    proc.resize(cols, rows);
    return true;
  }

  stop(sessionId: string, _signal?: string): boolean {
    const proc = this.activeProcesses.get(sessionId);
    if (!proc) {
      return false;
    }

    if (!this.killProcess(sessionId, proc, "SIGTERM")) {
      return false;
    }

    const timer = setTimeout(() => {
      if (!this.activeProcesses.has(sessionId)) {
        this.clearKillTimer(sessionId);
        return;
      }

      try {
        if (this.killProcess(sessionId, proc, "SIGKILL")) {
          this.activeProcesses.delete(sessionId);
          this.outputBuffers.delete(sessionId);
        }
      } catch {
        // killProcess already emitted the error event.
      } finally {
        this.clearKillTimer(sessionId);
      }
    }, SIGTERM_GRACE_MS);
    this.killTimers.set(sessionId, timer);

    return true;
  }

  stopAll(): void {
    for (const sessionId of this.activeProcesses.keys()) {
      this.stop(sessionId);
    }
  }

  isRunning(sessionId: string): boolean {
    return this.activeProcesses.has(sessionId);
  }

  /**
   * Status for a `pty_status` query: running sessions report their pid and
   * retained tail; exited sessions report their exit code and tail for
   * SESSION_RETENTION_MS after exit; anything else is unknown.
   */
  getStatus(sessionId: string): PtySessionStatus {
    const history = this.historyBuffers.get(sessionId) ?? "";
    const outputTail =
      history.length > 0 ? history.slice(-STATUS_TAIL_BYTES) : "";
    const pid = this.sessionPids.get(sessionId);
    if (this.activeProcesses.has(sessionId)) {
      return { status: "running", pid, outputTail };
    }
    const exited = this.exitedSessions.get(sessionId);
    if (exited) {
      return {
        status: "exited",
        pid,
        exitCode: exited.exitCode,
        outputTail,
      };
    }
    return { status: "unknown" };
  }

  dispose(): void {
    this.stopAll();
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    for (const timer of this.killTimers.values()) {
      clearTimeout(timer);
    }
    this.killTimers.clear();
    for (const timer of this.retentionTimers.values()) {
      clearTimeout(timer);
    }
    this.retentionTimers.clear();
    for (const timer of this.lifetimeTimers.values()) {
      clearTimeout(timer);
    }
    this.lifetimeTimers.clear();
    this.historyBuffers.clear();
    this.sessionPids.clear();
    this.exitedSessions.clear();
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private emit<K extends keyof ProcessRunnerEvents>(
    event: K,
    ...args: Parameters<ProcessRunnerEvents[K]>
  ): void {
    const listener = this.listeners.get(event) as
      | ProcessRunnerEvents[K]
      | undefined;
    if (listener) {
      (listener as (...a: Parameters<ProcessRunnerEvents[K]>) => void)(...args);
    }
  }

  private flush(sessionId: string): void {
    const buffer = this.outputBuffers.get(sessionId);
    if (!buffer || buffer.length === 0) {
      return;
    }
    this.outputBuffers.set(sessionId, "");
    this.emit("data", sessionId, buffer);
  }

  private flushAll(): void {
    for (const sessionId of this.outputBuffers.keys()) {
      this.flush(sessionId);
    }
  }

  private killProcess(
    sessionId: string,
    proc: PtyProcess,
    signal: string,
  ): boolean {
    try {
      proc.kill(signal);
      return true;
    } catch (error) {
      if (!isExpectedAlreadyStoppedKillError(error)) {
        this.emit(
          "error",
          sessionId,
          error instanceof Error ? error : new Error(String(error)),
        );
        throw error;
      }

      this.activeProcesses.delete(sessionId);
      this.outputBuffers.delete(sessionId);
      this.clearKillTimer(sessionId);
      return false;
    }
  }

  private clearKillTimer(sessionId: string): void {
    const timer = this.killTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.killTimers.delete(sessionId);
    }
  }

  private appendHistory(sessionId: string, data: string): void {
    const updated = (this.historyBuffers.get(sessionId) ?? "") + data;
    this.historyBuffers.set(
      sessionId,
      updated.length > HISTORY_MAX_BYTES
        ? updated.slice(-HISTORY_MAX_BYTES)
        : updated,
    );
  }

  private armRetentionTimer(sessionId: string): void {
    this.clearRetentionTimer(sessionId);
    const timer = setTimeout(() => {
      this.retentionTimers.delete(sessionId);
      this.historyBuffers.delete(sessionId);
      this.sessionPids.delete(sessionId);
      this.exitedSessions.delete(sessionId);
    }, SESSION_RETENTION_MS);
    // unref is absent on some timer fakes (jest); the agent is long-lived
    // anyway, so this is only a politeness for short-lived hosts.
    timer.unref?.();
    this.retentionTimers.set(sessionId, timer);
  }

  private clearRetentionTimer(sessionId: string): void {
    const timer = this.retentionTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.retentionTimers.delete(sessionId);
    }
  }

  private clearLifetimeTimer(sessionId: string): void {
    const timer = this.lifetimeTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.lifetimeTimers.delete(sessionId);
    }
  }

  private evictOldRetainedSessions(): void {
    if (this.exitedSessions.size <= MAX_RETAINED_SESSIONS) return;
    const oldest = Array.from(this.exitedSessions.entries())
      .sort((a, b) => a[1].exitedAt - b[1].exitedAt)
      .slice(0, this.exitedSessions.size - MAX_RETAINED_SESSIONS);
    for (const [sessionId] of oldest) {
      this.clearRetentionTimer(sessionId);
      this.historyBuffers.delete(sessionId);
      this.sessionPids.delete(sessionId);
      this.exitedSessions.delete(sessionId);
    }
  }
}
