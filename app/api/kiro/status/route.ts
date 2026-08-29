/**
 * Kiro availability + live model catalog.
 *
 * Backed by the local Kiro Gateway's OpenAI-compatible `GET /v1/models`. The
 * gateway is the source of truth; `KIRO_MODELS` supplies display metadata and
 * acts as an offline fallback.
 *
 * Auth-gated because Kiro traffic consumes a personal quota.
 */
import { NextRequest, NextResponse } from "next/server";
import { getUserID } from "@/lib/auth/get-user-id";
import {
  getKiroGatewayApiKey,
  getKiroGatewayBaseURL,
  isKiroEnabled,
} from "@/lib/ai/providers/kiro";
import {
  getKiroModelId,
  getKiroModelName,
  KIRO_MODEL_KEYS,
  kiroModelSupportsThinking,
  toKiroModelKey,
} from "@/lib/ai/providers/kiro-models";

export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 5 * 60 * 1000;
const GATEWAY_TIMEOUT_MS = 5_000;

type KiroModelEntry = {
  /** Internal `kiro-*` id used as the `SelectedModel` value. */
  id: string;
  /** Model id the gateway expects. */
  modelId: string;
  name: string;
  supportsThinking: boolean;
};

let cached: { data: KiroModelEntry[]; expiresAt: number } | null = null;

const staticCatalog = (): KiroModelEntry[] =>
  KIRO_MODEL_KEYS.map((key) => ({
    id: key,
    modelId: getKiroModelId(key),
    name: getKiroModelName(key),
    supportsThinking: kiroModelSupportsThinking(key),
  }));

export async function GET(req: NextRequest) {
  try {
    await getUserID(req);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isKiroEnabled()) {
    return NextResponse.json({
      available: false,
      models: [],
      hint: "Set KIRO_GATEWAY_API_KEY (the gateway's PROXY_API_KEY) and start the Kiro Gateway.",
    });
  }

  if (cached && Date.now() < cached.expiresAt) {
    return NextResponse.json({
      available: true,
      models: cached.data,
      source: "cache",
    });
  }

  try {
    const res = await fetch(`${getKiroGatewayBaseURL()}/models`, {
      headers: { Authorization: `Bearer ${getKiroGatewayApiKey()}` },
      cache: "no-store",
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });

    if (!res.ok) {
      // Surface auth problems distinctly: a wrong PROXY_API_KEY is the most
      // likely misconfiguration and is otherwise silent in the picker.
      return NextResponse.json({
        available: false,
        models: [],
        hint:
          res.status === 401 || res.status === 403
            ? "Kiro Gateway rejected the API key. Check KIRO_GATEWAY_API_KEY matches the gateway's PROXY_API_KEY."
            : `Kiro Gateway returned ${res.status}.`,
      });
    }

    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    const gatewayIds = (Array.isArray(json.data) ? json.data : [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    const models: KiroModelEntry[] = gatewayIds.map((gatewayId) => {
      const key = toKiroModelKey(gatewayId);
      return {
        id: key,
        modelId: gatewayId,
        name: getKiroModelName(key),
        supportsThinking: kiroModelSupportsThinking(key),
      };
    });

    // An empty list means the gateway has no usable accounts. Don't advertise
    // Kiro in that case; the picker would offer models that always fail.
    if (models.length === 0) {
      return NextResponse.json({
        available: false,
        models: [],
        hint: "Kiro Gateway reported no available models. Check its credentials.json / account state.",
      });
    }

    cached = { data: models, expiresAt: Date.now() + CACHE_TTL_MS };

    return NextResponse.json({
      available: true,
      models,
      source: "gateway",
    });
  } catch (error) {
    // Gateway unreachable (not running, or not reachable from this runtime -
    // expected on Vercel when the gateway is bound to localhost). Serve stale
    // cache, then the static catalog, so a transient blip doesn't empty the UI.
    if (cached) {
      return NextResponse.json({
        available: true,
        models: cached.data,
        source: "stale",
      });
    }

    return NextResponse.json({
      available: false,
      models: staticCatalog(),
      hint: `Kiro Gateway unreachable at ${getKiroGatewayBaseURL()}: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    });
  }
}
