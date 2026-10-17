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

/**
 * The built-in providers {@link search} can resolve by name — the search-side
 * counterpart to `render`'s `engine` names. Each maps to the
 * `<name>SearchProvider` adapter with its env-var API-key default. This list
 * is the single source of truth: the registry keys, the
 * {@link SearchProviderName} type, and the CLI's `--provider` validation all
 * derive from it.
 */
export const SEARCH_PROVIDER_NAMES = ["brave", "serper", "tavily"] as const;

/** A built-in provider name — one of {@link SEARCH_PROVIDER_NAMES}. */
export type SearchProviderName = (typeof SEARCH_PROVIDER_NAMES)[number];

/** Options accepted by {@link search}: the provider plus per-call budget. */
export interface SearchOptions extends SearchCallOptions {
  /**
   * The provider the query is delegated to — required. Either a
   * {@link SearchProvider} object, or the name of a built-in adapter
   * ({@link SearchProviderName}), which resolves with its env-var API-key
   * fallback (`BRAVE_API_KEY`, `SERPER_API_KEY`, `TAVILY_API_KEY`).
   */
  provider: SearchProvider | SearchProviderName;
  /**
   * API key for a NAME-resolved provider — forwarded to the adapter factory,
   * overriding its env-var fallback. Ignored when `provider` is a
   * {@link SearchProvider} object: an object carries its own config.
   */
  apiKey?: string;
}

/**
 * Name → adapter factory, backing the `provider: "<name>"` shorthand. The
 * factories take only an optional explicit key — everything else (baseUrl,
 * fetch) stays the adapter's default, which is what makes the shorthand
 * zero-config.
 */
const SEARCH_PROVIDER_REGISTRY: Record<SearchProviderName, (apiKey?: string) => SearchProvider> = {
  brave: (apiKey) => braveSearchProvider(apiKey === undefined ? {} : { apiKey }),
  serper: (apiKey) => serperSearchProvider(apiKey === undefined ? {} : { apiKey }),
  tavily: (apiKey) => tavilySearchProvider(apiKey === undefined ? {} : { apiKey }),
};

/**
 * Turn `options.provider` into a {@link SearchProvider}: a name resolves
 * through {@link SEARCH_PROVIDER_REGISTRY} (a factory that throws — e.g. a
 * missing API key — surfaces its own {@link ConfigError}); an object is
 * validated to actually implement the interface.
 */
function resolveSearchProvider(
  provider: SearchProvider | SearchProviderName | undefined,
  apiKey: string | undefined,
): SearchProvider {
  if (typeof provider === "string") {
    // `Object.hasOwn`, never a bare index lookup: an inherited member
    // ("toString", "constructor") would resolve as a "factory" and explode
    // later, and "__proto__" would throw a raw TypeError right here —
    // outside the ScrapeError taxonomy. Every non-own name must get the
    // same ConfigError as any other unknown provider.
    if (!Object.hasOwn(SEARCH_PROVIDER_REGISTRY, provider)) {
      const names = SEARCH_PROVIDER_NAMES.map((name) => `"${name}"`).join(", ");
      throw new ConfigError(
        `Unknown search provider ${JSON.stringify(provider)} — expected one of ${names}`,
      );
    }
    return SEARCH_PROVIDER_REGISTRY[provider as SearchProviderName](apiKey);
  }
  if (provider === undefined || provider === null || typeof provider.search !== "function") {
    throw new ConfigError("`search` requires a `provider` implementing `search(query, options)`");
  }
  return provider;
}

/**
 * Search the web through a {@link SearchProvider} — the `/search` counterpart
 * to {@link scrape}/{@link map}/{@link crawl}.
 *
 * The provider is INJECTED, never bundled: crawlio has no search index of its
 * own. `options.provider` takes a built-in name (`"brave"`, `"serper"`,
 * `"tavily"` — resolved through {@link SEARCH_PROVIDER_REGISTRY} with the
 * matching env-var key, or `options.apiKey`) or any object implementing
 * {@link SearchProvider}.
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
 *   provider: "brave", // BRAVE_API_KEY env — or `apiKey: "..."`
 *   limit: 10,
 * });
 * // Equivalent, configurable form:
 * const results2 = await search("crawlio sdk", {
 *   provider: braveSearchProvider(),
 *   limit: 10,
 * });
 * const pages = await scrapeMany(results.map((r) => r.url), { title: "h1" });
 */
export async function search(query: string, options: SearchOptions): Promise<SearchResult[]> {
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

  // The provider resolves LAST, after every input validation: a caller bug
  // (empty query, bad limit/timeout/retries) must report itself, not the
  // missing API key a name-resolved factory would demand — and `limit: 0`
  // never needs a provider at all.
  const provider = resolveSearchProvider(options?.provider, options?.apiKey);

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

/**
 * Options shared by the built-in HTTP search-provider adapters —
 * {@link braveSearchProvider}, {@link serperSearchProvider}, and
 * {@link tavilySearchProvider} all take the same credential/endpoint/transport
 * triple. Each adapter's own options type is this base under its name; the
 * adapter's docblock names its env-var fallback and auth header.
 */
export interface HttpSearchProviderOptions {
  /**
   * API key. Defaults to the adapter's environment variable; an explicit
   * value wins. Travels in a request header ONLY — never in the request URL
   * or body — so it cannot leak through error `url`s, logs, or fixtures.
   */
  apiKey?: string;
  /**
   * API endpoint. Defaults to the adapter's endpoint; overridable for tests
   * and proxies.
   */
  baseUrl?: string;
  /** Injected fetch implementation (useful for tests). */
  fetch?: typeof globalThis.fetch;
}

/**
 * Resolve a provider API key: the explicit option wins over the env-var
 * fallback; neither is a construction-time {@link ConfigError}, not a
 * mid-call failure.
 */
function resolveApiKey(explicit: string | undefined, envName: string, adapterName: string): string {
  const apiKey = (explicit ?? process.env[envName])?.trim();
  if (apiKey === undefined || apiKey === "") {
    throw new ConfigError(
      `\`${adapterName}\` needs an API key — pass \`apiKey\` or set the ${envName} environment variable`,
    );
  }
  return apiKey;
}

/**
 * Parse and eagerly validate a provider `baseUrl`: a malformed value fails
 * at construction, not on the first query. GET providers clone the parsed
 * URL per call; POST providers stringify it once.
 */
function parseBaseUrl(baseUrl: string): URL {
  try {
    return new URL(baseUrl);
  } catch (cause) {
    throw new ConfigError(`\`baseUrl\` must be a valid URL, got ${scrubUrl(baseUrl)}`, {
      cause,
    });
  }
}

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

/**
 * POST a JSON query through the shared fetch machinery and decode the reply —
 * the common plumbing of the POST-style providers (Serper, Tavily).
 *
 * The API key arrives inside `authHeader`, NOT in `payload`: keeping it out of
 * the body means it cannot leak through payload dumps or logs of the request
 * the way a body-carried `api_key` field could, and never through the URL.
 * Requests go through `fetchHtmlOnce` (honest `crawlio/<version>` User-Agent,
 * timeout, abort handling) wrapped in the shared {@link withRetries} policy —
 * a 429 or 5xx retries with backoff, a caller abort does not.
 *
 * A 401/403 surfaces as an {@link HttpError} saying the key was rejected —
 * the message names neither the key nor the header value. Malformed JSON is a
 * {@link ParseError}.
 */
async function postSearchJson(
  providerName: string,
  requestUrl: string,
  authHeader: Record<string, string>,
  payload: Record<string, unknown>,
  call: SearchCallOptions,
  fetchImpl: typeof globalThis.fetch,
): Promise<unknown> {
  let fetched: FetchHtmlResult;
  try {
    fetched = await withRetries(
      () =>
        fetchHtmlOnce(
          requestUrl,
          {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              ...authHeader,
            },
            body: JSON.stringify(payload),
            timeout: call.timeout,
            signal: call.signal,
          },
          fetchImpl,
        ),
      { retries: call.retries, signal: call.signal, url: requestUrl },
    );
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
      throw new HttpError(`${providerName} API rejected the API key (HTTP ${error.status})`, {
        url: requestUrl,
        status: error.status,
        statusText: error.statusText,
        cause: error,
      });
    }
    throw error;
  }
  try {
    return JSON.parse(fetched.html);
  } catch (cause) {
    throw new ParseError(`${providerName} API returned invalid JSON`, {
      url: requestUrl,
      cause,
    });
  }
}

/**
 * Read `payload[listKey]` as untrusted data and map entries to
 * {@link SearchResult}s: `urlKey` supplies `url` (a hit without one is
 * dropped — a URL-less hit is useless downstream), `title` always comes from
 * `title`, and `contentKey` supplies `description`. A missing or non-array
 * list is an empty result, not an error — providers omit it when there are
 * no hits.
 */
function mapSearchHits(
  payload: unknown,
  listKey: string,
  urlKey: string,
  contentKey: string,
): SearchResult[] {
  const list =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)[listKey]
      : undefined;
  if (!Array.isArray(list)) return [];
  const hits: SearchResult[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const hitUrl = record[urlKey];
    if (typeof hitUrl !== "string" || hitUrl === "") continue;
    const title = record.title;
    const content = record[contentKey];
    hits.push({
      url: hitUrl,
      ...(typeof title === "string" ? { title } : {}),
      ...(typeof content === "string" ? { description: content } : {}),
    });
  }
  return hits;
}

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
