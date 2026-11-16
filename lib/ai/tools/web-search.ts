import { tool } from "ai";
import type { ToolContext } from "@/types";
import { stringifyRedactedError } from "@/lib/utils/error-redaction";
import {
  PerplexityApiError,
  PerplexitySearchResult,
  PerplexitySearchResponse,
  RECENCY_MAP,
  buildPerplexitySearchBody,
  formatSearchResults,
  isRetryablePerplexityStatus,
  summarizePerplexityErrorBody,
} from "./utils/perplexity";
import { reportToolFailure } from "./tool-failure";
import {
  TavilyApiError,
  TAVILY_SEARCH_MAX_ATTEMPTS,
  isTavilyConfigured,
  searchTavily,
} from "./utils/tavily";
import {
  PERPLEXITY_QUERY_MAX_LENGTH,
  createWebSearchToolSchema,
  webSearchTool,
  type WebSearchToolInput,
} from "./schemas";

/**
 * Web search tool using Perplexity Search API
 * Provides ranked web search results with content extraction
 */
/** Perplexity Search API cost: $5 per 1K requests */
const WEB_SEARCH_COST_PER_REQUEST = 0.005;
const PERPLEXITY_SEARCH_URL = "https://api.perplexity.ai/search";
const WEB_SEARCH_MAX_ATTEMPTS = 3;
const WEB_SEARCH_RETRY_BASE_DELAY_MS = 300;
const WEB_SEARCH_RETRY_JITTER_MS = 75;
const EMPTY_QUERY_TOOL_ERROR =
  "Error performing web search: Provide at least one non-empty query.";
const QUERY_TOO_LONG_TOOL_ERROR = `Error performing web search: Each query must be ${PERPLEXITY_QUERY_MAX_LENGTH} characters or fewer.`;
const NO_SEARCH_RESULTS_TOOL_ERROR =
  "No web search results were found for those queries. Try different keywords or a broader query.";
const NO_PROVIDER_TOOL_ERROR =
  "Error performing web search: no search provider is configured. Set TAVILY_API_KEY or PERPLEXITY_API_KEY.";

/** Tavily's `days` window equivalent of the Perplexity recency filter. */
const TAVILY_RECENCY_DAYS: Record<string, number> = {
  day: 1,
  week: 7,
  month: 30,
  year: 365,
};

const sleep = (delayMs: number, signal?: AbortSignal): Promise<void> => {
  if (delayMs <= 0) return Promise.resolve();
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Operation aborted", "AbortError"));
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(new DOMException("Operation aborted", "AbortError"));
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

const getRetryDelayMs = (attemptIndex: number): number => {
  const exponentialDelay =
    WEB_SEARCH_RETRY_BASE_DELAY_MS * Math.pow(2, attemptIndex);
  const jitter = Math.random() * WEB_SEARCH_RETRY_JITTER_MS;
  return Math.round(exponentialDelay + jitter);
};

const createPerplexityApiError = async (
  response: Response,
): Promise<PerplexityApiError> => {
  const errorText = await response.text();
  const bodySummary = summarizePerplexityErrorBody(
    errorText,
    response.headers.get("content-type") || "",
  );

  return new PerplexityApiError({
    status: response.status,
    statusText: response.statusText,
    bodySummary,
    retryable: isRetryablePerplexityStatus(response.status),
  });
};

const formatPerplexityFailureForTool = (
  error: PerplexityApiError,
  attempts: number,
): string => {
  const statusText = error.statusText ? ` ${error.statusText}` : "";

  if (error.retryable) {
    return `Error performing web search: Perplexity search is temporarily unavailable (HTTP ${error.status}${statusText} after ${attempts} attempts). Please retry shortly or continue without live web results if the task can proceed.`;
  }

  if (error.status === 401 || error.status === 403) {
    return `Error performing web search: Perplexity search is not authorized (HTTP ${error.status}${statusText}). Check the Perplexity API key or account access.`;
  }

  return `Error performing web search: Perplexity search failed (HTTP ${error.status}${statusText}).`;
};

const formatTavilyFailureForTool = (error: TavilyApiError): string => {
  const statusText = error.statusText ? ` ${error.statusText}` : "";

  if (error.status === 401 || error.status === 403) {
    return `Error performing web search: Tavily search is not authorized (HTTP ${error.status}${statusText}). Check the TAVILY_API_KEY value or account access.`;
  }

  if (error.retryable) {
    return `Error performing web search: Tavily search is temporarily unavailable (HTTP ${error.status}${statusText}). Please retry shortly or continue without live web results if the task can proceed.`;
  }

  return `Error performing web search: Tavily search failed (HTTP ${error.status}${statusText}).`;
};

const fetchPerplexitySearch = async (
  searchBody: Record<string, unknown>,
  abortSignal?: AbortSignal,
): Promise<Response> => {
  for (
    let attemptIndex = 0;
    attemptIndex < WEB_SEARCH_MAX_ATTEMPTS;
    attemptIndex++
  ) {
    const attempt = attemptIndex + 1;
    const isFinalAttempt = attempt === WEB_SEARCH_MAX_ATTEMPTS;

    try {
      const response = await fetch(PERPLEXITY_SEARCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY || ""}`,
        },
        body: JSON.stringify(searchBody),
        signal: abortSignal,
      });

      if (response.ok) {
        return response;
      }

      const error = await createPerplexityApiError(response);

      if (!error.retryable || isFinalAttempt) {
        throw error;
      }

      const delayMs = getRetryDelayMs(attemptIndex);
      console.warn("Web search provider error; retrying", {
        attempt,
        maxAttempts: WEB_SEARCH_MAX_ATTEMPTS,
        status: error.status,
        statusText: error.statusText,
        bodySummary: error.bodySummary,
        delayMs,
      });
      await sleep(delayMs, abortSignal);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }

      if (error instanceof PerplexityApiError) {
        throw error;
      }

      if (isFinalAttempt) {
        throw error;
      }

      const delayMs = getRetryDelayMs(attemptIndex);
      console.warn("Web search network error; retrying", {
        attempt,
        maxAttempts: WEB_SEARCH_MAX_ATTEMPTS,
        error: stringifyRedactedError(error),
        delayMs,
      });
      await sleep(delayMs, abortSignal);
    }
  }

  throw new Error("Web search failed before any Perplexity response was read");
};

const normalizeSearchQueries = (
  rawQueries: string[],
): { queries: string[]; error?: string } => {
  const queries = rawQueries.map((query) => query.trim()).filter(Boolean);

  if (queries.length === 0) {
    return { queries, error: EMPTY_QUERY_TOOL_ERROR };
  }

  if (queries.some((query) => query.length > PERPLEXITY_QUERY_MAX_LENGTH)) {
    return { queries, error: QUERY_TOO_LONG_TOOL_ERROR };
  }

  return { queries: queries.slice(0, 3) };
};

export const createWebSearch = (context: ToolContext) => {
  const { userLocation, onToolCost } = context;

  return tool({
    ...webSearchTool,
    inputSchema: createWebSearchToolSchema({
      modelName: context.getCurrentModelName?.() ?? context.modelName,
    }).inputSchema,
    execute: async (
      { queries: rawQueries, time }: WebSearchToolInput,
      { abortSignal },
    ) => {
      try {
        const { queries, error } = normalizeSearchQueries(rawQueries);
        if (error) {
          return error;
        }

        const recency = time && time !== "all" ? RECENCY_MAP[time] : undefined;

        // Provider chain: Perplexity when its key is present, otherwise the
        // free-tier Tavily adapter. web_search is registered unconditionally,
        // so a missing provider must degrade to a clear message, not a crash.
        if (!process.env.PERPLEXITY_API_KEY?.trim()) {
          if (!isTavilyConfigured()) {
            return NO_PROVIDER_TOOL_ERROR;
          }

          try {
            const results = await searchTavily(
              queries,
              {
                recencyDays: recency ? TAVILY_RECENCY_DAYS[recency] : undefined,
              },
              abortSignal,
            );

            return results.length > 0
              ? formatSearchResults(results)
              : NO_SEARCH_RESULTS_TOOL_ERROR;
          } catch (tavilyError) {
            if (
              tavilyError instanceof Error &&
              tavilyError.name === "AbortError"
            ) {
              return "Error: Operation aborted";
            }

            if (tavilyError instanceof TavilyApiError) {
              reportToolFailure(context.onToolFailure, {
                event: "web_search_provider_failed",
                tool_name: "web_search",
                provider: "tavily",
                status: tavilyError.status,
                status_text: tavilyError.statusText,
                retryable: tavilyError.retryable,
                attempts: TAVILY_SEARCH_MAX_ATTEMPTS,
                error_name: tavilyError.name,
                body_summary: tavilyError.bodySummary,
              });
              console.error("Web search tool error:", {
                provider: "tavily",
                status: tavilyError.status,
                statusText: tavilyError.statusText,
                retryable: tavilyError.retryable,
                bodySummary: tavilyError.bodySummary,
              });
              return formatTavilyFailureForTool(tavilyError);
            }

            const errorMessage = stringifyRedactedError(tavilyError);
            reportToolFailure(context.onToolFailure, {
              event: "web_search_tool_failed",
              tool_name: "web_search",
              provider: "tavily",
              error_name:
                tavilyError instanceof Error
                  ? tavilyError.name
                  : "UnknownError",
              error_message: errorMessage,
            });
            console.error("Web search tool error:", errorMessage);
            return `Error performing web search: ${errorMessage}`;
          }
        }

        const searchBody = buildPerplexitySearchBody(
          queries.length === 1 ? queries[0] : queries,
          {
            country: userLocation?.country,
            recency,
          },
        );

        const response = await fetchPerplexitySearch(searchBody, abortSignal);

        // Report web search cost ($5 per 1K requests)
        onToolCost?.(WEB_SEARCH_COST_PER_REQUEST);

        const searchResponse: PerplexitySearchResponse = await response.json();

        // Handle both single query (flat array) and multi-query (nested arrays) responses
        const isMultiQuery = queries.length > 1;
        let allResults: PerplexitySearchResult[];

        if (isMultiQuery && Array.isArray(searchResponse.results[0])) {
          // Multi-query response: flatten results from all queries
          allResults = (
            searchResponse.results as PerplexitySearchResult[][]
          ).flat();
        } else {
          // Single query response: results is already a flat array
          allResults = searchResponse.results as PerplexitySearchResult[];
        }

        return formatSearchResults(allResults);
      } catch (error) {
        // Handle abort errors gracefully without logging
        if (error instanceof Error && error.name === "AbortError") {
          return "Error: Operation aborted";
        }

        if (error instanceof PerplexityApiError) {
          const attempts = error.retryable ? WEB_SEARCH_MAX_ATTEMPTS : 1;
          const logFields = {
            name: error.name,
            status: error.status,
            statusText: error.statusText,
            retryable: error.retryable,
            bodySummary: error.bodySummary,
          };
          reportToolFailure(context.onToolFailure, {
            event: "web_search_provider_failed",
            tool_name: "web_search",
            provider: "perplexity",
            status: error.status,
            status_text: error.statusText,
            retryable: error.retryable,
            attempts,
            error_name: error.name,
            body_summary: error.bodySummary,
          });
          console.error("Web search tool error:", logFields);
          return formatPerplexityFailureForTool(error, attempts);
        }

        const errorMessage = stringifyRedactedError(error);
        reportToolFailure(context.onToolFailure, {
          event: "web_search_tool_failed",
          tool_name: "web_search",
          provider: "perplexity",
          error_name: error instanceof Error ? error.name : "UnknownError",
          error_message: errorMessage,
        });
        console.error("Web search tool error:", errorMessage);
        return `Error performing web search: ${errorMessage}`;
      }
    },
  });
};
