/**
 * Shared plumbing for the built-in HTTP search-provider adapters
 * (`brave.ts`, `serper.ts`, `tavily.ts`): each takes the same
 * credential/endpoint/transport triple ({@link HttpSearchProviderOptions}),
 * resolves its API key through {@link resolveApiKey}, validates its endpoint
 * through {@link parseBaseUrl}, and — for the POST-style providers — ships
 * the query through {@link postSearchJson} and maps hits with
 * {@link mapSearchHits}. Internal module: the public surface re-exports only
 * `HttpSearchProviderOptions`, through `../search.js`.
 */
import { ConfigError, HttpError, ParseError, scrubUrl } from "../errors.js";
import { fetchHtmlOnce } from "../fetch.js";
import { withRetries } from "../retry.js";
import type { SearchCallOptions, SearchResult } from "../search.js";
import type { FetchHtmlResult } from "../types.js";

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
export function resolveApiKey(
  explicit: string | undefined,
  envName: string,
  adapterName: string,
): string {
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
export function parseBaseUrl(baseUrl: string): URL {
  try {
    return new URL(baseUrl);
  } catch (cause) {
    throw new ConfigError(`\`baseUrl\` must be a valid URL, got ${scrubUrl(baseUrl)}`, {
      cause,
    });
  }
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
export async function postSearchJson(
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
export function mapSearchHits(
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
