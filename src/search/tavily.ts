import type { SearchCallOptions, SearchProvider, SearchResult } from "../search.js";
import {
  type HttpSearchProviderOptions,
  mapSearchHits,
  parseBaseUrl,
  postSearchJson,
  resolveApiKey,
} from "./shared.js";

/**
 * Options accepted by {@link tavilySearchProvider} — the shared
 * {@link HttpSearchProviderOptions} triple. Env-var fallback:
 * `TAVILY_API_KEY`; the key travels in the `Authorization: Bearer` header.
 */
export type TavilySearchProviderOptions = HttpSearchProviderOptions;

/** Default Tavily search endpoint. */
const TAVILY_DEFAULT_BASE_URL = "https://api.tavily.com/search";

/**
 * A {@link SearchProvider} over the Tavily Search API.
 *
 * The API key comes from `options.apiKey` or the `TAVILY_API_KEY` environment
 * variable (explicit wins); a missing key is a {@link ConfigError} at
 * construction, not mid-call. The request is a POST of `{"query": query,
 * "max_results": limit}` authenticated by `Authorization: Bearer <key>` —
 * the key is deliberately NOT the body's `api_key` field, keeping credentials
 * out of the payload — and error messages name neither.
 *
 * `response.results[]` maps `url`/`title`/`content` to
 * `{ url, title, description }`; a response without `results` is an empty
 * list, not an error, and malformed JSON is a {@link ParseError}.
 * `max_results` is clamped to Tavily's documented 1–20 bound; {@link search}
 * still truncates client-side — the two mechanisms compose.
 *
 * @param options Provider configuration; see {@link TavilySearchProviderOptions}.
 *
 * @example
 * const provider = tavilySearchProvider(); // TAVILY_API_KEY env
 * const results = await search("typed scraping sdk", { provider, limit: 5 });
 */
export function tavilySearchProvider(options: TavilySearchProviderOptions = {}): SearchProvider {
  const apiKey = resolveApiKey(options.apiKey, "TAVILY_API_KEY", "tavilySearchProvider");
  const endpoint = parseBaseUrl(options.baseUrl ?? TAVILY_DEFAULT_BASE_URL);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const requestUrl = endpoint.toString();

  return {
    async search(query: string, call: SearchCallOptions = {}): Promise<SearchResult[]> {
      const payload: Record<string, unknown> = { query };
      // `max_results` bounds the API response server-side — Tavily accepts
      // 1–20, so clamp rather than let the API reject the request.
      if (call.limit !== undefined) {
        payload.max_results = Math.min(Math.max(1, call.limit), 20);
      }
      const body = await postSearchJson(
        "Tavily",
        requestUrl,
        { authorization: `Bearer ${apiKey}` },
        payload,
        call,
        fetchImpl,
      );
      return mapSearchHits(body, "results", "url", "content");
    },
  };
}
