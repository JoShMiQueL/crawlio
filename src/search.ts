import { ConfigError, FetchError, HttpError, ParseError, ScrapeError, scrubUrl } from "./errors.js";
import { fetchHtmlOnce } from "./fetch.js";
import { withRetries } from "./retry.js";
import type { FetchHtmlResult } from "./types.js";

/** One hit returned by a {@link SearchProvider}. */
export interface SearchResult {
  /** The hit's URL. */
  url: string;
  /** The page title the provider reported, when it sent one. */
  title?: string;
  /** A short text snippet describing the hit, when the provider sent one. */
  description?: string;
}

/** Per-call options the SDK hands to {@link SearchProvider.search}. */
export interface SearchCallOptions {
  /**
   * Cap on returned results. Passed to the provider so it can bound the work
   * server-side; {@link search} also enforces it client-side, since a provider
   * is under no obligation to honour it exactly.
   */
  limit?: number;
  /** Per-request timeout in milliseconds — the same budget a page fetch gets. */
  timeout?: number;
  /**
   * Retries after the first attempt (total attempts = `retries + 1`) — the
   * same budget a page fetch gets through the shared retry policy.
   */
  retries?: number;
  /** The caller's abort signal — honor it (abandon the request). */
  signal?: AbortSignal;
}

/**
 * A pluggable web-search backend — the seam between crawlio and external
 * search providers, mirroring how {@link Renderer} plugs in a browser engine.
 *
 * crawlio ships NO search index (a declared non-goal): `search` delegates to a
 * provider. {@link braveSearchProvider} is the reference implementation over
 * the Brave Search API; anything implementing this interface works — a
 * self-hosted SearXNG, another commercial API, a fixture-driven stub.
 * Credentials and provider config live inside the provider — never in SDK
 * config.
 */
export interface SearchProvider {
  /**
   * Run `query` and return the hits.
   *
   * @param query The already-trimmed search query (never empty).
   * @param options Per-call budget; see {@link SearchCallOptions}.
   * @returns The hits the provider returned.
   */
  search(query: string, options?: SearchCallOptions): Promise<SearchResult[]>;
}

/** Options accepted by {@link search}: the provider plus per-call budget. */
export interface SearchOptions extends SearchCallOptions {
  /** The provider the query is delegated to — required. */
  provider: SearchProvider;
}

/**
 * Search the web through a {@link SearchProvider} — the `/search` counterpart
 * to {@link scrape}/{@link map}/{@link crawl}.
 *
 * The provider is INJECTED, never bundled: crawlio has no search index of its
 * own. {@link braveSearchProvider} covers the Brave Search API; any object
 * implementing {@link SearchProvider} slots in instead.
 *
 * The query is trimmed and must be non-empty ({@link ConfigError} otherwise).
 * `options.limit` is forwarded to the provider AND enforced client-side on
 * the returned list — a provider's `count` is a hint, not a contract.
 *
 * Provider results are validated like raw page data before they enter the
 * SDK's public types: non-arrays reject as {@link ConfigError} (a provider is
 * a user callback, like `solver`/`render`), and entries without a string
 * `url` are dropped rather than propagated.
 *
 * @param query The search query.
 * @param options The provider and per-call budget; see {@link SearchOptions}.
 * @returns The validated hits, capped at `options.limit` when given.
 *
 * @example
 * const results = await search("crawlio sdk", {
 *   provider: braveSearchProvider(), // BRAVE_API_KEY env
 *   limit: 10,
 * });
 * const pages = await scrapeMany(results.map((r) => r.url), { title: "h1" });
 */
export async function search(query: string, options: SearchOptions): Promise<SearchResult[]> {
  const provider = options?.provider;
  if (provider === undefined || provider === null || typeof provider.search !== "function") {
    throw new ConfigError("`search` requires a `provider` implementing `search(query, options)`");
  }
  const trimmed = typeof query === "string" ? query.trim() : "";
  if (trimmed === "") {
    throw new ConfigError("`query` must be a non-empty string");
  }
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0)) {
    throw new ConfigError(`\`limit\` must be a non-negative integer, got ${options.limit}`);
  }
  if (options.timeout !== undefined && options.timeout < 0) {
    throw new ConfigError(`\`timeout\` must be non-negative, got ${options.timeout}`);
  }

  if (
    options.retries !== undefined &&
    (!Number.isInteger(options.retries) || options.retries < 0)
  ) {
    throw new ConfigError(`\`retries\` must be a non-negative integer, got ${options.retries}`);
  }
  // `limit: 0` is a complete answer — an empty list — so resolve it here
  // instead of spending a provider call (and its quota) on discarded hits.
  if (options.limit === 0) return [];

  // `raw` is deliberately `unknown`: a provider is user code and may return
  // anything — the array/entry validation below is what earns the cast.
  let raw: unknown;
  try {
    raw = await provider.search(trimmed, {
      limit: options.limit,
      timeout: options.timeout,
      retries: options.retries,
      signal: options.signal,
    });
  } catch (cause) {
    // A provider is a user callback, like `solver`/`render`: a caller abort
    // surfaces as FetchError, a ScrapeError passes through, anything else is
    // wrapped in ConfigError so the taxonomy holds.
    if (cause instanceof ScrapeError) throw cause;
    if (options.signal?.aborted) {
      // However the provider reacted to the dead signal, a caller abort is a
      // FetchError — never ConfigError, never the raw (possibly non-Error)
      // abort reason.
      throw new FetchError("Request aborted by caller", { cause });
    }
    if (cause instanceof DOMException && cause.name === "AbortError") {
      throw new FetchError("Request aborted by caller", { cause });
    }
    throw new ConfigError("Search provider failed", { cause });
  }

  // Providers are user code — their return value is untrusted input. A
  // non-array is a provider bug (ConfigError, same rule as a throwing
  // callback); entries missing a string `url` are dropped — a hit without a
  // URL is useless downstream and usually means a partial provider payload.
  if (!Array.isArray(raw)) {
    throw new ConfigError("Search provider returned a non-array result");
  }
  const results: SearchResult[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { url, title, description } = entry as Record<string, unknown>;
    if (typeof url !== "string" || url === "") continue;
    results.push({
      url,
      ...(typeof title === "string" ? { title } : {}),
      ...(typeof description === "string" ? { description } : {}),
    });
  }
  return options.limit === undefined ? results : results.slice(0, options.limit);
}

/** Options accepted by {@link braveSearchProvider}. */
export interface BraveSearchProviderOptions {
  /**
   * Brave Search API key. Defaults to the `BRAVE_API_KEY` environment
   * variable; an explicit value wins. Travels in the `X-Subscription-Token`
   * header ONLY — never in the request URL — so it cannot leak through error
   * `url`s, logs, or fixtures.
   */
  apiKey?: string;
  /**
   * API endpoint. Defaults to Brave's web-search endpoint; overridable for
   * tests and proxies.
   */
  baseUrl?: string;
  /** Injected fetch implementation (useful for tests). */
  fetch?: typeof globalThis.fetch;
}

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
  const apiKey = (options.apiKey ?? process.env.BRAVE_API_KEY)?.trim();
  if (apiKey === undefined || apiKey === "") {
    throw new ConfigError(
      "`braveSearchProvider` needs an API key — pass `apiKey` or set the BRAVE_API_KEY environment variable",
    );
  }
  const baseUrl = options.baseUrl ?? BRAVE_DEFAULT_BASE_URL;
  let endpoint: URL;
  try {
    // Parse once at construction: validation stays eager (a malformed
    // baseUrl fails here, not on the first query) and each call clones the
    // parsed URL instead of re-parsing the string.
    endpoint = new URL(baseUrl);
  } catch (cause) {
    throw new ConfigError(`\`baseUrl\` must be a valid URL, got ${scrubUrl(baseUrl)}`, { cause });
  }
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
