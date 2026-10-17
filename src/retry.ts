import pRetry from "p-retry";
import { FetchError, HttpError, RobotsError, ScrapeError, TimeoutError } from "./errors.js";
import { DEFAULT_RETRIES } from "./fetch.js";

/**
 * Whether a failure is worth retrying. `p-retry` already short-circuits plain
 * `TypeError`s (non-network bugs), so an explicit `false` there is just clarity.
 * A `FetchError` whose `cause` is an `AbortError` is a deliberate caller abort —
 * retrying it would be wrong (the caller asked us to stop).
 */
export function shouldRetry(error: unknown): boolean {
  if (
    error instanceof FetchError &&
    error.cause instanceof DOMException &&
    error.cause.name === "AbortError"
  ) {
    return false;
  }
  if (error instanceof FetchError || error instanceof TimeoutError) return true;
  if (error instanceof HttpError) {
    return error.status === 429 || error.status === 408 || error.status >= 500;
  }
  if (error instanceof RobotsError) return false;
  return false;
}

/**
 * The SDK's single retry policy: exponential backoff with jitter via `p-retry`,
 * retrying transport failures and transient statuses only (see
 * {@link shouldRetry}). ALL network I/O goes through this helper — page
 * fetches inside `createScraper`, the Brave search provider, everything — so
 * backoff tuning lives in exactly one place and no call site grows ad-hoc
 * `setTimeout` retries.
 *
 * Internal (not part of the public API).
 *
 * @param attempt One wire attempt. Called again per retry.
 * @param options.retries Retries after the first attempt (total attempts =
 *   `retries + 1`); defaults to {@link DEFAULT_RETRIES}.
 * @param options.signal The caller's abort signal. `p-retry` rejects with the
 *   raw `signal.reason` when it aborts mid-backoff (between attempts), so the
 *   abort→{@link FetchError} wrap lives HERE — every error leaving the
 *   SDK must be a `ScrapeError`. The reason is whatever the caller passed to
 *   `abort()` — possibly NOT an Error at all (`abort("stop")`) — so the wrap
 *   is unconditional once the signal is seen aborted.
 * @param options.url The request URL, so the wrapped {@link FetchError}
 *   carries it like every other fetch-layer error does.
 */
export async function withRetries<T>(
  attempt: () => Promise<T>,
  options: { retries?: number; signal?: AbortSignal; url?: string } = {},
): Promise<T> {
  try {
    return await pRetry(attempt, {
      retries: options.retries ?? DEFAULT_RETRIES,
      factor: 2,
      minTimeout: 500,
      maxTimeout: 8_000,
      randomize: true,
      signal: options.signal,
      shouldRetry: (context) => shouldRetry(context.error),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") {
      throw new FetchError("Request aborted by caller", { url: options.url, cause });
    }
    // A custom abort reason (`controller.abort("stop")`, `abort(err)`) is
    // what p-retry rejected with — possibly not an Error. It must still
    // leave as a FetchError with the reason preserved as `cause`. An
    // already-typed ScrapeError (e.g. the fetch layer's own abort wrap)
    // passes through — re-wrapping would bury the real cause.
    if (options.signal?.aborted && !(cause instanceof ScrapeError)) {
      throw new FetchError("Request aborted by caller", { url: options.url, cause });
    }
    throw cause;
  }
}
