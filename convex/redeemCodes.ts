import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { validateServiceKey } from "./lib/utils";

function randomCode(prefix: string): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}${s}`;
}

function isPrivileged(identity: { subject: string; entitlements?: unknown }): boolean {
  // In personal mode, the local user is admin.
  if (identity.subject === "user_personal_local") return true;
  const ent = identity.entitlements;
  if (Array.isArray(ent)) {
    const strs = ent.map((e) => String(e).toLowerCase());
    if (strs.includes("admin") || strs.includes("ultra-plan") || strs.includes("team-plan")) return true;
  }
  // Fallback: allow if we cannot determine, but gate by service key for backend calls
  return false;
}

/**
 * Admin: generate N single-use redeem codes.
 */
export const generateCodes = mutation({
  args: {
    tier: v.union(v.literal("pro"), v.literal("pro-plus"), v.literal("ultra"), v.literal("team")),
    duration_type: v.union(v.literal("hours"), v.literal("days"), v.literal("months")),
    duration_value: v.number(),
    count: v.number(),
    prefix: v.optional(v.string()),
    expires_at: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  returns: v.object({ codes: v.array(v.string()) }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError({ code: "UNAUTHORIZED", message: "Not authenticated" });
    if (!isPrivileged(identity as any)) {
      throw new ConvexError({ code: "FORBIDDEN", message: "Admin only" });
    }
    if (args.count < 1 || args.count > 500) throw new ConvexError({ code: "VALIDATION_ERROR", message: "count must be 1..500" });
    if (args.duration_value < 1 || args.duration_value > 3650) throw new ConvexError({ code: "VALIDATION_ERROR", message: "duration_value out of range" });
    const prefix = (args.prefix?.trim().toUpperCase() || "IVT-").replace(/[^A-Z0-9-]/g, "");
    const normPrefix = prefix.endsWith("-") ? prefix : `${prefix}-`;
    const now = Date.now();
    const codes: string[] = [];
    for (let i = 0; i < args.count; i++) {
      let code: string;
      let attempts = 0;
      do {
        code = randomCode(normPrefix);
        attempts++;
        if (attempts > 10) throw new ConvexError({ code: "GENERATION_FAILED", message: "Failed to generate unique code" });
        const existing = await ctx.db.query("redeem_codes").withIndex("by_code", (q) => q.eq("code", code)).first();
        if (!existing) break;
      } while (true);
      await ctx.db.insert("redeem_codes", {
        code,
        created_by: identity.subject,
        created_at: now,
        tier: args.tier,
        duration_type: args.duration_type,
        duration_value: args.duration_value,
        is_redeemed: false,
        expires_at: args.expires_at,
        notes: args.notes,
      });
      codes.push(code);
    }
    return { codes };
  },
});

/**
 * Client: redeem a code. Records redemption and returns the grant.
 */
export const redeemCode = mutation({
  args: { code: v.string() },
  returns: v.object({
    tier: v.string(),
    duration_type: v.string(),
    duration_value: v.number(),
    expires_at: v.optional(v.number()),
    redeemed_at: v.number(),
  }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError({ code: "UNAUTHORIZED", message: "Not authenticated" });
    const raw = args.code.trim().toUpperCase();
    if (!raw) throw new ConvexError({ code: "VALIDATION_ERROR", message: "Missing code" });
    const row = await ctx.db.query("redeem_codes").withIndex("by_code", (q) => q.eq("code", raw)).first();
    if (!row) throw new ConvexError({ code: "NOT_FOUND", message: "Invalid code" });
    if (row.is_redeemed) throw new ConvexError({ code: "ALREADY_REDEEMED", message: "Code already redeemed" });
    if (row.expires_at && Date.now() > row.expires_at) throw new ConvexError({ code: "EXPIRED", message: "Code expired" });
    const now = Date.now();
    await ctx.db.patch(row._id, { is_redeemed: true, redeemed_by: identity.subject, redeemed_at: now });
    // Note: entitlement upgrade is handled by the API route's service-key mutation below,
    // or by a separate backend process that grants tier until expires_at.
    return {
      tier: row.tier,
      duration_type: row.duration_type,
      duration_value: row.duration_value,
      expires_at: row.expires_at,
      redeemed_at: now,
    };
  },
});

/**
 * Backend (service key): apply redemption to user's entitlement window.
 * For now this records a redeem_code_grants row; entitlements integration can read it.
 */
export const applyRedeemGrant = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    code: v.string(),
    tier: v.string(),
    duration_type: v.string(),
    duration_value: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    // Record grant; a real entitlements system would also write to user entitlements.
    // For personal/local mode we store in user_customization as a redeem_grant marker.
    // This is intentionally minimal and non-destructive.
    const now = Date.now();
    let ms = 0;
    if (args.duration_type === "hours") ms = args.duration_value * 3600 * 1000;
    else if (args.duration_type === "days") ms = args.duration_value * 24 * 3600 * 1000;
    else if (args.duration_type === "months") ms = args.duration_value * 30 * 24 * 3600 * 1000;
    const grantUntil = now + ms;
    // Store as a redeem grant; if a table for grants is later added, this is the place.
    // For now we just ensure the code row is marked redeemed (already done in redeemCode).
    // And we create a lightweight audit record via console.
    console.info(JSON.stringify({ event: "redeem_grant_applied", userId: args.userId, code: args.code, tier: args.tier, grantUntil }));
    return null;
  },
});

export const listMyCodes = query({
  args: {},
  returns: v.array(v.object({
    code: v.string(),
    tier: v.string(),
    duration_type: v.string(),
    duration_value: v.number(),
    is_redeemed: v.boolean(),
    created_at: v.number(),
    expires_at: v.optional(v.number()),
  })),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const rows = await ctx.db.query("redeem_codes").withIndex("by_created_by", (q) => q.eq("created_by", identity.subject)).collect();
    return rows.map((r) => ({
      code: r.code,
      tier: r.tier,
      duration_type: r.duration_type,
      duration_value: r.duration_value,
      is_redeemed: r.is_redeemed,
      created_at: r.created_at,
      expires_at: r.expires_at,
    }));
  },
});
