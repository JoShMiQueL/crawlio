import { decodeBody } from "./charset.js";
import {
  ConfigError,
  FetchError,
  HttpError,
  ResponseTooLargeError,
  ScrapeError,
  scrubErrorCredentials,
  scrubUrl,
  showValue,
  TimeoutError,
} from "./errors.js";
import { assertPublicHost, type HostLookup, systemHostLookup } from "./private-hosts.js";
import { defaultFetch, PROXY_FETCH_CONFLICT, ProxyPool } from "./proxy.js";
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
/**
 * Ceiling on `retries` anywhere it is accepted — a typo'd count must not
 * retry near-forever. Shared by `createScraper` and `search` so both input
 * surfaces bound retries identically.
 */
export const MAX_RETRIES = 20;
/**
 * Default ceiling on a decoded response body (10 MiB): a hostile or broken
 * target streaming gigabytes must not OOM the process. `maxBodyBytes`
 * overrides per call; `Infinity` disables the cap.
 */
export const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

const ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

/**
 * Only http(s) URLs are fetchable — `file:`, `data:`, `ftp:` are not
 * pages. This is a SCHEME-level allowlist: private/loopback IP filtering
 * is the opt-in `blockPrivateHosts` guard (private-hosts.ts), applied per
 * redirect hop below — without it, pivots to private or loopback targets
 * remain the caller's responsibility.
 */
const HTTP_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * Redirect statuses {@link fetchHtmlOnce} follows hop by hop —
 * `redirect: "manual"` leaves them to us so caller headers can be stripped
 * on cross-origin hops and non-http(s) targets refused.
 */
export const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
/** Bound on followed redirects — a redirect loop must not run forever. */
export const MAX_REDIRECTS = 20;

/**
 * Header names that must not cross an origin boundary on a redirect —
 * credential- or privacy-bearing. The whole `sec-fetch-*` family is
 * stripped too: fetch metadata describes the OLD origin's request context.
 */
const CROSS_ORIGIN_STRIPPED = [
  "cookie",
  "referer",
  "origin",
  "authorization",
  "proxy-authorization",
  // A caller-set Host names the OLD origin's vhost — meaningless and
  // misleading once the hop crosses origins.
  "host",
];

/**
 * Request-body headers — meaningless once a 301/302/303 rewrites to GET.
 * `transfer-encoding` with a dropped body is a request-smuggling smell;
 * `content-md5`/`trailer` describe body bytes that no longer exist.
 */
const BODY_HEADERS = [
  "content-encoding",
  "content-language",
  "content-length",
  "content-location",
  "content-type",
  "content-md5",
  "transfer-encoding",
  "trailer",
];

/**
 * A copy of `headers` minus the names a cross-origin redirect hop must not
 * carry: {@link CROSS_ORIGIN_STRIPPED} plus every `sec-fetch-*`, deleted
 * case-insensitively through the Headers API.
 */
function stripCrossOriginHeaders(headers: Record<string, string>): Record<string, string> {
  const cleaned = new Headers(headers);
  for (const name of CROSS_ORIGIN_STRIPPED) cleaned.delete(name);
  for (const name of [...cleaned.keys()]) {
    if (name.startsWith("sec-fetch-")) cleaned.delete(name);
  }
  return Object.fromEntries(cleaned);
}

/** A copy of `headers` minus {@link BODY_HEADERS} — for the 30x → GET rewrite. */
function stripBodyHeaders(headers: Record<string, string>): Record<string, string> {
  const cleaned = new Headers(headers);
  for (const name of BODY_HEADERS) cleaned.delete(name);
  return Object.fromEntries(cleaned);
}

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
 * Internal test seam, deliberately NOT on the public {@link FetchHtmlOptions}
 * (mirrors `InternalScraperOptions.__proxyPool` in scraper.ts): a DNS
 * resolver override for `blockPrivateHosts` tests — a hostname resolving to
 * a private address can be exercised without touching real DNS. Set it via
 * a cast; it is not public API and may change without notice.
 */
interface InternalFetchHtmlOptions extends FetchHtmlOptions {
  __dnsLookup?: HostLookup;
}

/**
 * Read `response`'s body into memory under a hard byte ceiling.
 *
 * A declared `Content-Length` over `maxBytes` fails WITHOUT reading a byte —
 * the body is cancelled so its connection can be released. A chunked or
 * lengthless body is streamed through `response.body.getReader()` (the Web
 * Streams API undici and Bun both implement), counting as it goes and
 * cancelling the moment the cap is exceeded, so memory use stays ~O(cap).
 * The `arrayBuffer()` path remains for bodies without a reader.
 *
 * Internal (not part of the public API) — shared with `src/robots.ts`,
 * whose fixed 512 KiB robots.txt cap rides the same helper.
 */
export async function readResponseBody(
  response: Response,
  maxBytes: number,
  url: string,
): Promise<Uint8Array> {
  const rawLength = response.headers.get("content-length");
  const declared = rawLength === null ? undefined : Number(rawLength);
  if (declared !== undefined && Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError(
      `Response body exceeds the ${maxBytes}-byte cap — Content-Length declares ${declared}`,
      { url, bytes: declared, limit: maxBytes },
    );
  }
  const body = response.body;
  const reader = body?.getReader?.();
  if (reader === undefined) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new ResponseTooLargeError(
        `Response body exceeds the ${maxBytes}-byte cap (${buffer.byteLength} bytes)`,
        { url, bytes: buffer.byteLength, limit: maxBytes },
      );
    }
    return new Uint8Array(buffer);
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(
        `Response body exceeds the ${maxBytes}-byte cap — aborted after ${received} bytes`,
        { url, bytes: received, limit: maxBytes },
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Perform exactly one HTTP request and decode the body.
 *
 * This is deliberately the non-retried, non-robots layer: retries live in
 * `createScraper` (via `withRetries`) and robots gating lives there too. Keeping
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
 * @param fetchImpl Fetch implementation; defaults to {@link defaultFetch}
 *   (the env-proxy-normalized `fetch`). This is the same injection slot as
 *   `options.fetch` — a non-default impl combined with `proxy`/`proxies`
 *   is the same {@link ConfigError} conflict. The impl MUST honor
 *   `redirect: "manual"` — cross-origin header stripping and scheme
 *   gating below depend on redirects reaching this function as 30x
 *   responses rather than being followed inside the impl.
 */
export async function fetchHtmlOnce(
  url: string,
  options: FetchHtmlOptions = {},
  fetchImpl: typeof globalThis.fetch = defaultFetch,
): Promise<FetchHtmlResult> {
  // `body` needs a body-capable method: GET/HEAD cannot carry one, and
  // undici would throw a raw TypeError from the Request constructor —
  // after which the shared retry policy would waste every attempt on a
  // deterministic config mistake. Method names normalize to uppercase per
  // the fetch spec, so compare case-insensitively ("get" IS GET).
  const method = options.method ?? "GET";
  const normalizedMethod = method.toUpperCase();
  if (options.body !== undefined && (normalizedMethod === "GET" || normalizedMethod === "HEAD")) {
    throw new ConfigError(
      `\`body\` requires a body-capable \`method\` — ${JSON.stringify(method)} requests cannot carry one`,
      { url },
    );
  }
  // Scheme allowlist at the fetch choke point: `new URL` alone accepts
  // `file:` (Bun's fetch reads local files) and `data:` — neither is a page.
  let requestUrl: URL;
  try {
    requestUrl = new URL(url);
  } catch (cause) {
    throw new ConfigError(`Invalid URL ${scrubUrl(url)}`, { cause });
  }
  if (!HTTP_PROTOCOLS.has(requestUrl.protocol)) {
    throw new ConfigError(
      `\`fetchHtmlOnce\` only supports http(s) URLs, got ${requestUrl.protocol}`,
      { url },
    );
  }
  // `blockPrivateHosts` is fail-CLOSED semantics (enforced when === true),
  // so a non-boolean must error rather than silently pick "off" — `1` would
  // otherwise disable the guard the caller meant to enable. Same rule as
  // the `robots` flag's validation one layer up. Config validation runs
  // BEFORE any resource allocation below (the per-call proxy pool's sockets
  // would leak on a throw after its creation).
  if (options.blockPrivateHosts !== undefined && typeof options.blockPrivateHosts !== "boolean") {
    throw new ConfigError(
      `\`blockPrivateHosts\` must be a boolean, got ${showValue(options.blockPrivateHosts)}`,
      { url },
    );
  }
  const blockPrivateHosts = options.blockPrivateHosts === true;
  const hostLookup = (options as InternalFetchHtmlOptions).__dnsLookup ?? systemHostLookup;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  // `!(x > 0)` rejects NaN as well as zero/negatives; `Infinity` passes and
  // simply never trips the cap — the documented "disabled" spelling.
  if (typeof maxBodyBytes !== "number" || !(maxBodyBytes > 0)) {
    throw new ConfigError(
      `\`maxBodyBytes\` must be a positive number of bytes (Infinity disables), got ${showValue(options.maxBodyBytes)}`,
      { url },
    );
  }
  let impl = options.fetch ?? fetchImpl;
  // The proxy URLs this call may route through — also the credentials
  // scrubbed from a transport error's `cause` below.
  const proxyUrls = options.proxy !== undefined ? [options.proxy] : (options.proxies ?? []);
  // Per-call proxy routing for direct callers: a one-shot, stateless pool —
  // sticky per-origin state lives with createScraper, not here.
  let perCallPool: ProxyPool | undefined;
  if (options.proxy !== undefined || options.proxies !== undefined) {
    // A non-default positional `fetchImpl` is the same injection as
    // `options.fetch` — a custom impl cannot be routed through a proxy
    // dispatcher, so it is the same conflict rather than being silently
    // ignored. `defaultFetch` and a bare `globalThis.fetch` both count as
    // "no custom impl" (the latter is what a caller passing `fetch` through
    // explicitly looks like). (The scraper never reaches this branch: it
    // resolves proxies itself and passes the already-bound fetch
    // positionally without proxy options.)
    if (
      options.fetch !== undefined ||
      (fetchImpl !== defaultFetch && fetchImpl !== globalThis.fetch)
    ) {
      throw new ConfigError(PROXY_FETCH_CONFLICT, { url });
    }
    const origin = requestUrl.origin;
    perCallPool = new ProxyPool({ proxies: proxyUrls, rotation: options.proxyRotation });
    impl = perCallPool.fetchFor(origin);
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

  // Redirects are followed MANUALLY, hop by hop: `redirect: "follow"` would
  // forward caller headers (cookie/authorization/…) across origins verbatim
  // and — under Bun — can leave http(s) entirely (a 30x to `file:` reads
  // local files). `currentUrl` tracks the landing URL ourselves because
  // `response.url` is not reliable under manual redirect handling.
  let currentUrl = url;
  let currentMethod = normalizedMethod;
  let currentBody = options.body;
  let currentHeaders =
    profile === undefined
      ? overlayHeaders({ "user-agent": userAgent, accept: ACCEPT }, options.headers)
      : overlayHeaders({ ...profile, "user-agent": userAgent }, options.headers);

  try {
    let response: Response;
    let hops = 0;
    for (;;) {
      // `blockPrivateHosts` re-resolves EVERY hop's host before the wire
      // request fires — a redirect can pivot from a public name to a
      // private literal or a hostname freshly resolving private, and the
      // initial-URL check alone would miss it. This is a lookup-time gate
      // (TOCTOU — see the option's docs).
      if (blockPrivateHosts) await assertPublicHost(currentUrl, hostLookup);
      response = await impl(currentUrl, {
        // `method`/`body` exist for API-backed callers (search providers POST
        // JSON); page scraping never sets them — the scrape path rejects them
        // outright — so the wire request stays a plain GET.
        method: currentMethod,
        body: currentBody,
        headers: currentHeaders,
        signal: fused.signal,
        redirect: "manual",
      });
      const location = response.headers.get("location");
      // A redirect status without a Location is the final answer — the same
      // treatment `redirect: "follow"` gives it.
      if (!REDIRECT_STATUSES.has(response.status) || location === null || location === "") break;
      hops += 1;
      // Release the redirect response's body so its connection can be
      // reused — BEFORE the hop-count throw, which must not leak it.
      if (response.body !== null) {
        await response.body.cancel().catch(() => undefined);
      }
      if (hops > MAX_REDIRECTS) {
        throw new FetchError(`Too many redirects (>${MAX_REDIRECTS}) fetching ${scrubUrl(url)}`, {
          // Deterministic: a loop never exits on its own — do not retry.
          url: currentUrl,
          retryable: false,
        });
      }
      let next: URL;
      try {
        next = new URL(location, currentUrl);
      } catch (cause) {
        throw new FetchError(`Unparseable redirect target ${scrubUrl(location)}`, {
          url: currentUrl,
          cause,
          retryable: false,
        });
      }
      if (!HTTP_PROTOCOLS.has(next.protocol)) {
        throw new FetchError(`Refusing a redirect off http(s) to ${scrubUrl(next.toString())}`, {
          url: currentUrl,
          retryable: false,
        });
      }
      if (next.origin !== new URL(currentUrl).origin) {
        currentHeaders = stripCrossOriginHeaders(currentHeaders);
      }
      // Per the fetch spec a 301/302/303 turns a non-GET/HEAD request into a
      // body-less GET — relevant to this function's API callers (search
      // providers POST); page fetches are already GET. A 307/308 instead
      // replays `currentBody` verbatim — a non-replayable body (a
      // ReadableStream) cannot survive a second hop; search-provider POST
      // bodies are strings, so they replay fine.
      if (
        (response.status === 301 || response.status === 302 || response.status === 303) &&
        currentMethod !== "GET" &&
        currentMethod !== "HEAD"
      ) {
        currentMethod = "GET";
        currentBody = undefined;
        currentHeaders = stripBodyHeaders(currentHeaders);
      }
      currentUrl = next.toString();
    }

    // A custom impl may follow redirects internally — its reported
    // `response.url` is then a hop the manual loop never vetted. When it
    // matches `currentUrl` the hop was already checked, so the lookup is
    // skipped (saves a redundant DNS resolution per fetch). The check runs
    // before the body is read; the request itself already fired, which
    // lookup-time gating cannot prevent (the TOCTOU caveat).
    if (blockPrivateHosts && response.url !== "" && response.url !== currentUrl) {
      try {
        await assertPublicHost(response.url, hostLookup);
      } catch (cause) {
        // Release the response's connection before the refusal propagates —
        // the body is never read from here.
        await response.body?.cancel().catch(() => undefined);
        throw cause;
      }
    }

    if (!response.ok && options.throwOnHttpError !== false) {
      throw new HttpError(`HTTP ${response.status} ${response.statusText}`.trim(), {
        url: currentUrl,
        status: response.status,
        statusText: response.statusText,
      });
    }

    const bytes = await readResponseBody(response, maxBodyBytes, currentUrl);
    const contentType = response.headers.get("content-type");
    const html = decodeBody(bytes, contentType);

    return {
      // `response.url` wins when the impl reports one (a custom fetch may
      // still follow redirects internally); otherwise the hop we ended on.
      url: scrubUrl(response.url || currentUrl),
      status: response.status,
      statusText: response.statusText,
      html,
      contentType,
      headers: response.headers,
    };
  } catch (cause) {
    if (cause instanceof ScrapeError) throw cause;
    if (cause instanceof DOMException && cause.name === "AbortError") {
      // A caller abort is deliberately a FetchError, not a raw DOMException:
      // the taxonomy promises every SDK-thrown error is a ScrapeError. The
      // retry policy recognises the AbortError `cause` and never retries it.
      if (options.signal?.aborted) {
        throw new FetchError("Request aborted by caller", { url: currentUrl, cause });
      }
      throw new TimeoutError("Request timed out", { url: currentUrl, cause });
    }
    throw new FetchError(`Failed to fetch ${scrubUrl(url)}`, {
      url: currentUrl,
      // A proxy-layer error can embed the credentialed proxy URL — scrub it
      // out of the cause's message before it rides the FetchError.
      cause: scrubErrorCredentials(cause, proxyUrls),
    });
  } finally {
    clearTimeout(timer);
    fused.release();
    // The stateless per-call pool dies with this request — close its
    // pooled clients (undici ProxyAgent / Bun.FetchSession) here rather
    // than leaving their keep-alive sockets to idle-timeout. `close()`
    // settles best-effort and never rejects.
    await perCallPool?.close();
  }
}
