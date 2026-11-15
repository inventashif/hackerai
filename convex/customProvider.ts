import { mutation, query } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { validateServiceKey } from "./lib/utils";

const MAX_BASE_URL_LENGTH = 2048;
const MAX_API_KEY_LENGTH = 4096;
const MAX_MODEL_ID_LENGTH = 256;

/**
 * Validate and normalize a user-supplied OpenAI-compatible base URL.
 * Mirrors the check in `app/api/custom-provider/models/route.ts` (kept
 * duplicated: Convex modules cannot import from `lib/`).
 * Rejects non-http(s) schemes and loopback / private-network hosts so a
 * saved config can never turn the server into a probe of internal networks.
 */
function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_BASE_URL_LENGTH) {
    throw new ConvexError({
      code: "VALIDATION_ERROR",
      message: "Base URL must be between 1 and 2048 characters",
    });
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ConvexError({
      code: "VALIDATION_ERROR",
      message: "Base URL must be a valid http(s) URL",
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConvexError({
      code: "VALIDATION_ERROR",
      message: "Base URL must use http or https",
    });
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopbackOrPrivate =
    host === "localhost" ||
    host === "[::1]" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  if (isLoopbackOrPrivate) {
    throw new ConvexError({
      code: "VALIDATION_ERROR",
      message: "Base URL must be a public host, not localhost or a private address",
    });
  }
  return trimmed.replace(/\/+$/, "");
}

/**
 * Client-safe view of the user's custom provider config. Never returns the
 * API key value — only whether one is stored.
 */
export const getCustomProviderConfig = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      baseUrl: v.string(),
      modelId: v.string(),
      hasKey: v.boolean(),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: User not authenticated",
      });
    }
    const existing = await ctx.db
      .query("custom_provider_configs")
      .withIndex("by_user_id", (q) => q.eq("user_id", identity.subject))
      .first();
    if (!existing) return null;
    return {
      baseUrl: existing.base_url,
      modelId: existing.model_id,
      hasKey: existing.api_key.length > 0,
      updatedAt: existing.updated_at,
    };
  },
});

/**
 * Backend-only: full config including the API key, for the chat request
 * path. Guarded by the service key like the other *ForBackend functions.
 * Never call this from client code.
 */
export const getCustomProviderConfigForBackend = query({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      baseUrl: v.string(),
      apiKey: v.string(),
      modelId: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    const existing = await ctx.db
      .query("custom_provider_configs")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.userId))
      .first();
    if (!existing) return null;
    return {
      baseUrl: existing.base_url,
      apiKey: existing.api_key,
      modelId: existing.model_id,
    };
  },
});

export const saveCustomProviderConfig = mutation({
  args: {
    baseUrl: v.string(),
    apiKey: v.optional(v.string()),
    modelId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: User not authenticated",
      });
    }
    const baseUrl = normalizeBaseUrl(args.baseUrl);
    const modelId = args.modelId.trim();
    if (!modelId || modelId.length > MAX_MODEL_ID_LENGTH) {
      throw new ConvexError({
        code: "VALIDATION_ERROR",
        message: "Model ID must be between 1 and 256 characters",
      });
    }
    const existing = await ctx.db
      .query("custom_provider_configs")
      .withIndex("by_user_id", (q) => q.eq("user_id", identity.subject))
      .first();
    // An omitted/empty key keeps the stored key (key rotation is explicit);
    // a first-time save requires one.
    const apiKey = args.apiKey?.trim() || undefined;
    if (!apiKey && !existing) {
      throw new ConvexError({
        code: "VALIDATION_ERROR",
        message: "API key is required",
      });
    }
    if (apiKey && apiKey.length > MAX_API_KEY_LENGTH) {
      throw new ConvexError({
        code: "VALIDATION_ERROR",
        message: `API key exceeds ${MAX_API_KEY_LENGTH} character limit`,
      });
    }
    if (existing) {
      await ctx.db.patch(existing._id, {
        base_url: baseUrl,
        ...(apiKey ? { api_key: apiKey } : {}),
        model_id: modelId,
        updated_at: Date.now(),
      });
    } else {
      await ctx.db.insert("custom_provider_configs", {
        user_id: identity.subject,
        base_url: baseUrl,
        api_key: apiKey as string,
        model_id: modelId,
        updated_at: Date.now(),
      });
    }
    return null;
  },
});

export const deleteCustomProviderConfig = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "Unauthorized: User not authenticated",
      });
    }
    const existing = await ctx.db
      .query("custom_provider_configs")
      .withIndex("by_user_id", (q) => q.eq("user_id", identity.subject))
      .first();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
    return null;
  },
});
