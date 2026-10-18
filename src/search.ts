import { ConfigError, FetchError, ScrapeError } from "./errors.js";
import { MAX_RETRIES } from "./fetch.js";
import { braveSearchProvider } from "./search/brave.js";
import { serperSearchProvider } from "./search/serper.js";
import { tavilySearchProvider } from "./search/tavily.js";

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
  // Same rules as the scraper surface: a non-finite timeout collapses to an
  // instant timer, and an unbounded retries count can retry near-forever.
  if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout < 0)) {
    throw new ConfigError(
      `\`timeout\` must be a non-negative finite number, got ${options.timeout}`,
    );
  }

  if (
    options.retries !== undefined &&
    (!Number.isInteger(options.retries) || options.retries < 0 || options.retries > MAX_RETRIES)
  ) {
    throw new ConfigError(
      `\`retries\` must be an integer between 0 and ${MAX_RETRIES}, got ${options.retries}`,
    );
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

// Re-exported adapter surface — the built-in adapters live in `search/`
// (mirroring the `render/` layout) and share their plumbing through
// `search/shared.js`, but the public API stays on this module:
// `import { braveSearchProvider } from "crawlio"` keeps working unchanged.
export type { BraveSearchProviderOptions } from "./search/brave.js";
export type { SerperSearchProviderOptions } from "./search/serper.js";
export type { HttpSearchProviderOptions } from "./search/shared.js";
export type { TavilySearchProviderOptions } from "./search/tavily.js";
export { braveSearchProvider, serperSearchProvider, tavilySearchProvider };
