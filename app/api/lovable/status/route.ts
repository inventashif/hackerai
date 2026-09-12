import { NextRequest, NextResponse } from "next/server";
import { getUserID } from "@/lib/auth/get-user-id";
import {
  getLovableApiKey,
  getLovableBaseUrl,
  isLovableEnabled,
} from "@/lib/ai/providers/lovable";
import {
  getLovableModelName,
  lovableModelSupportsThinking,
  toLovableModelKey,
} from "@/lib/ai/providers/lovable-models";

export const dynamic = "force-dynamic";

const GATEWAY_TIMEOUT_MS = 5_000;

type GatewayModel = {
  id?: string;
  name?: string;
  deprecated?: boolean;
  modalities?: { output?: string[] };
};

export async function GET(req: NextRequest) {
  try {
    await getUserID(req);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isLovableEnabled()) {
    return NextResponse.json({ available: false, models: [] });
  }

  try {
    const res = await fetch(`${getLovableBaseUrl()}/models`, {
      headers: { "Lovable-API-Key": getLovableApiKey()! },
      cache: "no-store",
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });

    if (!res.ok) {
      return NextResponse.json({ available: false, models: [] });
    }

    const json = (await res.json()) as { data?: GatewayModel[] };
    const models = (Array.isArray(json.data) ? json.data : [])
      .filter(
        (model): model is GatewayModel & { id: string } =>
          typeof model.id === "string" &&
          model.id.length > 0 &&
          model.deprecated !== true &&
          model.modalities?.output?.includes("text") === true &&
          !model.id.includes("embedding") &&
          !model.id.includes("transcribe"),
      )
      .map((model) => {
        const id = toLovableModelKey(model.id);
        return {
          id,
          modelId: model.id,
          name: model.name || getLovableModelName(id),
          supportsThinking: lovableModelSupportsThinking(id),
        };
      });

    return NextResponse.json({ available: models.length > 0, models });
  } catch {
    return NextResponse.json({ available: false, models: [] });
  }
}
