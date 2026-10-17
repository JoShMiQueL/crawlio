import { HttpError, ParseError } from "../errors.js";
import { fetchHtmlOnce } from "../fetch.js";
import { withRetries } from "../retry.js";
import type { SearchCallOptions, SearchProvider, SearchResult } from "../search.js";
import type { FetchHtmlResult } from "../types.js";
import { type HttpSearchProviderOptions, parseBaseUrl, resolveApiKey } from "./shared.js";

/**
 * Options accepted by {@link braveSearchProvider} — the shared
 * {@link HttpSearchProviderOptions} triple. Env-var fallback:
 * `BRAVE_API_KEY`; the key travels in the `X-Subscription-Token` header.
 */
export type BraveSearchProviderOptions = HttpSearchProviderOptions;

/** Default Brave web-search endpoint. */
const BRAVE_DEFAULT_BASE_URL = "https://api.search.brave.com/res/v1/web/search";

/**
 * A {@link SearchProvider} over the Brave Search API — the reference provider.
 *
 * The API key comes from `options.apiKey` or the `BRAVE_API_KEY` environment
 * variable (explicit wins); a missing key is a {@link ConfigError} at
 * construction, not mid-call. The key rides the `X-Subscription-Token` header
 * and never the URL, and error messages name neither — a 401/403 surfaces as
 * an {@link HttpError} saying the key was rejected.
 *
 * Requests go through the same machinery page fetches use: `fetchHtmlOnce`
 * for the honest `crawlio/<version>` User-Agent, timeout, and abort handling,
 * wrapped in the shared {@link withRetries} policy — a 429 or 5xx retries
 * with backoff, a caller abort does not. `robots.txt` does not apply: this is
 * a provider API the caller authenticated to, not a crawled site.
 *
 * `response.web.results[]` maps to `{ url, title, description }`; a response
 * without `web` (no hits, answer-only payloads) is an empty list, not an
 * error, and malformed JSON is a {@link ParseError}.
 *
 * @param options Provider configuration; see {@link BraveSearchProviderOptions}.
 *
 * @example
 * const provider = braveSearchProvider(); // BRAVE_API_KEY env
 * const results = await search("typed scraping sdk", { provider, limit: 5 });
 */
export function braveSearchProvider(options: BraveSearchProviderOptions = {}): SearchProvider {
  const apiKey = resolveApiKey(options.apiKey, "BRAVE_API_KEY", "braveSearchProvider");
  // Each call clones the parsed URL instead of re-parsing the string.
  const endpoint = parseBaseUrl(options.baseUrl ?? BRAVE_DEFAULT_BASE_URL);
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return {
    async search(query: string, call: SearchCallOptions = {}): Promise<SearchResult[]> {
      const url = new URL(endpoint);
      url.searchParams.set("q", query);
      // `count` bounds the API response server-side — Brave accepts 1–20, so
      // clamp rather than let the API reject the request. The standalone
      // `search` still truncates client-side — the two mechanisms compose.
      if (call.limit !== undefined) {
        url.searchParams.set("count", String(Math.min(Math.max(1, call.limit), 20)));
      }
      const requestUrl = url.toString();

      let fetched: FetchHtmlResult;
      try {
        fetched = await withRetries(
          () =>
            fetchHtmlOnce(
              requestUrl,
              {
                headers: {
                  accept: "application/json",
                  // Header-only credential: a URL-carried key would leak via
                  // error `url`s and any log that records request lines.
                  "x-subscription-token": apiKey,
                },
                timeout: call.timeout,
                signal: call.signal,
              },
              fetchImpl,
            ),
          { retries: call.retries, signal: call.signal, url: requestUrl },
        );
      } catch (error) {
        // 401/403 mean the credential was rejected — say so plainly. The
        // message names neither the key nor the header value.
        if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
          throw new HttpError(`Brave Search API rejected the API key (HTTP ${error.status})`, {
            url: requestUrl,
            status: error.status,
            statusText: error.statusText,
            cause: error,
          });
        }
        throw error;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(fetched.html);
      } catch (cause) {
        throw new ParseError("Brave Search API returned invalid JSON", {
          url: requestUrl,
          cause,
        });
      }
      // `web` is absent on queries with no web hits (and on answer-only
      // responses) — an empty list, not an error.
      const webResults =
        typeof payload === "object" && payload !== null
          ? (payload as { web?: { results?: unknown } }).web?.results
          : undefined;
      if (!Array.isArray(webResults)) return [];
      const hits: SearchResult[] = [];
      for (const entry of webResults) {
        if (typeof entry !== "object" || entry === null) continue;
        const { url: hitUrl, title, description } = entry as Record<string, unknown>;
        // A hit without a usable URL is dropped — the provider payload is
        // untrusted data, and `url` is the only field downstream can rely on.
        if (typeof hitUrl !== "string" || hitUrl === "") continue;
        hits.push({
          url: hitUrl,
          ...(typeof title === "string" ? { title } : {}),
          ...(typeof description === "string" ? { description } : {}),
        });
      }
      return hits;
    },
  };
}
