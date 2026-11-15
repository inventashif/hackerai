/**
 * CoArena provider, calling https://coarena.ai/api/v1 directly in code.
 *
 * There is no separate proxy process: the key-rotation behavior of the
 * standalone CoArena gateway (round-robin across API keys, per-key
 * cooldowns on quota/rate/auth/5xx, rotate on network stalls) is ported
 * here into a fetch wrapper, so the AI SDK owns streaming, tool-call
 * assembly, and usage accounting against the rotated upstream.
 *
 * Keys come from `COARENA_API_KEYS` (comma- or newline-separated, `#`
 * comments and blanks ignored). Rotation state is module-level and
 * in-memory: on serverless runtimes each instance rotates independently
 * and the cursor resets on cold start, which still distributes load.
 * Never log key values; diagnostics use key indexes only.
 *
 * Server-only: never import from client components.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { getCoarenaModelId } from "./coarena-models";

export const DEFAULT_COARENA_BASE_URL = "https://coarena.ai/api/v1";

/** Base URL of CoArena's OpenAI-compatible API, without a trailing slash. */
export function getCoarenaBaseURL(): string {
  const configured = process.env.COARENA_BASE_URL?.trim();
  return (configured || DEFAULT_COARENA_BASE_URL).replace(/\/+$/, "");
}

/**
 * API keys from the environment. Parsed per call so a late-arriving env
 * still works; splitting a short string is negligible next to a network
 * round trip. Values are secrets: never log, serialize, or expose them.
 */
export function getCoarenaApiKeys(): string[] {
  const raw = process.env.COARENA_API_KEYS ?? "";
  return raw
    .split(/[\r\n,]+/)
    .map((key) => key.trim())
    .filter((key) => key.length > 0 && !key.startsWith("#"));
}

/** Synchronous config check. Only tells us keys are present, not that CoArena is reachable. */
export function isCoarenaEnabled(): boolean {
  return getCoarenaApiKeys().length > 0;
}

// 401/403 bad key, 402 payment, 408 timeout, 409 idempotency collision,
// 425 too early, 429 quota/rate, 5xx upstream trouble. All mean "try next key".
const RETRY_STATUS = new Set([
  401, 402, 403, 408, 409, 425, 429, 500, 501, 502, 503, 504,
]);
const DEFAULT_COOLDOWN_MS = 15000;
const MAX_ERROR_BODY = 64 * 1024;

let cursor = 0;
// Cooldowns keyed by key INDEX, never by key value.
const cooldownUntil = new Map<number, number>();

function candidateOrder(keyCount: number): number[] {
  const now = Date.now();
  // Reserve the next slot up front: concurrent requests must not all start
  // from the same key.
  const start = cursor % keyCount;
  cursor = (start + 1) % keyCount;
  const rotated = Array.from(
    { length: keyCount },
    (_, index) => (start + index) % keyCount,
  );
  const ready = rotated.filter(
    (index) => (cooldownUntil.get(index) || 0) <= now,
  );
  if (ready.length > 0) return ready;
  // Every key is cooling: still try them, soonest-to-recover first.
  // Cooldowns are a hint, not the source of truth.
  return rotated
    .slice()
    .sort((a, b) => (cooldownUntil.get(a) || 0) - (cooldownUntil.get(b) || 0));
}

function retryAfterMs(headers: Headers): number {
  const raw = headers.get("retry-after");
  if (!raw) return DEFAULT_COOLDOWN_MS;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.max(seconds * 1000, 1000), 3600000);
  }
  const at = Date.parse(raw);
  if (Number.isFinite(at)) {
    return Math.min(Math.max(at - Date.now(), 1000), 3600000);
  }
  return DEFAULT_COOLDOWN_MS;
}

// Cooldown length depends on WHY the key failed. A daily quota refusal with
// a multi-hour Retry-After must not bench a key long enough to stall
// everything, and a transient 5xx should recover almost immediately.
function cooldownFor(
  status: number,
  headers: Headers,
  bodyText: string,
): { ms: number; code: string | null } {
  let code: string | null = null;
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { code?: unknown; type?: unknown };
    };
    const raw = parsed?.error?.code ?? parsed?.error?.type;
    code = typeof raw === "string" ? raw : null;
  } catch {
    // Non-JSON error body: no code hint.
  }
  const hinted = retryAfterMs(headers);
  let ms = hinted;
  if (code === "insufficient_quota") {
    ms = Math.min(Math.max(hinted, 30000), 120000);
  } else if (status === 429) {
    ms = Math.min(hinted, 30000);
  } else if (status >= 500) {
    ms = Math.min(hinted, 10000);
  } else {
    ms = Math.min(hinted, 60000);
  }
  return { ms, code };
}

function isAbort(error: unknown, signal?: AbortSignal | null): boolean {
  return (
    Boolean(signal?.aborted) ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: unknown }).name === "AbortError")
  );
}

/**
 * Fetch wrapper that rotates CoArena API keys per attempt. On a retryable
 * status or a network failure it cools the key down and retries with the
 * next candidate; a non-retryable response streams straight through to
 * the AI SDK untouched. Retries only happen before the response body is
 * consumed, so a mid-stream failure surfaces to the caller like any other
 * streaming error. The request body must be reusable (string or absent)
 * for retries; anything else gets a single attempt.
 */
export const coarenaRotatingFetch: typeof fetch = async (url, init) => {
  const keys = getCoarenaApiKeys();
  if (keys.length === 0) {
    throw new Error(
      "No CoArena API keys configured. Set COARENA_API_KEYS (comma- or newline-separated) to use CoArena models.",
    );
  }
  const bodyReusable =
    init?.body == null || typeof init.body === "string";
  const order = candidateOrder(keys.length);
  const attempts = bodyReusable ? order : order.slice(0, 1);
  const method = init?.method ?? "GET";
  const path = (() => {
    try {
      return new URL(url.toString()).pathname;
    } catch {
      return String(url);
    }
  })();

  let lastFailure: {
    status: number;
    bodyText: string;
    contentType: string | null;
    retryAfter: string | null;
  } | null = null;

  for (let attempt = 0; attempt < attempts.length; attempt += 1) {
    const keyIndex = attempts[attempt];
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${keys[keyIndex]}`);
    let response: Response;
    try {
      response = await globalThis.fetch(url, { ...init, headers });
    } catch (error) {
      // The caller gave up: do not cool the key or rotate.
      if (isAbort(error, init?.signal)) throw error;
      cooldownUntil.set(keyIndex, Date.now() + DEFAULT_COOLDOWN_MS);
      console.error(
        `[coarena] ${method} ${path} try#${attempt + 1} key#${keyIndex + 1} network: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
      lastFailure = {
        status: 502,
        bodyText: JSON.stringify({
          error: {
            message: `CoArena upstream error: ${error instanceof Error ? error.message : "unknown error"}`,
            type: "api_error",
            code: "upstream_error",
          },
        }),
        contentType: "application/json",
        retryAfter: null,
      };
      continue;
    }

    if (!RETRY_STATUS.has(response.status)) {
      return response;
    }

    const bodyText = (await response.text()).slice(0, MAX_ERROR_BODY);
    const { ms, code } = cooldownFor(response.status, response.headers, bodyText);
    cooldownUntil.set(keyIndex, Date.now() + ms);
    console.error(
      `[coarena] ${method} ${path} try#${attempt + 1} key#${keyIndex + 1} -> ${response.status}${code ? ` ${code}` : ""} (rotating, ${Math.round(ms / 1000)}s cooldown)`,
    );
    lastFailure = {
      status: response.status,
      bodyText,
      contentType: response.headers.get("content-type"),
      retryAfter: response.headers.get("retry-after"),
    };
  }

  // Every key failed: reply with a clean, self-consistent body built from
  // the last failure. Never return a drained response stream.
  const failure = lastFailure ?? {
    status: 502,
    bodyText: JSON.stringify({
      error: {
        message: "All CoArena keys failed",
        type: "api_error",
        code: "all_keys_failed",
      },
    }),
    contentType: "application/json",
    retryAfter: null,
  };
  const outHeaders = new Headers({
    "content-type": failure.contentType || "application/json",
  });
  if (failure.retryAfter) outHeaders.set("retry-after", failure.retryAfter);
  return new Response(failure.bodyText, {
    status: failure.status,
    headers: outHeaders,
  });
};

let cachedClient: ReturnType<typeof createOpenAI> | null = null;
let cachedBaseURL: string | null = null;

function getClient(): ReturnType<typeof createOpenAI> {
  const baseURL = getCoarenaBaseURL();
  if (!cachedClient || cachedBaseURL !== baseURL) {
    cachedClient = createOpenAI({
      name: "coarena",
      // Placeholder only: the rotating fetch replaces the Authorization
      // header on every attempt, so this value never reaches upstream.
      // A placeholder keeps model construction lazy-safe when no keys are
      // configured; requests then fail at call time with a clear error.
      apiKey: "coarena-rotating-keys",
      baseURL,
      fetch: coarenaRotatingFetch,
    });
    cachedBaseURL = baseURL;
  }
  return cachedClient;
}

/** Probe CoArena. Used by `/api/coarena/status` to decide visibility. */
export async function isCoarenaAvailable(
  signal?: AbortSignal,
): Promise<boolean> {
  if (!isCoarenaEnabled()) return false;
  try {
    const res = await coarenaRotatingFetch(`${getCoarenaBaseURL()}/models`, {
      cache: "no-store",
      signal,
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function createCoarenaProvider() {
  return (modelKey: string) => {
    const client = getClient();
    return client.chat(
      getCoarenaModelId(modelKey) as Parameters<typeof client.chat>[0],
    );
  };
}
