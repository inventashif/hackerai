/**
 * Custom OpenAI-compatible provider, configured per user in Settings.
 *
 * Unlike Kiro/Lovable (env credentials, module-level client), each request
 * builds its own `createOpenAI` instance from the user's saved config — the
 * credentials are per-user and per-request, so nothing is cached at module
 * level and nothing is shared across requests.
 *
 * Server-only: never import from client components.
 */
import { createOpenAI } from "@ai-sdk/openai";

export const CUSTOM_MODEL_PREFIX = "custom-";

export interface CustomProviderConfig {
  baseUrl: string;
  apiKey: string;
  modelId: string;
}

/** Prefix-based check: any `custom-*` key routes to the user's endpoint. */
export function isCustomModelKey(value: string): boolean {
  return (
    value.startsWith(CUSTOM_MODEL_PREFIX) &&
    value.length > CUSTOM_MODEL_PREFIX.length
  );
}

/** Map an internal `custom-*` key to the model id the endpoint expects. */
export function getCustomModelId(key: string): string {
  return isCustomModelKey(key) ? key.slice(CUSTOM_MODEL_PREFIX.length) : key;
}

/** Map an endpoint model id back to its internal `custom-*` key. */
export function toCustomModelKey(modelId: string): string {
  return `${CUSTOM_MODEL_PREFIX}${modelId}`;
}

/** Human-readable label, derived from the model id. */
export function getCustomModelName(key: string): string {
  const modelId = getCustomModelId(key);
  const label = modelId
    .split(/[-_/]/)
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
  return `${label} (Custom)`;
}

/**
 * Build a per-request model factory for one user's saved config. The
 * returned function resolves `custom-*` keys against the user's endpoint.
 * Call once per request; never share the result across requests.
 */
export function createCustomOpenAIProvider(config: CustomProviderConfig) {
  const client = createOpenAI({
    name: "custom-openai",
    apiKey: config.apiKey,
    baseURL: config.baseUrl.replace(/\/+$/, ""),
  });
  return (modelKey: string) =>
    client.chat(
      getCustomModelId(modelKey) as Parameters<typeof client.chat>[0],
    );
}
