/**
 * Custom provider model catalog + connection test.
 *
 * GET: lists the models on the requesting user's saved endpoint
 * (OpenAI-compatible `GET {baseURL}/models`), keyed as `custom-<id>` for the
 * model picker. The saved API key never leaves the server.
 *
 * POST: tests an unsaved base URL + API key pair (from Settings) against the
 * same endpoint without storing anything. The key travels only in the
 * request body and is never logged or persisted.
 */
import { NextRequest, NextResponse } from "next/server";
import { getUserID } from "@/lib/auth/get-user-id";
import { getCustomProviderConfigForRequest } from "@/lib/db/actions";
import { toCustomModelKey } from "@/lib/ai/providers/custom-openai";

export const dynamic = "force-dynamic";

const ENDPOINT_TIMEOUT_MS = 5_000;

type CatalogModelEntry = {
  /** Internal `custom-*` id used as the `SelectedModel` value. */
  id: string;
  /** Model id the endpoint expects. */
  modelId: string;
  name: string;
};

/**
 * Validate a user-supplied base URL. Mirrors the check in
 * `convex/customProvider.ts` (kept duplicated: Convex modules cannot import
 * from `lib/`). Rejects non-http(s) schemes and loopback / private-network
 * hosts so the route can never probe internal networks.
 */
function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
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
  if (isLoopbackOrPrivate) return null;
  return trimmed.replace(/\/+$/, "");
}

async function fetchCatalog(
  baseUrl: string,
  apiKey: string,
): Promise<{ ok: true; models: CatalogModelEntry[] } | { ok: false; hint: string }> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      hint: `Endpoint unreachable at ${baseUrl}: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      hint:
        res.status === 401 || res.status === 403
          ? "The endpoint rejected the API key. Check the key and base URL."
          : `The endpoint returned ${res.status}.`,
    };
  }
  const json = (await res.json()) as { data?: Array<{ id?: string }> };
  const ids = (Array.isArray(json.data) ? json.data : [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return {
    ok: true,
    models: ids.map((modelId) => ({
      id: toCustomModelKey(modelId),
      modelId,
      name: modelId,
    })),
  };
}

export async function GET(req: NextRequest) {
  let userId: string;
  try {
    userId = await getUserID(req);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const config = await getCustomProviderConfigForRequest(userId);
  if (!config) {
    return NextResponse.json({
      available: false,
      models: [],
      hint: "No custom provider saved. Add one in Settings > Custom Provider.",
    });
  }

  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!baseUrl) {
    return NextResponse.json({
      available: false,
      models: [],
      hint: "The saved base URL is invalid. Update it in Settings > Custom Provider.",
    });
  }

  const catalog = await fetchCatalog(baseUrl, config.apiKey);
  if (!catalog.ok) {
    return NextResponse.json({
      available: false,
      models: [],
      hint: catalog.hint,
    });
  }

  return NextResponse.json({
    available: catalog.models.length > 0,
    models: catalog.models,
    savedModelId: config.modelId,
    hint:
      catalog.models.length === 0
        ? "The endpoint reported no models."
        : undefined,
  });
}

export async function POST(req: NextRequest) {
  try {
    await getUserID(req);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    baseUrl?: unknown;
    apiKey?: unknown;
  } | null;
  const baseUrl = normalizeBaseUrl(
    typeof body?.baseUrl === "string" ? body.baseUrl : "",
  );
  const apiKey =
    typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  if (!baseUrl || !apiKey) {
    return NextResponse.json(
      { ok: false, error: "A valid base URL and API key are required." },
      { status: 400 },
    );
  }

  const catalog = await fetchCatalog(baseUrl, apiKey);
  if (!catalog.ok) {
    return NextResponse.json({ ok: false, error: catalog.hint });
  }
  return NextResponse.json({ ok: true, models: catalog.models });
}
