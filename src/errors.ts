/**
 * The crawlio error taxonomy.
 *
 * Every error crawlio itself throws is a `ScrapeError` or one of its subclasses,
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
    // Not a parseable URL — strip a leading `//user:pass@` textually. The
    // match runs through the LAST `@` before the path, so a password that
    // itself contains `@` (`user:p@ss@host`) leaves no fragment behind.
    return url.replace(/^([a-z][a-z0-9+.-]*:\/\/|\/\/)[^/?#]*@/iu, "$1");
  }
}

/**
 * Strip credentials embedded in an error's `message` — for transport-layer
 * failures whose cause may carry a credentialed URL (an undici/Bun proxy
 * error can embed the proxy URL it failed to connect through).
 *
 * For each `secretUrls` entry the RAW string is replaced by its
 * {@link scrubUrl} form. Because transports embed the credential in
 * different spellings, three more representations are masked: the URL's
 * NORMALIZED serialization (which rewrites the raw string), the
 * percent-ENCODED `user:pass` pair, and the RAW userinfo substring —
 * a password containing `@`, `:`, `%`, or a space appears verbatim
 * in the message even though it parses to a different encoded form.
 *
 * A cause that scrubbed to a different message is wrapped in a fresh
 * `Error` preserving `name`, every other own property (`code`,
 * custom fields), `cause` (recursively scrubbed), and `stack` — so
 * `err.code === "ECONNREFUSED"` callers keep working. Everything else
 * (non-Error causes, nothing found) passes through untouched.
 *
 * Internal (not part of the public API) — shared by the fetch and proxy
 * layers.
 *
 * @param cause The raw thrown error.
 * @param secretUrls URLs whose credentials must not survive in the message.
 * @returns `cause`, or a message-scrubbed clone of it.
 */
export function scrubErrorCredentials(
  cause: unknown,
  secretUrls: readonly string[],
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  // Error shapes are untrusted — a cyclic `cause` chain must not recurse
  // forever. Returning the RAW node on a revisit would also leak it: the
  // parent's `scrubbedCause === cause.cause` check would read "unchanged"
  // and adopt the unscrubbed object as `clean.cause`. A marker both
  // terminates the recursion and keeps the raw node out of the clone.
  if (typeof cause === "object" && cause !== null) {
    if (seen.has(cause)) return new Error("[circular cause]");
    seen.add(cause);
  }
  if (!(cause instanceof Error) || secretUrls.length === 0) return cause;
  let message = cause.message;
  for (const raw of secretUrls) {
    const scrubbed = scrubUrl(raw);
    if (scrubbed !== raw) message = message.split(raw).join(scrubbed);
    try {
      const parsed = new URL(raw);
      // The normalized serialization differs from the raw config string
      // whenever the URL carries anything the WHATWG parser rewrites.
      const normalized = parsed.toString();
      const scrubbedNormalized = scrubUrl(normalized);
      if (scrubbedNormalized !== normalized) {
        message = message.split(normalized).join(scrubbedNormalized);
      }
      if (parsed.username !== "" || parsed.password !== "") {
        // Encoded pair AND raw userinfo: a raw password with `@`/`:`/`%`/
        // spaces shows up verbatim even though `parsed.password` encodes it.
        // `[^/?#]*` in the userinfo patterns is greedy, so the match
        // runs through the LAST `@` before the path — same as scrubUrl's
        // textual fallback.
        message = message.split(`${parsed.username}:${parsed.password}`).join("***:***");
        const rawUserinfo =
          /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)@/i.exec(raw)?.[1] ?? /^\/\/([^/?#]*)@/.exec(raw)?.[1];
        if (rawUserinfo !== undefined) {
          message = message.split(`${rawUserinfo}@`).join("***@");
        }
      }
    } catch {
      // Not a parseable URL — the raw-string replacement above is all there is.
    }
  }
  const scrubbedCause = scrubErrorCredentials(cause.cause, secretUrls, seen);
  if (message === cause.message && scrubbedCause === cause.cause) return cause;
  const clean = new Error(message);
  clean.name = cause.name;
  // Clone every own property except the ones reset here — undici errors
  // carry `.code` (ECONNREFUSED, …) and custom fields callers match on; a
  // bare-Error clone silently dropped them.
  for (const key of Object.getOwnPropertyNames(cause)) {
    if (key === "name" || key === "message" || key === "stack" || key === "cause") continue;
    const desc = Object.getOwnPropertyDescriptor(cause, key);
    if (desc !== undefined) Object.defineProperty(clean, key, desc);
  }
  if (cause.cause !== undefined) clean.cause = scrubbedCause;
  // The first stack line embeds the message — scrub it there too.
  if (typeof cause.stack === "string") {
    clean.stack = cause.stack.split(cause.message).join(message);
  }
  return clean;
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
  /**
   * Set `false` for deterministic failures the retry layer must NOT retry —
   * e.g. a redirect to a non-http(s) scheme or an exhausted redirect budget:
   * the outcome cannot change on a second attempt.
   */
  retryable?: boolean;
}

/** Base class for every error thrown by crawlio. */
export class ScrapeError extends Error {
  /** Machine-readable failure category. */
  readonly code: ScrapeErrorCode;
  /** The URL being worked on, when one is known, scrubbed of credentials. */
  readonly url?: string;
  /** `false` marks a deterministic failure the retry layer must not retry. */
  readonly retryable?: boolean;

  constructor(code: ScrapeErrorCode, message: string, options?: ScrapeErrorOptions) {
    // `cause` is declared by Error itself (lib.es2022.error) and must be handed to
    // super() so the standard `cause` chain and stack traces stay intact.
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    if (options?.url !== undefined) this.url = scrubUrl(options.url);
    if (options?.retryable !== undefined) this.retryable = options.retryable;
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
