/**
 * Kiro provider, backed by the local Kiro Gateway.
 *
 * The gateway (https://github.com/.../kiro-gateway, run via `./start.sh`)
 * exposes an OpenAI-compatible surface over Kiro, including real incremental
 * SSE streaming and native tool calls. We therefore treat it as a plain
 * OpenAI-compatible endpoint via `createOpenAI` and let the AI SDK own
 * streaming, tool-call assembly, and usage accounting.
 *
 * This replaces an earlier hand-rolled `LanguageModelV2` that called
 * `runtime.<region>.kiro.dev/generateAssistantResponse` directly. That version
 * faked streaming by chunking a completed response, could not send tools, and
 * always reported zero token usage.
 *
 * Server-only: never import from client components.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { getKiroModelId } from "./kiro-models";

const DEFAULT_KIRO_GATEWAY_BASE_URL = "http://127.0.0.1:8002/v1";

/** Base URL of the gateway's OpenAI-compatible API, without a trailing slash. */
export function getKiroGatewayBaseURL(): string {
  const configured = process.env.KIRO_GATEWAY_BASE_URL?.trim();
  return (configured || DEFAULT_KIRO_GATEWAY_BASE_URL).replace(/\/+$/, "");
}

/** The gateway's `PROXY_API_KEY`. Absent means Kiro is not configured. */
export function getKiroGatewayApiKey(): string | undefined {
  return process.env.KIRO_GATEWAY_API_KEY?.trim() || undefined;
}

/**
 * Synchronous config check. Only tells us a key is present, not that the
 * gateway is reachable - use `isKiroAvailable()` for that.
 */
export function isKiroEnabled(): boolean {
  return Boolean(getKiroGatewayApiKey());
}

let cachedGateway: ReturnType<typeof createOpenAI> | null = null;
let cachedFingerprint: string | null = null;

function getGateway(): ReturnType<typeof createOpenAI> {
  const apiKey = getKiroGatewayApiKey();
  const baseURL = getKiroGatewayBaseURL();
  // Rebuild if env changed between calls (dev server hot reload, tests).
  const fingerprint = `${baseURL}::${apiKey ?? ""}`;
  if (!cachedGateway || cachedFingerprint !== fingerprint) {
    cachedGateway = createOpenAI({
      name: "kiro-gateway",
      // A placeholder keeps model construction lazy-safe. An unconfigured
      // gateway then fails at request time with the gateway's own 401 rather
      // than throwing during module import.
      apiKey: apiKey ?? "missing-kiro-gateway-api-key",
      baseURL,
    });
    cachedFingerprint = fingerprint;
  }
  return cachedGateway;
}

/** Probe the gateway. Used by `/api/kiro/models` to decide visibility. */
export async function isKiroAvailable(
  signal?: AbortSignal,
): Promise<boolean> {
  if (!isKiroEnabled()) return false;
  try {
    const res = await fetch(`${getKiroGatewayBaseURL()}/models`, {
      headers: { Authorization: `Bearer ${getKiroGatewayApiKey()}` },
      cache: "no-store",
      signal,
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function createKiroProvider() {
  return (modelKey: string) => {
    const gateway = getGateway();
    return gateway.chat(
      getKiroModelId(modelKey) as Parameters<typeof gateway.chat>[0],
    );
  };
}
