/**
 * Kiro model catalog.
 *
 * Keys are HackerAI-internal provider ids (always `kiro-` prefixed so
 * `coerceSelectedModel` and the tier router can recognize them). Each `id` is
 * the model name the Kiro Gateway expects on `POST /v1/chat/completions`.
 *
 * The gateway is the source of truth: `/api/kiro/models` fetches the live list
 * and this catalog is the offline fallback plus the place display metadata
 * lives. Keep `id` values matching `GET /v1/models` on the gateway.
 */
export const KIRO_MODELS = {
  // `auto-kiro` is the gateway's router. The internal key stays `kiro-auto`
  // rather than `kiro-auto-kiro` to avoid the stutter and to preserve
  // selections persisted before the gateway migration.
  "kiro-auto": { id: "auto-kiro", name: "Kiro Auto", supportsThinking: false },

  "kiro-claude-opus-5": {
    id: "claude-opus-5",
    name: "Claude Opus 5 (Kiro)",
    supportsThinking: true,
  },
  "kiro-claude-opus-4.8": {
    id: "claude-opus-4.8",
    name: "Claude Opus 4.8 (Kiro)",
    supportsThinking: true,
  },
  "kiro-claude-opus-4.7": {
    id: "claude-opus-4.7",
    name: "Claude Opus 4.7 (Kiro)",
    supportsThinking: true,
  },
  "kiro-claude-opus-4.6": {
    id: "claude-opus-4.6",
    name: "Claude Opus 4.6 (Kiro)",
    supportsThinking: true,
  },
  "kiro-claude-opus-4.5": {
    id: "claude-opus-4.5",
    name: "Claude Opus 4.5 (Kiro)",
    supportsThinking: true,
  },
  "kiro-claude-sonnet-5": {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5 (Kiro)",
    supportsThinking: true,
  },
  "kiro-claude-sonnet-4.6": {
    id: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6 (Kiro)",
    supportsThinking: true,
  },
  "kiro-claude-sonnet-4.5": {
    id: "claude-sonnet-4.5",
    name: "Claude Sonnet 4.5 (Kiro)",
    supportsThinking: true,
  },
  "kiro-claude-sonnet-4": {
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4 (Kiro)",
    supportsThinking: false,
  },
  "kiro-claude-haiku-4.5": {
    id: "claude-haiku-4.5",
    name: "Claude Haiku 4.5 (Kiro)",
    supportsThinking: false,
  },

  "kiro-gpt-5.6-terra": {
    id: "gpt-5.6-terra",
    name: "GPT 5.6 Terra (Kiro)",
    supportsThinking: true,
  },
  "kiro-gpt-5.6-sol": {
    id: "gpt-5.6-sol",
    name: "GPT 5.6 Sol (Kiro)",
    supportsThinking: true,
  },
  "kiro-gpt-5.6-luna": {
    id: "gpt-5.6-luna",
    name: "GPT 5.6 Luna (Kiro)",
    supportsThinking: true,
  },

  "kiro-deepseek-3.2": {
    id: "deepseek-3.2",
    name: "DeepSeek 3.2 (Kiro)",
    supportsThinking: false,
  },
  "kiro-glm-5": { id: "glm-5", name: "GLM 5 (Kiro)", supportsThinking: false },
  "kiro-minimax-m2.5": {
    id: "minimax-m2.5",
    name: "MiniMax M2.5 (Kiro)",
    supportsThinking: false,
  },
  "kiro-minimax-m2.1": {
    id: "minimax-m2.1",
    name: "MiniMax M2.1 (Kiro)",
    supportsThinking: false,
  },
  "kiro-qwen3-coder-next": {
    id: "qwen3-coder-next",
    name: "Qwen3 Coder Next (Kiro)",
    supportsThinking: false,
  },
} as const;

export type KiroModelId = keyof typeof KIRO_MODELS;

export const KIRO_MODEL_KEYS = Object.keys(KIRO_MODELS) as KiroModelId[];

export const KIRO_MODEL_PREFIX = "kiro-";

/** Default knowledge cutoff reported for Kiro models without a specific entry. */
export const KIRO_DEFAULT_CUTOFF = "August 2026";

/** Narrow to a key present in the static catalog. */
export function isKiroModelId(value: string): value is KiroModelId {
  return Object.hasOwn(KIRO_MODELS, value);
}

/**
 * Prefix-based check. Accepts models the gateway exposes that are not in the
 * static catalog yet, so a gateway upgrade does not require a code change.
 */
export function isKiroModelKey(value: string): boolean {
  return (
    value.startsWith(KIRO_MODEL_PREFIX) && value.length > KIRO_MODEL_PREFIX.length
  );
}

/** Map an internal `kiro-*` key to the id the gateway expects. */
export function getKiroModelId(key: string): string {
  if (isKiroModelId(key)) return KIRO_MODELS[key].id;
  return key.startsWith(KIRO_MODEL_PREFIX)
    ? key.slice(KIRO_MODEL_PREFIX.length)
    : key;
}

/** Map a gateway model id back to its internal `kiro-*` key. */
export function toKiroModelKey(gatewayId: string): string {
  for (const [key, meta] of Object.entries(KIRO_MODELS)) {
    if (meta.id === gatewayId) return key;
  }
  return `${KIRO_MODEL_PREFIX}${gatewayId}`;
}

/** Human-readable label, derived for models missing from the static catalog. */
export function getKiroModelName(key: string): string {
  if (isKiroModelId(key)) return KIRO_MODELS[key].name;
  const gatewayId = getKiroModelId(key);
  const label = gatewayId
    .split("-")
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
  return `${label} (Kiro)`;
}

export function kiroModelSupportsThinking(key: string): boolean {
  return isKiroModelId(key) ? KIRO_MODELS[key].supportsThinking : false;
}
