/**
 * CoArena availability + live model catalog.
 *
 * Backed by CoArena's OpenAI-compatible `GET /v1/models`, called directly
 * in code through the rotating-key fetch (no separate proxy process).
 * CoArena is the source of truth; `COARENA_MODELS` supplies display
 * metadata and acts as an offline fallback.
 *
 * Auth-gated because CoArena traffic consumes the owner's API keys.
 */
import { NextRequest, NextResponse } from "next/server";
import { getUserID } from "@/lib/auth/get-user-id";
import {
  coarenaRotatingFetch,
  getCoarenaBaseURL,
  isCoarenaEnabled,
} from "@/lib/ai/providers/coarena";
import {
  COARENA_MODEL_KEYS,
  coarenaModelSupportsThinking,
  getCoarenaModelId,
  getCoarenaModelName,
  toCoarenaModelKey,
} from "@/lib/ai/providers/coarena-models";

export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 5 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 5_000;

type CoarenaModelEntry = {
  /** Internal `coarena-*` id used as the `SelectedModel` value. */
  id: string;
  /** Model id CoArena expects. */
  modelId: string;
  name: string;
  supportsThinking: boolean;
};

let cached: { data: CoarenaModelEntry[]; expiresAt: number } | null = null;

const staticCatalog = (): CoarenaModelEntry[] =>
  COARENA_MODEL_KEYS.map((key) => ({
    id: key,
    modelId: getCoarenaModelId(key),
    name: getCoarenaModelName(key),
    supportsThinking: coarenaModelSupportsThinking(key),
  }));

export async function GET(req: NextRequest) {
  try {
    await getUserID(req);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isCoarenaEnabled()) {
    return NextResponse.json({
      available: false,
      models: [],
      hint: "Set COARENA_API_KEYS (comma- or newline-separated) to use CoArena models.",
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
    const res = await coarenaRotatingFetch(
      `${getCoarenaBaseURL()}/models`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      },
    );

    if (!res.ok) {
      // Surface auth problems distinctly: dead keys are the most likely
      // misconfiguration and are otherwise silent in the picker.
      return NextResponse.json({
        available: false,
        models: [],
        hint:
          res.status === 401 || res.status === 403
            ? "CoArena rejected the API keys. Check COARENA_API_KEYS."
            : `CoArena returned ${res.status}.`,
      });
    }

    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    const coarenaIds = (Array.isArray(json.data) ? json.data : [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    const models: CoarenaModelEntry[] = coarenaIds.map((coarenaId) => {
      const key = toCoarenaModelKey(coarenaId);
      return {
        id: key,
        modelId: coarenaId,
        name: getCoarenaModelName(key),
        supportsThinking: coarenaModelSupportsThinking(key),
      };
    });

    // An empty list means CoArena has no usable models. Don't advertise
    // CoArena in that case; the picker would offer models that always fail.
    if (models.length === 0) {
      return NextResponse.json({
        available: false,
        models: [],
        hint: "CoArena reported no available models.",
      });
    }

    cached = { data: models, expiresAt: Date.now() + CACHE_TTL_MS };

    return NextResponse.json({
      available: true,
      models,
      source: "coarena",
    });
  } catch (error) {
    // CoArena unreachable. Serve stale cache, then the static catalog, so
    // a transient blip doesn't empty the UI.
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
      hint: `CoArena unreachable at ${getCoarenaBaseURL()}: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    });
  }
}
