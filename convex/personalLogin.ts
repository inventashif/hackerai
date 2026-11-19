import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { validateServiceKey } from "./lib/utils";

// Atomic, shared across all Vercel instances. Never store submitted credentials.
export const consumeAttempt = mutation({
  args: { serviceKey: v.string(), clientKey: v.string() },
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const now = Date.now();
    const expired = await ctx.db
      .query("personal_login_limits")
      .withIndex("by_reset", (q) => q.lt("reset_at", now))
      .take(20);
    for (const row of expired) await ctx.db.delete(row._id);
    const limits = [
      { key: "personal:global", max: 100 },
      { key: `personal:ip:${args.clientKey}`, max: 10 },
    ];
    let retryAfter = 0;
    for (const limit of limits) {
      const row = await ctx.db
        .query("personal_login_limits")
        .withIndex("by_key", (q) => q.eq("key", limit.key))
        .unique();
      const active = row && row.reset_at > now;
      if (active && row.count >= limit.max)
        retryAfter = Math.max(
          retryAfter,
          Math.ceil((row.reset_at - now) / 1000),
        );
      else if (row)
        await ctx.db.patch(row._id, {
          count: active ? row.count + 1 : 1,
          reset_at: active ? row.reset_at : now + 300_000,
        });
      else
        await ctx.db.insert("personal_login_limits", {
          key: limit.key,
          count: 1,
          reset_at: now + 300_000,
        });
    }
    return { allowed: retryAfter === 0, retryAfter };
  },
});
export const createSession = mutation({
  args: {
    serviceKey: v.string(),
    sessionId: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    if (
      args.expiresAt <= Date.now() ||
      args.expiresAt > Date.now() + 8 * 3600_000
    )
      throw new Error("Invalid session expiry");
    const expired = await ctx.db
      .query("personal_login_sessions")
      .withIndex("by_expiry", (q) => q.lt("expires_at", Date.now()))
      .take(20);
    for (const row of expired) await ctx.db.delete(row._id);
    await ctx.db.insert("personal_login_sessions", {
      session_id: args.sessionId,
      expires_at: args.expiresAt,
    });
  },
});
export const validSession = query({
  args: { serviceKey: v.string(), sessionId: v.string() },
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await ctx.db
      .query("personal_login_sessions")
      .withIndex("by_session", (q) => q.eq("session_id", args.sessionId))
      .unique();
    return !!row && row.expires_at > Date.now();
  },
});
export const revokeSession = mutation({
  args: { serviceKey: v.string(), sessionId: v.string() },
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const row = await ctx.db
      .query("personal_login_sessions")
      .withIndex("by_session", (q) => q.eq("session_id", args.sessionId))
      .unique();
    if (row) await ctx.db.delete(row._id);
  },
});
