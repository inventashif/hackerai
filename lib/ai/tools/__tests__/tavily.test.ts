import type { ToolContext } from "@/types";
import { createWebSearch } from "../web-search";
import {
  TavilyApiError,
  buildTavilySearchBody,
  searchTavily,
} from "../utils/tavily";

const jsonResponse = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { get: () => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

function makeContext(
  overrides: Partial<ToolContext> = {},
  onToolCost = jest.fn(),
): ToolContext {
  return {
    userLocation: { country: "US" },
    onToolCost,
    ...overrides,
  } as unknown as ToolContext;
}

async function runTool(
  tool: ReturnType<typeof createWebSearch>,
  input: Record<string, unknown>,
) {
  const execute = (
    tool as unknown as {
      execute: (i: unknown, o: unknown) => Promise<unknown>;
    }
  ).execute;

  return execute(input, {
    toolCallId: "call-1",
    abortSignal: undefined,
    messages: [],
  });
}

describe("tavily provider", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.TAVILY_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    jest.restoreAllMocks();
  });

  it("builds a body with a safe default result count", () => {
    expect(buildTavilySearchBody("ssrf")).toMatchObject({
      query: "ssrf",
      max_results: 10,
      include_answer: false,
    });
    expect(buildTavilySearchBody("ssrf", { days: 7 })).toHaveProperty(
      "days",
      7,
    );
  });

  it("maps Tavily results and de-duplicates across queries", async () => {
    process.env.TAVILY_API_KEY = "tvly-test";
    const shared = {
      title: "Shared",
      url: "https://example.com/shared",
      content: "shared content",
    };
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ results: [shared, { ...shared, title: "Dup" }] }),
      )
      .mockResolvedValueOnce(jsonResponse({ results: [shared] }));

    const results = await searchTavily(["one", "two"], undefined);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: "Shared",
      url: "https://example.com/shared",
      snippet: "shared content",
    });
  });

  it("surfaces a non-retryable auth failure as TavilyApiError", async () => {
    process.env.TAVILY_API_KEY = "tvly-bad";
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ detail: "unauthorized" }, 401));

    await expect(searchTavily(["one"], undefined)).rejects.toBeInstanceOf(
      TavilyApiError,
    );
  });

  it("is used by web_search when Perplexity is not configured", async () => {
    process.env.TAVILY_API_KEY = "tvly-test";
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({
        results: [
          {
            title: "PortSwigger SSRF",
            url: "https://portswigger.net/web-security/ssrf",
            content: "SSRF explained",
          },
        ],
      }),
    );

    const onToolCost = jest.fn();
    const result = await runTool(createWebSearch(makeContext({}, onToolCost)), {
      queries: ["ssrf"],
      brief: "search ssrf",
    });

    expect(result).toEqual([
      expect.objectContaining({
        title: "PortSwigger SSRF",
        url: "https://portswigger.net/web-security/ssrf",
        content: "SSRF explained",
      }),
    ]);
    // Free tier: no per-request cost is reported.
    expect(onToolCost).not.toHaveBeenCalled();
  });

  it("returns a clear message when no provider is configured", async () => {
    global.fetch = jest.fn();

    const result = await runTool(createWebSearch(makeContext()), {
      queries: ["ssrf"],
      brief: "search ssrf",
    });

    expect(result).toContain("no search provider is configured");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
