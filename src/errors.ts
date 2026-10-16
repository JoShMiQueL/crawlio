/**
 * The scrape-sdk error taxonomy.
 *
 * Every error scrape-sdk itself throws is a `ScrapeError` or one of its subclasses,
 * so callers can branch on `err.code` instead of matching message strings. That
 * includes errors raised by user callbacks the SDK invokes (`transform`): a throw
 * from one of those is wrapped in a {@link ConfigError} with the original kept as
 * `cause`, so a user's own data bug is never mistaken for an SDK fault.
 *
 * Fetch-level failures (`fetch`, `timeout`, `http`) and parse-level failures
 * (`parse`) are deliberately distinct codes: they are different bugs and mixing
 * them up is how a scraper silently scrapes garbage.
 *
 * One edge worth pinning: a caller-initiated abort (`AbortSignal`) surfaces as a
 * {@link FetchError} — not a raw `DOMException` — with the original `AbortError`
 * kept as `cause`. The retry layer recognises that cause and never retries a
 * deliberate abort; a real network `FetchError` is retried.
 */
export type ScrapeErrorCode = "fetch" | "timeout" | "http" | "parse" | "robots" | "config";

/**
 * Remove userinfo (`user:password@`) from a URL so credentials do not travel in the
 * URL itself. Non-URL strings are scrubbed with a textual fallback and otherwise
 * returned unchanged.
 *
 * What this guarantees is narrow, and deliberately so: it cleans the `url` property
 * that {@link ScrapeError} stores. It does NOT inspect `message` or `cause`, which
 * pass through verbatim — so any code that interpolates a URL into a message must
 * scrub it first (the fetch layer must do this; there is no interceptor here).
 *
 * Internal (not part of the public API) but exported for reuse by the fetch layer.
 *
 * @param url The URL to scrub.
 * @returns The URL without credentials.
 */
export function scrubUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username === "" && parsed.password === "") return url;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    // Not a parseable URL — strip a leading `//user:pass@` textually.
    return url.replace(/^([a-z][a-z0-9+.-]*:\/\/|\/\/)[^/?#@]*@/iu, "$1");
  }
}

/** Options accepted by {@link ScrapeError} and its subclasses. */
export interface ScrapeErrorOptions {
  /**
   * The URL being worked on, when one is known. Credentials are stripped before it is
   * stored — see {@link scrubUrl}. `message` and `cause` are NOT scrubbed.
   */
  url?: string;
  /** The underlying error, preserved for diagnostics. Stored verbatim. */
  cause?: unknown;
  /** HTTP status code, when the failure carried one ({@link HttpError}). */
  status?: number;
  /** HTTP status text, when the response carried one. */
  statusText?: string;
}

/** Base class for every error thrown by scrape-sdk. */
export class ScrapeError extends Error {
  /** Machine-readable failure category. */
  readonly code: ScrapeErrorCode;
  /** The URL being worked on, when one is known, scrubbed of credentials. */
  readonly url?: string;

  constructor(code: ScrapeErrorCode, message: string, options?: ScrapeErrorOptions) {
    // `cause` is declared by Error itself (lib.es2022.error) and must be handed to
    // super() so the standard `cause` chain and stack traces stay intact.
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    if (options?.url !== undefined) this.url = scrubUrl(options.url);
  }
}

/** Invalid configuration or an invalid extraction spec. Not a network problem. */
export class ConfigError extends ScrapeError {
  constructor(message: string, options?: ScrapeErrorOptions) {
    super("config", message, options);
  }
}

/** HTML could not be parsed, or a selector could not be compiled against it. */
export class ParseError extends ScrapeError {
  constructor(message: string, options?: ScrapeErrorOptions) {
    super("parse", message, options);
  }
}

/**
 * The request never completed (DNS, connection reset, TLS, ...), or the caller
 * aborted it — in the abort case `cause` is the `AbortError` DOMException and
 * the retry layer will not retry it.
 */
export class FetchError extends ScrapeError {
  constructor(message: string, options?: ScrapeErrorOptions) {
    super("fetch", message, options);
  }
}

/** The request timed out. */
export class TimeoutError extends ScrapeError {
  constructor(message: string, options?: ScrapeErrorOptions) {
    super("timeout", message, options);
  }
}
/** The server answered with a non-OK HTTP status. */
export class HttpError extends ScrapeError {
  /** The non-OK status the server answered with. */
  readonly status: number;
  /** The status text, when the response carried one. */
  readonly statusText?: string;
  constructor(message: string, options?: ScrapeErrorOptions | number, status?: number) {
    const opts = typeof options === "number" ? undefined : options;
    const resolvedStatus = typeof options === "number" ? options : (status ?? opts?.status ?? 0);
    const text = opts?.statusText;
    super("http", message, opts);
    this.status = resolvedStatus;
    if (text !== undefined) this.statusText = text;
    else if (opts?.statusText !== undefined) this.statusText = opts.statusText;
  }
}

/** robots.txt forbids the request. */
export class RobotsError extends ScrapeError {
  constructor(message: string, options?: ScrapeErrorOptions) {
    super("robots", message, options);
  }
}
