import { redactSensitiveErrorMessage } from "@/lib/utils/error-redaction";
import type { PerplexitySearchResult } from "./perplexity";

/**
 * Tavily Search API adapter.
 *
 * Tavily is the keyless-tier-free fallback when PERPLEXITY_API_KEY is absent.
 * Free plan: 1,000 credits/month, no card required.
 * Docs: https://docs.tavily.com/documentation/api-reference/endpoint/search
 */
const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
export const TAVILY_SEARCH_MAX_ATTEMPTS = 2;
const TAVILY_RETRY_BASE_DELAY_MS = 250;
const TAVILY_MAX_RESULTS = 10;

const RETRYABLE_TAVILY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export const isTavilyConfigured = (): boolean =>
  Boolean(process.env.TAVILY_API_KEY?.trim());

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
}

interface TavilyResponse {
  results?: TavilyResult[];
}

export class TavilyApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly bodySummary: string;
  readonly retryable: boolean;

  constructor({
    status,
    statusText,
    bodySummary,
  }: {
    status: number;
    statusText: string;
    bodySummary: string;
  }) {
    const statusLabel = statusText ? `${status} ${statusText}` : `${status}`;
    super(`Tavily API error ${statusLabel}`);
    this.name = "TavilyApiError";
    this.status = status;
    this.statusText = statusText;
    this.bodySummary = bodySummary;
    this.retryable = RETRYABLE_TAVILY_STATUSES.has(status);
  }
}

const sleep = (delayMs: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Operation aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new DOMException("Operation aborted", "AbortError"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

const summarizeTavilyErrorBody = (body: string): string =>
  redactSensitiveErrorMessage(body.replace(/\s+/g, " ").trim()).slice(0, 400);

export const buildTavilySearchBody = (
  query: string,
  options?: {
    days?: number;
    maxResults?: number;
  },
): Record<string, unknown> => ({
  query,
  search_depth: "basic",
  topic: "general",
  max_results: options?.maxResults ?? TAVILY_MAX_RESULTS,
  include_answer: false,
  include_raw_content: false,
  ...(options?.days ? { days: options.days } : {}),
});

const fetchTavilyQuery = async (
  query: string,
  options: { days?: number } | undefined,
  abortSignal?: AbortSignal,
): Promise<PerplexitySearchResult[]> => {
  const apiKey = process.env.TAVILY_API_KEY?.trim() || "";
  const body = buildTavilySearchBody(query, options);

  for (let attempt = 1; attempt <= TAVILY_SEARCH_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(TAVILY_SEARCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: abortSignal,
      });

      if (!response.ok) {
        const text = await response.text();
        const error = new TavilyApiError({
          status: response.status,
          statusText: response.statusText,
          bodySummary: summarizeTavilyErrorBody(text),
        });

        if (!error.retryable || attempt === TAVILY_SEARCH_MAX_ATTEMPTS) {
          throw error;
        }

        await sleep(TAVILY_RETRY_BASE_DELAY_MS * attempt, abortSignal);
        continue;
      }

      const payload = (await response.json()) as TavilyResponse;
      const results = Array.isArray(payload.results) ? payload.results : [];

      return results
        .filter((result) => Boolean(result.url) && Boolean(result.title))
        .map((result) => ({
          title: result.title as string,
          url: result.url as string,
          snippet: result.content ?? "",
          date: result.published_date,
        }));
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      if (error instanceof TavilyApiError) throw error;
      if (attempt === TAVILY_SEARCH_MAX_ATTEMPTS) throw error;
      await sleep(TAVILY_RETRY_BASE_DELAY_MS * attempt, abortSignal);
    }
  }

  return [];
};

/**
 * Run one search per query variant, flatten and de-duplicate by URL.
 */
export const searchTavily = async (
  queries: string[],
  options: { recencyDays?: number } | undefined,
  abortSignal?: AbortSignal,
): Promise<PerplexitySearchResult[]> => {
  const seenUrls = new Set<string>();
  const combined: PerplexitySearchResult[] = [];

  for (const query of queries) {
    const results = await fetchTavilyQuery(
      query,
      { days: options?.recencyDays },
      abortSignal,
    );

    for (const result of results) {
      if (seenUrls.has(result.url)) continue;
      seenUrls.add(result.url);
      combined.push(result);
    }
  }

  return combined;
};
