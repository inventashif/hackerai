/**
 * Durable PTY session registry (Redis-backed).
 *
 * The in-memory PtySessionManager lives only on the function instance that
 * created a session. On serverless, the next turn usually lands on a
 * different instance, so `interact_terminal_session` reported "Session not
 * found" and the agent re-ran long commands from scratch. This registry
 * persists the minimum needed to re-attach: the agent-side session key
 * (handle UUID), the sandbox identity, and the command metadata. The
 * sandbox-side PTY itself outlives any server instance — the agent process
 * owns it — so a fresh instance can subscribe to the same channel, query
 * `pty_status`, and resume the session.
 *
 * Best-effort by design: every operation fails soft (logs, returns null)
 * when Redis is unconfigured or unreachable, and callers fall back to the
 * previous in-memory-only behavior.
 */

import { createRedisClient } from "@/lib/rate-limit/redis";
import type { AgentApprovalSandboxIdentity } from "@/types";

export interface PtySessionRecord {
  /** Agent-side session key (the handle UUID the runner knows). */
  handleUuid: string;
  /** Model-facing 8-char id from PtySessionManager. */
  managerId: string;
  chatId: string;
  sandboxIdentity: AgentApprovalSandboxIdentity;
  originalCommand: string;
  workingDirectory?: string;
  kind: "pty" | "command";
  pid: number;
  createdAt: number;
  cols: number;
  rows: number;
}

const KEY_PREFIX = "pty-session:";
const RECORD_TTL_SECONDS = 60 * 60; // SESSION_MAX_LIFETIME_MS

function keyFor(chatId: string, managerId: string): string {
  return `${KEY_PREFIX}${chatId}:${managerId}`;
}

export async function savePtySessionRecord(
  record: PtySessionRecord,
): Promise<void> {
  try {
    const redis = createRedisClient();
    if (!redis) return;
    await redis.set(keyFor(record.chatId, record.managerId), record, {
      ex: RECORD_TTL_SECONDS,
    });
  } catch (err) {
    console.error("[pty-session-registry] save failed:", err);
  }
}

export async function loadPtySessionRecord(
  chatId: string,
  managerId: string,
): Promise<PtySessionRecord | null> {
  try {
    const redis = createRedisClient();
    if (!redis) return null;
    const value = await redis.get<PtySessionRecord>(
      keyFor(chatId, managerId),
    );
    if (!value || typeof value !== "object") return null;
    if (typeof value.handleUuid !== "string" || !value.handleUuid) {
      return null;
    }
    return value;
  } catch (err) {
    console.error("[pty-session-registry] load failed:", err);
    return null;
  }
}

export async function deletePtySessionRecord(
  chatId: string,
  managerId: string,
): Promise<void> {
  try {
    const redis = createRedisClient();
    if (!redis) return;
    await redis.del(keyFor(chatId, managerId));
  } catch (err) {
    console.error("[pty-session-registry] delete failed:", err);
  }
}
