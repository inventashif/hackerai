/**
 * In-memory Publisher/Subscriber adapter for `resumable-stream`.
 *
 * Used as a fallback when Redis is not configured (local / personal-mode dev).
 * Data lives in module-level Maps so it survives across requests within the
 * same Next.js dev-server process, but is lost on restart — which is fine for
 * local development.
 */

import type { Publisher, Subscriber } from "resumable-stream/generic";

// ── Shared in-memory state ──────────────────────────────────────────────

const store = new Map<string, { value: string; expiresAt?: number }>();
const channels = new Map<string, Set<(message: string) => void>>();

const isExpired = (entry: { expiresAt?: number }) =>
  entry.expiresAt !== undefined && Date.now() > entry.expiresAt;

// ── Publisher ───────────────────────────────────────────────────────────

export function createInMemoryPublisher(): Publisher {
  return {
    async connect() {},

    async publish(channel: string, message: string): Promise<number> {
      const listeners = channels.get(channel);
      if (!listeners || listeners.size === 0) return 0;
      for (const cb of listeners) {
        try {
          cb(message);
        } catch {
          // Subscriber threw — ignore to avoid breaking the publisher.
        }
      }
      return listeners.size;
    },

    async set(
      key: string,
      value: string,
      options?: { EX?: number },
    ): Promise<"OK"> {
      store.set(key, {
        value,
        expiresAt:
          options?.EX !== undefined
            ? Date.now() + options.EX * 1000
            : undefined,
      });
      return "OK";
    },

    async get(key: string): Promise<string | null> {
      const entry = store.get(key);
      if (!entry) return null;
      if (isExpired(entry)) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },

    async incr(key: string): Promise<number> {
      const entry = store.get(key);
      const current =
        entry && !isExpired(entry) ? parseInt(entry.value, 10) || 0 : 0;
      const next = current + 1;
      store.set(key, {
        value: String(next),
        expiresAt: entry?.expiresAt,
      });
      return next;
    },
  };
}

// ── Subscriber ──────────────────────────────────────────────────────────

export function createInMemorySubscriber(): Subscriber {
  return {
    async connect() {},

    async subscribe(
      channel: string,
      callback: (message: string) => void,
    ): Promise<void> {
      let listeners = channels.get(channel);
      if (!listeners) {
        listeners = new Set();
        channels.set(channel, listeners);
      }
      listeners.add(callback);
    },

    async unsubscribe(channel: string): Promise<void> {
      channels.delete(channel);
    },
  };
}
