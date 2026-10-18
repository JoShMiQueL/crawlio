import type { CheerioOptions } from "cheerio";
import type { ScrapeError } from "./errors.js";
import type { Renderer, RenderMode } from "./render.js";

/**
 * A field spec: either a bare CSS selector, or an options object.
 *
 * The bare-string form is shorthand for `{ selector: <string> }` and reads the
 * first match's text content.
 */
export type FieldSpec =
  | string
  | {
      /** CSS selector, resolved relative to the current extraction scope. */
      selector: string;
      /** Read this attribute instead of the text content. */
      attr?: string;
      /** Extract every match into an array instead of just the first. */
      all?: boolean;
      /** Map the raw string to a richer type (e.g. `parseFloat`). */
      transform?: (raw: string) => unknown;
      /**
       * Force (`true`) or forbid (`false`) resolving this field's value against
       * {@link ExtractOptions.baseUrl}.
       *
       * By default resolution applies only to attributes that actually carry URLs —
       * `href`, `src`, `action`, `poster`, `cite`, `data`, `formaction` —
       * so `content`, `alt`, `title` and `data-*` values are returned verbatim.
       * (`srcset` is deliberately excluded — its value is a candidate list, not
       * one URL; see `URL_ATTRIBUTES` in extract.ts.) Set
       * this to `true` for a URL stashed in another attribute (e.g. `data-href`), or
       * to `false` to keep a `href` exactly as the page wrote it.
       */
      resolve?: boolean;
    };

/** A record of named {@link FieldSpec}s — the shape of an extraction spec. */
export type FieldSpecRecord = Record<string, FieldSpec>;

/**
 * Infer the runtime type produced for a given field spec.
 *
 * Precedence: `transform` first, then `all`, then the plain "text of the first
 * match" case.
 *
 * - `{ selector, transform }` → `R | undefined`. `transform` is never invoked when
 *   the selector matched nothing, so the result can legitimately be `undefined`.
 * - `{ selector, all: true, transform }` → `R[]` (`transform` applied per element;
 *   an empty array when nothing matched, never `undefined`).
 * - `{ selector, all: true }` → `string[]`.
 * - anything else (including a bare string selector) → `string | undefined`.
 *
 * How `all` is read, precisely:
 *
 * - `all: true` — the literal type → `string[]`. This is what an object literal passed
 *   straight into `extract`/`extractAll` infers to, and what `as const` pins. (A fresh
 *   `true` keeps its literal type while being inferred into `S`; the constraint's
 *   `all?: boolean` widens nothing. `as const` is what preserves it in a spec built
 *   elsewhere.)
 * - `all: boolean` — the widened form a standalone `const` declaration produces
 *   without `as const`. It also maps to `string[]`.
 *   **Caveat:** if such a flag is computed at runtime and can be `false`, the declared
 *   type lies — runtime returns a single value. Use `all: true as const` if the flag is
 *   dynamic but must stay truthy, or drop inference and read `string[] | undefined`.
 * - `all: false` — matches the first branch explicitly → `string | undefined`, which
 *   is exactly what the runtime returns, so type and behaviour agree.
 * - `all?: boolean` (i.e. the widened `FieldSpec` itself) — an optional property
 *   satisfies neither `{ all: false }` nor `{ all: boolean }` under `strictNullChecks`,
 *   so the conditional collapses to `string | undefined` for *every* field. That
 *   direction is safe (the declared type is narrower than reality) but it throws
 *   inference away entirely, so annotate specs with an inferred object type —
 *   `const fields = {…}` or `satisfies FieldSpecRecord` — never with the
 *   `FieldSpecRecord` alias itself.
 */
export type FieldValue<F extends FieldSpec> = F extends {
  transform: (raw: string) => infer R;
}
  ? F extends { all: false }
    ? R | undefined
    : F extends { all: boolean }
      ? R[]
      : R | undefined
  : F extends { all: false }
    ? string | undefined
    : F extends { all: boolean }
      ? string[]
      : string | undefined;

/** The result object: one key per declared field, typed by inference. */
export type ExtractResult<S extends FieldSpecRecord> = {
  [K in keyof S]: FieldValue<S[K]>;
};

/**
 * Pass-through options forwarded to cheerio's `load()`.
 *
 * Note on malformed markup: `parseNoneClosedTags` and `preserveTagNesting` were
 * removed in cheerio 1.x — both of cheerio's parsers (parse5 and htmlparser2 v10)
 * now recover from unclosed tags unconditionally, so there is no knob to turn off.
 * Only options that still exist upstream are exposed here.
 *
 * @see {@link https://cheerio.js.org/docs/api/options | cheerio options}
 */
export type ParseOptions = Pick<CheerioOptions, "baseURI" | "quirksMode" | "pseudos">;

/** Options controlling extraction behaviour. */
export type ExtractOptions = {
  /**
   * Base used to resolve relative URL values obtained via `attr`.
   *
   * Resolution is deliberately narrow: only URL-carrying attributes (`href`, `src`,
   * `action`, `poster`, `cite`, `data`, `formaction`) are resolved — `srcset` is
   * excluded on purpose (a candidate list, not one URL; see `URL_ATTRIBUTES` in
   * extract.ts) — so a
   * `content`, `alt` or `data-*` value is never turned into a URL. Already-absolute
   * values are left untouched, blank values stay blank, and values that cannot be
   * resolved are passed through as-is. Per-field overrides live on
   * {@link FieldSpec} as `resolve`.
   */
  baseUrl?: string | URL;
  /** Parser options forwarded to {@link parseHtml} when the scrape layer owns parsing. */
  parseOptions?: ParseOptions;
};

/**
 * How long to wait between consecutive requests to the same origin.
 *
 * - a `number` — a fixed gap in milliseconds;
 * - `{ min, max }` — a gap sampled uniformly at random in `[min, max]`
 *   milliseconds, re-drawn for every request so request cadence is not a
 *   fixed, detectable rhythm.
 *
 * Validation is strict: `min >= 0`, `max >= min`, both finite — anything else
 * throws {@link ConfigError}.
 */
export type RequestDelay =
  | number
  | {
      /** Minimum delay in milliseconds (inclusive). Must be `>= 0`. */
      min: number;
      /** Maximum delay in milliseconds (inclusive). Must be `>= min`. */
      max: number;
    };

/**
 * Controls the opt-in stealth behaviour of {@link FetchHtmlOptions.stealth}.
 *
 * Stealth is HTTP-layer only: it makes requests LOOK like a desktop browser at
 * the header level — a full, internally consistent header set (User-Agent plus
 * the `sec-ch-ua` client hints/`sec-fetch-*` metadata a real browser sends for
 * a top-level document GET), a per-origin cookie jar, a referer chain across
 * same-origin navigations, and (combined with a range `requestDelay`) jittered
 * pacing. It deliberately does NOT touch the transport: TLS/JA3 and HTTP/2
 * fingerprints still identify the client as Node's undici — to fix that, inject
 * an impersonating transport via {@link FetchHtmlOptions.fetch}.
 *
 * Consistency rule: the headers sent must tell the SAME browser story. A
 * Chrome `user-agent` without the matching `sec-ch-ua` hints is itself a tell,
 * which is why the profiles below are complete header sets rather than a lone
 * UA string. Overriding `userAgent` or individual `headers` on top of a profile
 * can break that story — when you do, keep the pieces consistent yourself.
 */
export interface StealthOptions {
  /**
   * Browser family to mimic: `"chrome"` | `"firefox"` | `"safari"`.
   * Default `"chrome"`. Profiles are realistic desktop snapshots (Chrome 131 /
   * Firefox 133 / Safari 18 era); only the Chrome profile sends `sec-ch-ua`
   * client hints, matching real browsers.
   */
  browser?: "chrome" | "firefox" | "safari";
  /**
   * Locale used for `Accept-Language`. Default `"en-US"` (sent as
   * `en-US,en;q=0.9` — `q=0.5` on Firefox — like a real browser does).
   */
  locale?: string;
  /**
   * Persist `Set-Cookie` response headers per origin and resend matching
   * cookies on later requests. Default `true` when stealth is on.
   *
   * The jar is intentionally minimal: `Expires`/`Max-Age` are honored (evicted
   * lazily on read) and `Secure` cookies are only sent over https, but `Domain`
   * subdomain scoping and `Path` are NOT modeled — cookies belong to an origin
   * and are sent to every path on it.
   */
  cookies?: boolean;
  /**
   * Send `Referer: <last fetched page>` on subsequent same-origin requests.
   * Default `true` when stealth is on. The first request to an origin sends no
   * `Referer` and `sec-fetch-site: none` — like a typed-URL visit. An explicit
   * per-call `headers.referer` always wins.
   */
  refererChain?: boolean;
}

/** What the SDK hands a {@link CaptchaSolver} when it detects a challenge page. */
export interface CaptchaChallenge {
  /** The page URL that returned the challenge. */
  url: string;
  /** Challenge type detected. */
  type: "turnstile" | "recaptcha" | "hcaptcha" | "cloudflare-interstitial";
  /** Extracted `sitekey`/`data-sitekey` when present. */
  sitekey?: string;
  /**
   * Raw challenge page HTML — solvers needing extra fields (Cloudflare's
   * `action`/`cData`/`pageData`, etc.) read them from this.
   */
  html: string;
  /**
   * The egress proxy the failed request used (`http://[user:pass@]host:port`),
   * when it went through a `proxy`/`proxies` pool — clearance-type solutions
   * are IP-bound, so a solver must ride this same egress or the solved
   * cookie is worthless. Absent when the request went out direct.
   */
  proxyUrl?: string;
  /**
   * The User-Agent the failed request carried — clearance solutions are also
   * bound to a UA, so solvers should keep this same one when the provider
   * asks which UA to solve with.
   */
  userAgent?: string;
}

/**
 * What a {@link CaptchaSolver} returns: credentials to retry the request with.
 *
 * The v1 retry contract is cookies + User-Agent: `cookies` (e.g. a solved
 * `cf_clearance` from an interstitial solver) are ALWAYS recorded into the
 * per-scraper cookie jar — the persistence channel — and applied to the retry
 * (via the jar when stealth cookies are enabled, else as a one-shot header),
 * and a solution-bound `userAgent` is reused verbatim, since clearances are
 * typically bound to the UA that solved them. `token` answers (injected into
 * a `cf-turnstile-response`/`g-recaptcha-response` form field) cannot be
 * applied generically by a plain GET retry and are carried for the solver's
 * own use — form-post challenge flows are out of v1 scope.
 */
export interface CaptchaSolution {
  /**
   * Solved token (`cf-turnstile-response` / `g-recaptcha-response`). The SDK
   * does NOT submit it for you — see the interface docs.
   */
  token?: string;
  /**
   * Cookies to set on the retry (e.g. `cf_clearance` from interstitial
   * solvers). Always recorded into the per-scraper cookie jar, so they persist
   * for later requests whose options enable stealth cookies.
   */
  cookies?: Record<string, string>;
  /** UA the solution is bound to — the retry MUST reuse it verbatim. */
  userAgent?: string;
}

/**
 * How a {@link FetchHtmlOptions.proxies} pool hands out proxies.
 *
 * - `"per-origin"` (default) — each target origin binds to one proxy on first
 *   touch (round-robin across the pool) and keeps it. Session consistency is
 *   the point: cookies and solved clearances (a `cf_clearance` is bound to
 *   the issuing IP) stay valid only while the origin exits through the same
 *   IP.
 * - `"per-request"` — round-robin on every wire request.
 *   **Warning:** consecutive requests to one origin leave through different
 *   IPs — cookie jars, referer chains, and solved clearances stop telling a
 *   coherent story. Use only for stateless fan-out.
 * - `"on-ban"` — `per-origin` plus health: the origin's proxy is reassigned
 *   on ban signals (transport failure, HTTP 407/403/429, a detected challenge
 *   page, or a timeout). A proxy that fails 3 times in a row is quarantined
 *   for ~5 minutes and skipped until the cooldown expires.
 *   **Solver caveat:** a detected challenge page rebinds the origin BEFORE a
 *   configured solver runs, so a solved `cf_clearance` is applied from a
 *   different IP than the one that solved it — the clearance won't stick.
 *   Pair solvers with `per-origin` (or a single proxy), not `on-ban`.
 */
export type ProxyRotation = "per-origin" | "per-request" | "on-ban";

/**
 * Pluggable CAPTCHA solver.
 *
 * Solving is delegated to provider integrations: the SDK ships one built-in
 * (`capSolver`, CapSolver's `AntiCloudflareTask` for `cloudflare-interstitial`
 * challenges) and anything implementing this interface works — 2Captcha,
 * CapMonster, self-hosted, a fixture stub. API keys and provider config live
 * inside the solver — never in SDK config. Honest caveats, unchanged by the
 * built-in: solver services are external and usually paid, and a solved
 * challenge does not guarantee access — IP reputation, TLS fingerprinting,
 * and rate limits still apply.
 */
export interface CaptchaSolver {
  /**
   * Solve a detected challenge.
   *
   * @param challenge The detected challenge page data.
   * @param options.signal The caller's abort signal — honor it.
   * @returns Credentials to retry the request with.
   */
  solve(challenge: CaptchaChallenge, options: { signal?: AbortSignal }): Promise<CaptchaSolution>;
}

/** Options controlling a single HTTP fetch. */
export interface FetchHtmlOptions {
  /**
   * HTTP method. Defaults to `"GET"`. Non-GET methods are used by API-backed
   * callers driving {@link fetchHtmlOnce} directly (e.g. search providers
   * POSTing a JSON query); the `scrape`/`map`/`crawl` page pipeline always
   * issues GETs and rejects `method`/`body` with a {@link ConfigError}
   * rather than silently fetching a GET.
   */
  method?: string;
  /**
   * Request body, sent verbatim. Pair it with an explicit `content-type`
   * header via {@link FetchHtmlOptions.headers} — the SDK does not infer one.
   * Requires a body-capable {@link FetchHtmlOptions.method} (`POST`, ...) —
   * a body on a GET/HEAD request is a {@link ConfigError}. Same page-pipeline
   * restriction as `method`.
   */
  body?: string;
  /** Override the User-Agent header. */
  userAgent?: string;
  /** Extra headers sent with the request. */
  headers?: Record<string, string>;
  /** Per-request timeout in milliseconds. */
  timeout?: number;
  /** Number of retries after the first attempt (total attempts = `retries + 1`). */
  retries?: number;
  /**
   * Honor the origin's robots.txt. Defaults to true: `/robots.txt` is fetched
   * once per origin and cached, a disallowed URL throws {@link RobotsError}
   * before the page is requested, and a declared `Crawl-delay` is respected
   * (capped). An absent or unreachable robots.txt is treated as allow-all.
   * Set to false to skip the check entirely — that is the caller's
   * responsibility.
   */
  robots?: boolean;
  /**
   * Opt-in SSRF guard — OFF by default, since self-hosted callers
   * legitimately scrape intranet and localhost targets.
   *
   * When `true`, every request's host is vetted before the wire request
   * fires: private/reserved IP literals are refused outright, and hostnames
   * are resolved via DNS first — a refusal throws {@link BlockedHostError}
   * (`code: "blocked-host"`, never retried). Blocked ranges cover IPv4
   * private/loopback/link-local/CGNAT/benchmarking/documentation/multicast/
   * reserved space (10/8, 127/8, 169.254/16 — including the cloud metadata
   * endpoint 169.254.169.254 — 172.16/12, 192.168/16, 100.64/10, 0/8,
   * 192.0.0/24, 192.0.2/24, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4,
   * 240/4) and IPv6 (::1, fe80::/10, fc00::/7, ff00::/8), with
   * IPv4-embedded forms (`::ffff:`-mapped, `::`-compatible, 6to4, NAT64
   * 64:ff9b::/96 and 64:ff9b:1::/48) classified by their embedded address.
   * The range list is NOT exhaustive — it is a high-value denylist, not a
   * full IANA special-registry mirror. The check re-runs on EVERY redirect
   * hop — a `Location` pivot to a private target is refused too — and
   * applies to the robots.txt probe (whose redirects are followed
   * hop-by-hop while the guard is on).
   *
   * Honest limit — this is lookup-time gating (TOCTOU): the hostname is
   * re-resolved at connect time by the runtime's own resolver, which this
   * check cannot observe, so a determined host can rebind between lookup
   * and connect. A custom `fetch` that follows redirects internally also
   * bypasses the per-hop check (its reported final `response.url` is still
   * vetted). With `render`, only the initial navigation target is vetted —
   * redirects and subresources the page pulls INSIDE the browser are not.
   * With `proxy`/`proxies` the DNS check resolves locally while the proxy
   * resolves the same name independently, so the guard is correspondingly
   * less meaningful. For strict isolation, run crawlio in a
   * network-restricted environment (egress firewall/allowlist).
   *
   * As an instance default on `createScraper`, a per-call `false`
   * overrides an instance-level `true` — the same precedence as `robots`.
   */
  blockPrivateHosts?: boolean;
  /**
   * Maximum response body size in bytes. Default
   * {@link DEFAULT_MAX_BODY_BYTES} (10 MiB).
   *
   * A `Content-Length` over the cap fails fast without reading the body; a
   * chunked or lengthless body is streamed and aborted mid-read once the
   * cap is exceeded — either way a {@link ResponseTooLargeError}
   * (`code: "response-too-large"`, carrying `bytes` and `limit`, never
   * retried). The cap applies per response and counts the DECODED bytes the
   * runtime hands back. `Infinity` disables the cap; the value must be a
   * positive number otherwise.
   */
  maxBodyBytes?: number;
  /**
   * Serialize requests to the same origin. Defaults to true: one request per
   * origin at a time (the queue keys on `target.origin`, so http and https on
   * the same host are different origins). When false, same-origin requests may
   * run concurrently up to the global `concurrency` cap — the SDK no longer
   * paces same-origin traffic, so disabling this is the caller's
   * responsibility.
   *
   * Note that a per-call `false` wins over the instance default and does NOT
   * wait for work already queued on the origin — it can overlap an in-flight
   * serial call to the same origin.
   */
  serializePerOrigin?: boolean;
  /**
   * Minimum delay in milliseconds between consecutive requests to the same
   * origin. Default 0 — no extra pacing.
   *
   * Enforced inside the per-origin serial queue: a queued task sleeps
   * `requestDelay` before starting, so it paces the START of the next request
   * off the END of the previous one — a gap, not a period. The first request
   * to an origin is never delayed.
   *
   * Only applies while {@link FetchHtmlOptions.serializePerOrigin} is active:
   * with `serializePerOrigin: false` there is no queue and no pacing (the same
   * caveat as `Crawl-delay`, which is also honoured per request rather than
   * between them once serialization is off).
   *
   * Accepts a {@link RequestDelay}: a fixed number of milliseconds, or a
   * `{ min, max }` range sampled uniformly at random per request.
   */
  requestDelay?: RequestDelay;
  /**
   * Opt-in stealth behaviour. `false`/absent (the default) keeps the honest,
   * identifiable `crawlio/<version>` User-Agent and minimal headers.
   * `true` enables sensible defaults (a modern desktop Chrome profile);
   * a {@link StealthOptions} object gives control.
   *
   * Stealth is HTTP-layer only — see {@link StealthOptions} for what it covers
   * and what it cannot do (TLS/HTTP2 fingerprints, JS-rendered challenges, IP
   * reputation). When called directly on {@link fetchHtmlOnce}, only the
   * browser header profile applies — the cookie jar and referer chain are
   * per-`createScraper` state and live one layer up.
   */
  stealth?: boolean | StealthOptions;
  /**
   * Pluggable CAPTCHA solver. When set and a challenge page is detected in a
   * response (Cloudflare interstitial markers, Turnstile/reCAPTCHA/hCaptcha
   * widgets), the solver is invoked once and the request is retried ONCE with
   * the returned {@link CaptchaSolution}. Without a solver, challenge pages
   * surface normally (the page HTML, or an {@link HttpError} for error
   * statuses). A throwing solver is wrapped in {@link ConfigError} — it is a
   * user callback, like `transform`.
   *
   * See {@link CaptchaSolver} for the honesty caveats: solvers are external
   * services and a solved challenge is not guaranteed access.
   */
  solver?: CaptchaSolver;
  /** Throw an {@link HttpError} on non-2xx responses. Defaults to true. */
  throwOnHttpError?: boolean;
  /** Abort signal. */
  signal?: AbortSignal;
  /**
   * Injected fetch implementation (useful for tests). It serves the static
   * HTTP path and robots.txt only — the renderer is a separate engine and
   * never sees it.
   */
  fetch?: typeof globalThis.fetch;
  /**
   * Route this request through one pinned proxy:
   * `http://[user:pass@]host:port`. Wins over
   * {@link FetchHtmlOptions.proxies} and any instance-level proxy config.
   *
   * Credentials travel inside the URL (typically composed from environment
   * variables) and are never logged. SOCKS URLs are not supported in v1 —
   * inject a SOCKS-capable client via {@link FetchHtmlOptions.fetch} instead.
   * Cannot be combined with an injected `fetch` — that throws
   * {@link ConfigError}: a custom fetch cannot be routed through a proxy
   * dispatcher.
   */
  proxy?: string;
  /**
   * Route requests through a proxy pool (see {@link proxyRotation} for the
   * strategy). On a scraper instance (`ScraperOptions.proxies`) the pool is
   * stateful — origin bindings and proxy health are shared across calls.
   * **Per call, `proxies` builds a fresh stateless pool for that request** —
   * health tracking cannot carry over, so only `proxy` makes much sense
   * per-call.
   *
   * Same rules as {@link FetchHtmlOptions.proxy}: http(s) URLs only, no
   * SOCKS, and cannot be combined with an injected `fetch` ({@link ConfigError}).
   */
  proxies?: string[];
  /** Rotation strategy for {@link FetchHtmlOptions.proxies}. Default `"per-origin"`. */
  proxyRotation?: ProxyRotation;
  /**
   * Pluggable renderer for JavaScript-dependent pages — see {@link Renderer}.
   *
   * A renderer is "an expensive fetcher": it navigates a real browser engine,
   * waits, and returns the final HTML. It is INJECTED, never bundled — the
   * SDK ships no engine. The engine owns its own context: stealth headers,
   * the cookie jar, and proxy routing do NOT apply inside the browser, and
   * browser-side cookies do not flow back into the SDK's jar.
   *
   * Consulted according to {@link FetchHtmlOptions.renderMode}. Rendered HTML
   * flows through the same parse/extract pipeline as a static fetch, and
   * {@link FetchHtmlResult.rendered} records which path served.
   */
  render?: Renderer;
  /**
   * When {@link FetchHtmlOptions.render} is consulted. Default `"auto"`.
   *
   * - `"always"` — the static fetch is skipped entirely; the renderer is the
   *   fetch. A renderer failure propagates as the call's error.
   * - `"auto"` — a static fetch runs first; the renderer fires only when the
   *   result looks like a JS shell (`isLikelyDynamic`) or, on `scrape*`
   *   calls, when a fields spec extracted to all-`undefined`. A renderer
   *   failure falls back to the static result — `auto` never makes a page
   *   worse than the static answer.
   *
   * `retries` applies to the static HTTP path only — a renderer call is one
   * navigation, never retried. robots.txt gating applies to the URL before
   * either path fires.
   */
  renderMode?: RenderMode;
}

/** The decoded result of a single fetched page. */
export interface FetchHtmlResult {
  /** The final response URL (after redirects), scrubbed of credentials. */
  url: string;
  /** HTTP status code of the response. */
  status: number;
  /** HTTP status text — empty string when the response carried none. */
  statusText: string;
  /** The response body decoded to text (BOM → header charset → meta sniff → UTF-8). */
  html: string;
  /** Raw `Content-Type` header value, or null when the response had none. */
  contentType: string | null;
  /** The raw response headers. */
  headers: Headers;
  /**
   * Present and `true` when this page was served by the injected
   * {@link Renderer} rather than the static HTTP path — an honest signal of
   * which path answered. A rendered result carries no response headers or
   * content-type metadata (the engine owns its context), so `headers` is
   * empty and `status` defaults to 200 when the renderer did not report one.
   */
  rendered?: boolean;
}

/** Options controlling scraping behaviour (fetch + parse + extract). */
export interface ScrapeOptions extends FetchHtmlOptions {
  /** Base URL used to resolve relative links in extracted fields. Defaults to the page URL. */
  baseUrl?: string | URL;
  /** Options forwarded to {@link parseHtml}. */
  parseOptions?: ParseOptions;
  /** Concurrency limit for scraping multiple pages. */
  concurrency?: number;
}

/** Per-scraper defaults, merged under every call's per-request options. */
export interface ScraperOptions {
  /**
   * Default User-Agent header. Falls back to an identifiable
   * `crawlio/<version>`; a per-call `userAgent` wins.
   */
  userAgent?: string;
  /** Default per-request timeout in milliseconds. */
  timeout?: number;
  /** Default number of retries after the first attempt. */
  retries?: number;
  /** Instance default for {@link FetchHtmlOptions.robots}. Defaults to true. */
  robots?: boolean;
  /**
   * Instance default for {@link FetchHtmlOptions.blockPrivateHosts} — the
   * opt-in private-network (SSRF) guard. Off by default; set `true` when the
   * URLs come from untrusted input. See the option's docs for the blocked
   * ranges and the TOCTOU limit.
   */
  blockPrivateHosts?: boolean;
  /** Instance default for {@link FetchHtmlOptions.maxBodyBytes}. */
  maxBodyBytes?: number;
  /** Instance default for {@link FetchHtmlOptions.serializePerOrigin}. */
  serializePerOrigin?: boolean;
  /** Instance default for {@link FetchHtmlOptions.requestDelay}. */
  requestDelay?: RequestDelay;
  /**
   * Instance default for {@link FetchHtmlOptions.stealth}. The scraper holds
   * the stealth state (cookie jar, referer chain) shared across its calls.
   */
  stealth?: boolean | StealthOptions;
  /** Instance default for {@link FetchHtmlOptions.solver}. */
  solver?: CaptchaSolver;
  /**
   * Cap on requests in flight across ALL origins. A per-call value can only
   * lower the effective parallelism, never raise it above this cap.
   */
  concurrency?: number;
  /** Injected fetch implementation (useful for tests). */
  fetch?: typeof globalThis.fetch;
  /**
   * Instance default for {@link FetchHtmlOptions.proxy} — pin every request
   * through one proxy. Cannot be combined with an injected `fetch`.
   */
  proxy?: string;
  /**
   * Instance default for {@link FetchHtmlOptions.proxies}: a stateful proxy
   * pool shared across every call on this scraper — origin bindings and
   * proxy-health state live here, which is what makes {@link proxyRotation}
   * (especially `"on-ban"`) useful. Cannot be combined with an injected
   * `fetch` — a custom fetch cannot be routed through a proxy dispatcher;
   * pass a proxy-aware `fetch` (e.g. built on undici's `ProxyAgent`) instead.
   */
  proxies?: string[];
  /** Instance default for {@link FetchHtmlOptions.proxyRotation}. */
  proxyRotation?: ProxyRotation;
  /** Instance default for {@link FetchHtmlOptions.render}. */
  render?: Renderer;
  /** Instance default for {@link FetchHtmlOptions.renderMode}. */
  renderMode?: RenderMode;
}

/** A stateful scraper created by {@link createScraper}. */
export interface Scraper {
  /** The User-Agent this scraper sends by default; a per-call `userAgent` wins. */
  readonly userAgent: string;
  /** Fetch one page and return the decoded body plus response metadata. */
  fetchHtml(url: string | URL, options?: FetchHtmlOptions): Promise<FetchHtmlResult>;
  /**
   * Fetch `url`, parse it, and extract `fields`. The result type is inferred
   * from the spec — see {@link FieldValue}.
   */
  scrape<S extends FieldSpecRecord>(
    url: string | URL,
    fields: S,
    options?: ScrapeOptions,
  ): Promise<ExtractResult<S>>;
  /**
   * Like {@link Scraper.scrape} but extracts one record per `container` match,
   * with field selectors scoped strictly inside each container.
   */
  scrapeAll<S extends FieldSpecRecord>(
    url: string | URL,
    container: string,
    fields: S,
    options?: ScrapeOptions,
  ): Promise<Array<ExtractResult<S>>>;
  /**
   * Scrape several URLs with the same spec. Fails fast: the first rejection
   * rejects the whole batch (use {@link Scraper.scrapeManySafe} for per-URL
   * outcomes instead).
   */
  scrapeMany<S extends FieldSpecRecord>(
    urls: readonly (string | URL)[],
    fields: S,
    options?: ScrapeOptions,
  ): Promise<Array<ExtractResult<S>>>;
  /** Like {@link Scraper.scrapeMany} but never rejects — per-URL outcomes. */
  scrapeManySafe<S extends FieldSpecRecord>(
    urls: readonly (string | URL)[],
    fields: S,
    options?: ScrapeOptions,
  ): Promise<Array<ScrapeBatchItem<S>>>;
  /**
   * Discover the URLs of a site: declared sitemaps first, the seed page's own
   * links as fallback. See {@link MapResult} for the result shape.
   */
  map(url: string | URL, options?: MapOptions): Promise<MapResult>;
  /**
   * Recursively crawl same-origin pages breadth-first from `seedUrl`. See
   * {@link CrawlOptions} for depth/page bounds and filters.
   */
  crawl(seedUrl: string | URL, options?: CrawlOptions): Promise<CrawlResult>;
}

/** One entry of a batch scrape that never rejects. */
export type ScrapeBatchItem<S extends FieldSpecRecord> =
  | {
      /** The final fetched URL (post-redirects), scrubbed of credentials. */
      readonly url: string;
      readonly ok: true;
      /** Extracted fields, typed by the spec. */
      readonly data: ExtractResult<S>;
      /** HTTP status of the fetched page. */
      readonly status: number;
    }
  | {
      /** The requested URL, scrubbed of credentials. */
      readonly url: string;
      readonly ok: false;
      /** Why the scrape failed — always a {@link ScrapeError} subclass. */
      readonly error: ScrapeError;
      /** HTTP status, present only when an {@link HttpError} carried one. */
      readonly status?: number;
    };

/** Options controlling {@link Scraper.map} / the standalone `map`. */
export interface MapOptions extends FetchHtmlOptions {
  /**
   * Maximum number of URLs returned, applied after dedup and normalization.
   * Must be a non-negative integer.
   */
  limit?: number;
}

/** One discovered URL in a {@link MapResult}. */
export interface MapEntry {
  /** The normalized URL: absolute, fragment stripped, deduplicated. */
  url: string;
  /** The `<lastmod>` value verbatim, when the sitemap provided one. */
  lastModified?: string;
}

/** The outcome of {@link Scraper.map} / the standalone `map`. */
export interface MapResult {
  /** Discovered URLs, deduplicated and normalized. */
  urls: MapEntry[];
  /**
   * How the URLs were discovered: `"sitemap"` when at least one sitemap
   * document yielded entries, `"links"` when `map` fell back to extracting
   * same-origin anchors from the seed page itself.
   */
  source: "sitemap" | "links";
}

/** Options controlling {@link Scraper.crawl} / the standalone `crawl`. */
export interface CrawlOptions extends ScrapeOptions {
  /**
   * Ignored by crawl — inherited from {@link ScrapeOptions} only. Extraction
   * always resolves URLs against each page's own post-redirect URL, never a
   * caller-supplied base.
   */
  baseUrl?: string | URL;
  /**
   * Ignored by crawl — inherited from {@link ScrapeOptions} only. Page
   * fetches are deliberately sequential (BFS order, one at a time) for
   * politeness; a crawl never parallelises.
   */
  concurrency?: number;
  /**
   * How deep the crawl follows links from the seed: `0` fetches only the seed,
   * `1` also fetches its direct links, and so on. Default `2`. Must be a
   * non-negative integer.
   */
  maxDepth?: number;
  /**
   * Hard cap on pages fetched — politeness, not a target. The crawl stops
   * dequeuing once reached; URLs still queued count toward
   * {@link CrawlResult.skipped}. Default `50`. Must be a non-negative integer.
   */
  maxPages?: number;
  /**
   * Allowlist: when set and non-empty, a discovered URL is only enqueued when
   * it matches at least one pattern. Evaluated on the normalized URL string.
   * The seed itself is always visited.
   */
  include?: RegExp[];
  /**
   * Blocklist: a discovered URL matching any pattern is never enqueued.
   * Evaluated on the normalized URL string, after {@link CrawlOptions.include}.
   * The seed itself is always visited — it is enqueued before filters apply.
   */
  exclude?: RegExp[];
  /**
   * Optional per-page extraction spec: when set, every successfully fetched
   * page also gets its fields extracted into {@link CrawlPage.data} — the same
   * spec semantics as {@link Scraper.scrape} (page URL as `baseUrl`).
   */
  fields?: FieldSpecRecord;
}

/** One visited — or attempted — page of a crawl. */
export interface CrawlPage {
  /** The normalized URL that was requested. */
  url: string;
  /** Link distance from the seed (the seed itself is `0`). */
  depth: number;
  /**
   * Extracted fields, present only when {@link CrawlOptions.fields} was set
   * and the page's HTML was parsed successfully.
   */
  data?: Record<string, unknown>;
  /**
   * Why this page failed — always a {@link ScrapeError} subclass. A failed
   * page does not abort the crawl; any links its HTML still yielded are
   * enqueued normally.
   */
  error?: ScrapeError;
}

/** The outcome of {@link Scraper.crawl} / the standalone `crawl`. */
export interface CrawlResult {
  /** Every dequeued URL, in BFS order, with its outcome. */
  pages: CrawlPage[];
  /** Pages whose HTTP request completed (a response came back). */
  visited: number;
  /**
   * Candidate URLs that were discovered but never fetched: filtered out by
   * `include`/`exclude`, or left queued when `maxPages` or an abort stopped
   * the crawl. Duplicate links are not counted — they were already covered by
   * the page that first normalized to the same URL.
   */
  skipped: number;
}
