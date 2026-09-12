import { createOpenAI } from "@ai-sdk/openai";
import {
  getLovableModelId,
  lovableModelUsesResponsesApi,
} from "./lovable-models";

const DEFAULT_LOVABLE_BASE_URL = "https://ai.gateway.lovable.dev/v1";

export function getLovableBaseUrl(): string {
  const configured = process.env.LOVABLE_BASE_URL?.trim();
  return (configured || DEFAULT_LOVABLE_BASE_URL).replace(/\/+$/, "");
}

export function getLovableApiKey(): string | undefined {
  return process.env.LOVABLE_API_KEY?.trim() || undefined;
}

export function isLovableEnabled(): boolean {
  return Boolean(getLovableApiKey());
}

export async function isLovableAvailable(
  signal?: AbortSignal,
): Promise<boolean> {
  if (!isLovableEnabled()) return false;
  try {
    const res = await fetch(`${getLovableBaseUrl()}/models`, {
      headers: { "Lovable-API-Key": getLovableApiKey()! },
      cache: "no-store",
      signal,
    });
    return res.ok;
  } catch {
    return false;
  }
}

let cachedGateway: ReturnType<typeof createOpenAI> | null = null;
let cachedFingerprint: string | null = null;

function getGateway(): ReturnType<typeof createOpenAI> {
  const apiKey = getLovableApiKey();
  const baseURL = getLovableBaseUrl();
  const fingerprint = `${baseURL}::${apiKey ?? ""}`;
  if (!cachedGateway || cachedFingerprint !== fingerprint) {
    cachedGateway = createOpenAI({
      name: "lovable-gateway",
      apiKey: apiKey ?? "missing-lovable-api-key",
      baseURL,
      headers: {
        "Lovable-API-Key": apiKey ?? "",
        "X-Lovable-AIG-SDK": "vercel-ai-sdk",
      },
    });
    cachedFingerprint = fingerprint;
  }
  return cachedGateway;
}

export function createLovableProvider() {
  return (modelKey: string) => {
    const gateway = getGateway();
    const modelId = getLovableModelId(modelKey);

    if (lovableModelUsesResponsesApi(modelKey)) {
      return gateway.responses(
        modelId as Parameters<typeof gateway.responses>[0],
      );
    }

    return gateway.chat(modelId as Parameters<typeof gateway.chat>[0]);
  };
}
