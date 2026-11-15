/**
 * CoArena model catalog.
 *
 * Keys are HackerAI-internal provider ids (always `coarena-` prefixed so
 * `coerceSelectedModel` and the tier router can recognize them). Each `id`
 * is the model name CoArena expects on `POST /v1/chat/completions`.
 *
 * CoArena is the source of truth: `/api/coarena/status` fetches the live
 * list and this catalog is the offline fallback plus the place display
 * metadata lives. Keep `id` values matching `GET /v1/models` on CoArena.
 * Synced 2026-11-15 against the live list (10 active models, all 128K
 * input). The catalog rotates, so unknown `coarena-*` ids still resolve
 * through the prefix fallback in `myProvider`.
 */
export const COARENA_MODELS = {
  "coarena-deepseek-v4-1-flash-1017": {
    id: "deepseek-v4-1-flash-1017",
    name: "DeepSeek V4.1 Flash 1017 (CoArena)",
    supportsThinking: false,
  },
  "coarena-gemini-3-8-flash": {
    id: "gemini-3-8-flash",
    name: "Gemini 3.8 Flash (CoArena)",
    supportsThinking: false,
  },
  "coarena-gemini-4-argon": {
    id: "gemini-4-argon",
    name: "Gemini 4 Argon (CoArena)",
    supportsThinking: false,
  },
  "coarena-gemini-4-carbon": {
    id: "gemini-4-carbon",
    name: "Gemini 4 Carbon (CoArena)",
    supportsThinking: false,
  },
  "coarena-gpt-6-1-sol": {
    id: "gpt-6-1-sol",
    name: "GPT 6.1 Sol (CoArena)",
    supportsThinking: false,
  },
  "coarena-gpt-6-1-terra": {
    id: "gpt-6-1-terra",
    name: "GPT 6.1 Terra (CoArena)",
    supportsThinking: false,
  },
  "coarena-gpt-6-astra": {
    id: "gpt-6-astra",
    name: "GPT 6 Astra (CoArena)",
    supportsThinking: false,
  },
  "coarena-gpt-6-luna": {
    id: "gpt-6-luna",
    name: "GPT 6 Luna (CoArena)",
    supportsThinking: false,
  },
  "coarena-grok-4-7": {
    id: "grok-4-7",
    name: "Grok 4.7 (CoArena)",
    supportsThinking: false,
  },
  "coarena-kimi-k3-1-pro": {
    id: "kimi-k3-1-pro",
    name: "Kimi K3.1 Pro (CoArena)",
    supportsThinking: false,
  },
} as const;

export type CoarenaModelId = keyof typeof COARENA_MODELS;

export const COARENA_MODEL_KEYS = Object.keys(
  COARENA_MODELS,
) as CoarenaModelId[];

export const COARENA_MODEL_PREFIX = "coarena-";

/** Default knowledge cutoff reported for CoArena models without a specific entry. */
export const COARENA_DEFAULT_CUTOFF = "November 2026";

/** Narrow to a key present in the static catalog. */
export function isCoarenaModelId(value: string): value is CoarenaModelId {
  return Object.hasOwn(COARENA_MODELS, value);
}

/**
 * Prefix-based check. Accepts models CoArena exposes that are not in the
 * static catalog yet, so a catalog rotation does not require a code change.
 */
export function isCoarenaModelKey(value: string): boolean {
  return (
    value.startsWith(COARENA_MODEL_PREFIX) &&
    value.length > COARENA_MODEL_PREFIX.length
  );
}

/** Map an internal `coarena-*` key to the id CoArena expects. */
export function getCoarenaModelId(key: string): string {
  if (isCoarenaModelId(key)) return COARENA_MODELS[key].id;
  return key.startsWith(COARENA_MODEL_PREFIX)
    ? key.slice(COARENA_MODEL_PREFIX.length)
    : key;
}

/** Map a CoArena model id back to its internal `coarena-*` key. */
export function toCoarenaModelKey(coarenaId: string): string {
  for (const [key, meta] of Object.entries(COARENA_MODELS)) {
    if (meta.id === coarenaId) return key;
  }
  return `${COARENA_MODEL_PREFIX}${coarenaId}`;
}

/** Human-readable label, derived for models missing from the static catalog. */
export function getCoarenaModelName(key: string): string {
  if (isCoarenaModelId(key)) return COARENA_MODELS[key].name;
  const coarenaId = getCoarenaModelId(key);
  const label = coarenaId
    .split("-")
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
  return `${label} (CoArena)`;
}

export function coarenaModelSupportsThinking(key: string): boolean {
  return isCoarenaModelId(key) ? COARENA_MODELS[key].supportsThinking : false;
}
