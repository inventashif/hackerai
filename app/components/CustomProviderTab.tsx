"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

const extractErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof ConvexError) {
    return (
      (error.data as { message?: string })?.message ||
      error.message ||
      fallback
    );
  }
  return error instanceof Error ? error.message : fallback;
};

const CustomProviderTab = () => {
  const savedConfig = useQuery(api.customProvider.getCustomProviderConfig, {});
  const saveConfig = useMutation(api.customProvider.saveCustomProviderConfig);
  const deleteConfig = useMutation(
    api.customProvider.deleteCustomProviderConfig,
  );

  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [prefilled, setPrefilled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  // Prefill the saved base URL and model once the config loads. The key
  // field stays empty: the stored key is never sent to the client, and an
  // empty field on save keeps the stored key.
  useEffect(() => {
    if (savedConfig && !prefilled) {
      setBaseUrl(savedConfig.baseUrl);
      setModelId(savedConfig.modelId);
      setPrefilled(true);
    }
  }, [savedConfig, prefilled]);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/custom-provider/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl, apiKey }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        models?: { modelId: string }[];
      };
      if (json.ok) {
        const count = json.models?.length ?? 0;
        setTestResult(
          count > 0
            ? `Connected. ${count} model${count === 1 ? "" : "s"} available.`
            : "Connected, but the endpoint reported no models.",
        );
      } else {
        setTestResult(json.error ?? "Connection failed.");
      }
    } catch {
      setTestResult("Connection failed. Check the base URL and try again.");
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveConfig({
        baseUrl,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        modelId,
      });
      setApiKey("");
      toast.success("Custom provider saved");
    } catch (error) {
      toast.error(
        extractErrorMessage(error, "Failed to save custom provider"),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteConfig({});
      setBaseUrl("");
      setApiKey("");
      setModelId("");
      setTestResult(null);
      toast.success("Custom provider removed");
    } catch (error) {
      toast.error(
        extractErrorMessage(error, "Failed to remove custom provider"),
      );
    } finally {
      setDeleting(false);
    }
  };

  const hasSavedConfig = savedConfig !== null && savedConfig !== undefined;
  const canSave =
    baseUrl.trim().length > 0 &&
    modelId.trim().length > 0 &&
    (apiKey.trim().length > 0 || hasSavedConfig);

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Use any OpenAI-compatible API as a chat model. Save the endpoint
          details below, then pick the model from the model picker. Your API
          key is stored with your account and is never shown again.
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="custom-provider-base-url">Base URL</Label>
          <Input
            id="custom-provider-base-url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.example.com/v1"
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">
            The OpenAI-compatible API root, without a trailing slash. Must be
            a public http(s) host.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="custom-provider-api-key">API key</Label>
          <Input
            id="custom-provider-api-key"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={
              hasSavedConfig ? "•••••••• (saved — leave empty to keep)" : "sk-..."
            }
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="custom-provider-model-id">Model ID</Label>
          <Input
            id="custom-provider-model-id"
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            placeholder="e.g. llama-3.1-70b-instruct"
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">
            The default model ID on this endpoint. The model picker also
            lists every model the endpoint reports.
          </p>
        </div>
      </div>

      {testResult && (
        <p className="text-sm text-muted-foreground leading-relaxed">
          {testResult}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          onClick={handleTest}
          disabled={testing || !baseUrl.trim() || !apiKey.trim()}
        >
          {testing ? "Testing…" : "Test connection"}
        </Button>
        <Button onClick={handleSave} disabled={saving || !canSave}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {hasSavedConfig && (
          <Button
            variant="outline"
            onClick={handleDelete}
            disabled={deleting}
            className="text-destructive hover:text-destructive"
          >
            {deleting ? "Removing…" : "Remove"}
          </Button>
        )}
      </div>
    </div>
  );
};

export { CustomProviderTab };
