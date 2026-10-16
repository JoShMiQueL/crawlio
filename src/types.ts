import type { CheerioOptions } from "cheerio";
import type { ScrapeError } from "./errors.js";

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
 * Infer the runtime type produced for a given field spec. This is the core product.
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
 *   milliseconds, re-drawn for every request. Useful with `stealth` so request
 *   cadence is not a metronome.
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
 * Pluggable CAPTCHA solver.
 *
 * The SDK ships NO built-in solver: solving is delegated to user-provided
 * integrations (2Captcha, CapSolver, CapMonster, self-hosted, ...). API keys
 * and provider config live inside the user's implementation — never in SDK
 * config. Honest caveats: solver services are external and usually paid, and a
 * solved challenge does not guarantee access — IP reputation, TLS
 * fingerprinting, and rate limits still apply.
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
   * identifiable `scrape-sdk/<version>` User-Agent and minimal headers.
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
  /** Injected fetch implementation (useful for tests). */
  fetch?: typeof globalThis.fetch;
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
   * `scrape-sdk/<version>`; a per-call `userAgent` wins.
   */
  userAgent?: string;
  /** Default per-request timeout in milliseconds. */
  timeout?: number;
  /** Default number of retries after the first attempt. */
  retries?: number;
  /** Instance default for {@link FetchHtmlOptions.robots}. Defaults to true. */
  robots?: boolean;
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
