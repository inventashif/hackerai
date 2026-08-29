import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";

export const dynamic = "force-dynamic";

type ZenModel = {
  id: string;
  object: string;
  created: number;
  owned_by: string;
};

type ZenModelsResponse = {
  object: string;
  data: ZenModel[];
};

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cached: { data: ZenModel[]; expiresAt: number } | null = null;

function isFreeModel(id: string): boolean {
  return id.endsWith("-free") || id === "big-pickle";
}

function zenHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
    "x-opencode-request": `msg_${randomBytes(16).toString("hex")}`,
    "x-opencode-session": `ses_${randomBytes(16).toString("hex")}`,
    "User-Agent": "opencode/1.15.0 ai-sdk/provider-utils/4.0.23",
  };
  const key = apiKey?.trim() || process.env.OPENCODE_ZEN_API_KEY?.trim();
  headers.Authorization = key ? `Bearer ${key}` : "Bearer public";
  return headers;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const filter = url.searchParams.get("filter"); // "free" | "all" | null

  // Serve from cache if fresh and filter is not requested to be "all" with different handling
  // We cache the full list and filter afterwards
  if (cached && Date.now() < cached.expiresAt) {
    const data =
      filter === "all" ? cached.data : cached.data.filter((m) => isFreeModel(m.id));
    return NextResponse.json(
      { object: "list", data },
      {
        headers: {
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60",
          "X-Cache": "HIT",
        },
      },
    );
  }

  const baseUrl =
    process.env.OPENCODE_ZEN_BASE_URL?.trim() || "https://opencode.ai/zen/v1";
  const modelsUrl = `${baseUrl.replace(/\/$/, "")}/models`;

  try {
    const res = await fetch(modelsUrl, {
      headers: zenHeaders(),
      // Next.js fetch cache disabled for this proxy - we handle our own
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: "Failed to fetch Zen models", status: res.status, details: text.slice(0, 500) },
        { status: res.status === 401 || res.status === 403 ? res.status : 502 },
      );
    }

    const json = (await res.json()) as ZenModelsResponse;
    const allModels = Array.isArray(json.data) ? json.data : [];

    // Sort: free models first, then alphabetically
    allModels.sort((a, b) => {
      const aFree = isFreeModel(a.id);
      const bFree = isFreeModel(b.id);
      if (aFree && !bFree) return -1;
      if (!aFree && bFree) return 1;
      return a.id.localeCompare(b.id);
    });

    cached = { data: allModels, expiresAt: Date.now() + CACHE_TTL_MS };

    const data =
      filter === "all" ? allModels : allModels.filter((m) => isFreeModel(m.id));

    return NextResponse.json(
      { object: "list", data },
      {
        headers: {
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60",
          "X-Cache": "MISS",
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    // If we have stale cache, serve it
    if (cached) {
      const data =
        filter === "all" ? cached.data : cached.data.filter((m) => isFreeModel(m.id));
      return NextResponse.json(
        { object: "list", data, stale: true },
        {
          headers: {
            "Cache-Control": "public, s-maxage=60, stale-while-revalidate=30",
            "X-Cache": "STALE",
          },
        },
      );
    }
    return NextResponse.json({ error: "Failed to fetch Zen models", details: message }, { status: 502 });
  }
}
