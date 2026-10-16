import { decodeBody } from "./charset.js";
import { FetchError, HttpError, scrubUrl, TimeoutError } from "./errors.js";
import { fuseSignal } from "./signal.js";
import type { FetchHtmlOptions, FetchHtmlResult } from "./types.js";
import { VERSION } from "./version.js";

/**
 * Default User-Agent: an identifiable `scrape-sdk/<version>` — honest by
 * default, overridable per call or per scraper via `userAgent`.
 */
export const DEFAULT_USER_AGENT = `scrape-sdk/${VERSION}`;
/** Default per-request timeout in milliseconds. */
export const DEFAULT_TIMEOUT = 10_000;
/** Default number of retries after the first attempt (4 tries in total). */
export const DEFAULT_RETRIES = 3;

const ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

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
 * @param url The URL to request (already normalized to a string).
 * @param options Per-request options.
 * @param fetchImpl Fetch implementation; defaults to the global `fetch`.
 */
export async function fetchHtmlOnce(
  url: string,
  options: FetchHtmlOptions = {},
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<FetchHtmlResult> {
  const impl = options.fetch ?? fetchImpl;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;

  const controller = new AbortController();
  const fused = fuseSignal(controller.signal, options.signal);
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await impl(url, {
      headers: {
        "user-agent": userAgent,
        accept: ACCEPT,
        ...options.headers,
      },
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
