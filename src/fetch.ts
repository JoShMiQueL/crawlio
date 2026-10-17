import { decodeBody } from "./charset.js";
import { ConfigError, FetchError, HttpError, scrubUrl, TimeoutError } from "./errors.js";
import { PROXY_FETCH_CONFLICT, ProxyPool } from "./proxy.js";
import { fuseSignal } from "./signal.js";
import { headerKey, resolveStealth, stealthRequestHeaders } from "./stealth.js";
import type { FetchHtmlOptions, FetchHtmlResult } from "./types.js";
import { VERSION } from "./version.js";

/**
 * Default User-Agent: an identifiable `crawlio/<version>` — honest by
 * default, overridable per call or per scraper via `userAgent`.
 */
export const DEFAULT_USER_AGENT = `crawlio/${VERSION}`;
/** Default per-request timeout in milliseconds. */
export const DEFAULT_TIMEOUT = 10_000;
/** Default number of retries after the first attempt (4 tries in total). */
export const DEFAULT_RETRIES = 3;

const ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

/**
 * Spread `caller` over `base` with HTTP header semantics: a caller header
 * DISPLACES a same-named base key case-insensitively. Plain object spread would
 * keep `accept-language` AND `Accept-Language` as two entries — both would go
 * on the wire (a bot tell with an undefined winner).
 */
function overlayHeaders(
  base: Record<string, string>,
  caller: Record<string, string> | undefined,
): Record<string, string> {
  if (caller === undefined) return base;
  for (const [key, value] of Object.entries(caller)) {
    const existing = headerKey(base, key);
    if (existing !== undefined) delete base[existing];
    base[key] = value;
  }
  return base;
}

/**
 * Perform exactly one HTTP request and decode the body.
 *
 * This is deliberately the non-retried, non-robots layer: retries live in
 * `createScraper` (via `p-retry`) and robots gating lives there too. Keeping
 * them out of this function means a single attempt is testable on its own and
 * the retry policy is in exactly one place.
 *
 * A non-OK response throws {@link HttpError} unless `throwOnHttpError === false`,
 * in which case the (error-status) response is returned so the caller can read it.
 *
 * With `options.stealth` enabled, the request carries the resolved browser
 * profile's full header set instead of the honest minimal pair — the stateless
 * half of stealth. The stateful half (cookie jar, referer chain) and solver
 * retries live in `createScraper`, one layer up.
 *
 * @param url The URL to request (already normalized to a string).
 * @param options Per-request options.
 * @param fetchImpl Fetch implementation; defaults to the global `fetch`. This
 *   is the same injection slot as `options.fetch` — a non-default impl
 *   combined with `proxy`/`proxies` is the same {@link ConfigError} conflict.
 */
export async function fetchHtmlOnce(
  url: string,
  options: FetchHtmlOptions = {},
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<FetchHtmlResult> {
  let impl = options.fetch ?? fetchImpl;
  // Per-call proxy routing for direct callers: a one-shot, stateless pool —
  // sticky per-origin state lives with createScraper, not here.
  if (options.proxy !== undefined || options.proxies !== undefined) {
    // A non-default positional `fetchImpl` is the same injection as
    // `options.fetch` — a custom impl cannot be routed through a proxy
    // dispatcher, so it is the same conflict rather than being silently
    // ignored. (The scraper never reaches this branch: it resolves proxies
    // itself and passes the already-bound fetch positionally without proxy
    // options.)
    if (options.fetch !== undefined || fetchImpl !== globalThis.fetch) {
      throw new ConfigError(PROXY_FETCH_CONFLICT, { url });
    }
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch (cause) {
      throw new ConfigError(`Invalid URL ${scrubUrl(url)}`, { cause });
    }
    impl = new ProxyPool({
      proxies: options.proxy !== undefined ? [options.proxy] : (options.proxies ?? []),
      rotation: options.proxyRotation,
    }).fetchFor(origin);
  }
  const stealth = resolveStealth(options.stealth);
  const profile = stealth === null ? undefined : stealthRequestHeaders(stealth);
  // UA precedence: explicit `userAgent` > stealth profile > honest default.
  // An explicit UA under stealth keeps the profile's other headers — keeping
  // the combination browser-consistent is then the caller's job (documented on
  // StealthOptions).
  const userAgent = options.userAgent ?? profile?.["user-agent"] ?? DEFAULT_USER_AGENT;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;

  const controller = new AbortController();
  const fused = fuseSignal(controller.signal, options.signal);
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await impl(url, {
      headers:
        profile === undefined
          ? overlayHeaders({ "user-agent": userAgent, accept: ACCEPT }, options.headers)
          : overlayHeaders({ ...profile, "user-agent": userAgent }, options.headers),
      signal: fused.signal,
    });

    if (!response.ok && options.throwOnHttpError !== false) {
      throw new HttpError(`HTTP ${response.status} ${response.statusText}`.trim(), {
        url,
        status: response.status,
        statusText: response.statusText,
      });
    }

    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const contentType = response.headers.get("content-type");
    const html = decodeBody(bytes, contentType);

    return {
      url: scrubUrl(response.url || url),
      status: response.status,
      statusText: response.statusText,
      html,
      contentType,
      headers: response.headers,
    };
  } catch (cause) {
    if (cause instanceof HttpError) throw cause;
    if (cause instanceof DOMException && cause.name === "AbortError") {
      // A caller abort is deliberately a FetchError, not a raw DOMException:
      // the taxonomy promises every SDK-thrown error is a ScrapeError. The
      // retry policy recognises the AbortError `cause` and never retries it.
      if (options.signal?.aborted) {
        throw new FetchError("Request aborted by caller", { url, cause });
      }
      throw new TimeoutError("Request timed out", { url, cause });
    }
    throw new FetchError(`Failed to fetch ${scrubUrl(url)}`, { url, cause });
  } finally {
    clearTimeout(timer);
    fused.release();
  }
}
