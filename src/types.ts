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
       * `href`, `src`, `srcset`, `action`, `poster`, `cite`, `data`, `formaction` —
       * so `content`, `alt`, `title` and `data-*` values are returned verbatim. Set
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
   * `srcset`, `action`, `poster`, `cite`, `data`, `formaction`) are resolved, so a
   * `content`, `alt` or `data-*` value is never turned into a URL. Already-absolute
   * values are left untouched, blank values stay blank, and values that cannot be
   * resolved are passed through as-is. Per-field overrides live on
   * {@link FieldSpec} as `resolve`.
   */
  baseUrl?: string | URL;
  /** Parser options forwarded to {@link parseHtml} when the scrape layer owns parsing. */
  parseOptions?: ParseOptions;
};

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
  /** Default false — opt-in. Set true to honor robots.txt. */
  robots?: boolean;
  /** Throw an {@link HttpError} on non-2xx responses. Defaults to true. */
  throwOnHttpError?: boolean;
  /** Abort signal. */
  signal?: AbortSignal;
  /** Injected fetch implementation (useful for tests). */
  fetch?: typeof globalThis.fetch;
}

/** The decoded result of a single fetched page. */
export interface FetchHtmlResult {
  url: string;
  status: number;
  statusText?: string;
  html: string;
  contentType: string | null;
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
  userAgent?: string;
  timeout?: number;
  retries?: number;
  robots?: boolean;
  concurrency?: number;
  fetch?: typeof globalThis.fetch;
}

/** A stateful scraper created by `createScraper`. */
export interface Scraper {
  readonly userAgent: string;
  fetchHtml(url: string | URL, options?: FetchHtmlOptions): Promise<FetchHtmlResult>;
  scrape<S extends FieldSpecRecord>(
    url: string | URL,
    fields: S,
    options?: ScrapeOptions,
  ): Promise<ExtractResult<S>>;
  scrapeAll<S extends FieldSpecRecord>(
    url: string | URL,
    container: string,
    fields: S,
    options?: ScrapeOptions,
  ): Promise<Array<ExtractResult<S>>>;
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
      readonly url: string;
      readonly ok: true;
      readonly data: ExtractResult<S>;
      readonly status: number;
    }
  | {
      readonly url: string;
      readonly ok: false;
      readonly error: ScrapeError;
      readonly status?: number;
    };
