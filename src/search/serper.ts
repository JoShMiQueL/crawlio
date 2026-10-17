import type { SearchCallOptions, SearchProvider, SearchResult } from "../search.js";
import {
  type HttpSearchProviderOptions,
  mapSearchHits,
  parseBaseUrl,
  postSearchJson,
  resolveApiKey,
} from "./shared.js";

/**
 * Options accepted by {@link serperSearchProvider} — the shared
 * {@link HttpSearchProviderOptions} triple. Env-var fallback:
 * `SERPER_API_KEY`; the key travels in the `X-API-KEY` header.
 */
export type SerperSearchProviderOptions = HttpSearchProviderOptions;

/** Default Serper Google-search endpoint. */
const SERPER_DEFAULT_BASE_URL = "https://google.serper.dev/search";

/**
 * A {@link SearchProvider} over the Serper.dev Google Search API.
 *
 * The API key comes from `options.apiKey` or the `SERPER_API_KEY` environment
 * variable (explicit wins); a missing key is a {@link ConfigError} at
 * construction, not mid-call. The request is a POST of `{"q": query,
 * "num": limit}` with the key on the `X-API-KEY` header — never the URL,
 * never the body, and error messages name neither.
 *
 * `response.organic[]` maps `link`/`title`/`snippet` to
 * `{ url, title, description }`; a response without `organic` is an empty
 * list, not an error, and malformed JSON is a {@link ParseError}. `num` is
 * clamped to Serper's documented 1–100 bound; {@link search} still truncates
 * client-side — the two mechanisms compose.
 *
 * @param options Provider configuration; see {@link SerperSearchProviderOptions}.
 *
 * @example
 * const provider = serperSearchProvider(); // SERPER_API_KEY env
 * const results = await search("typed scraping sdk", { provider, limit: 5 });
 */
export function serperSearchProvider(options: SerperSearchProviderOptions = {}): SearchProvider {
  const apiKey = resolveApiKey(options.apiKey, "SERPER_API_KEY", "serperSearchProvider");
  const endpoint = parseBaseUrl(options.baseUrl ?? SERPER_DEFAULT_BASE_URL);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const requestUrl = endpoint.toString();

  return {
    async search(query: string, call: SearchCallOptions = {}): Promise<SearchResult[]> {
      const payload: Record<string, unknown> = { q: query };
      // `num` bounds the API response server-side — Serper accepts 1–100, so
      // clamp rather than let the API reject the request.
      if (call.limit !== undefined) {
        payload.num = Math.min(Math.max(1, call.limit), 100);
      }
      const body = await postSearchJson(
        "Serper",
        requestUrl,
        { "x-api-key": apiKey },
        payload,
        call,
        fetchImpl,
      );
      return mapSearchHits(body, "organic", "link", "snippet");
    },
  };
}
