import { FetchError, HttpError, RobotsError, ScrapeError, TimeoutError } from "./errors.js";
import { DEFAULT_RETRIES } from "./fetch.js";

// The backoff schedule, fixed for the whole SDK: `500ms * 2^n` per consumed
// retry, jittered by a uniform ×[1,2) factor drawn BEFORE the 8s cap — so the
// sleeps land in 500–1000, 1000–2000, 2000–4000, 4000–8000ms.
const MIN_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 8_000;
const RETRY_FACTOR = 2;

/**
 * Whether a failure is worth retrying. A `TypeError` that isn't one of our
 * typed errors (a non-network bug) falls through to `false` — deterministic
 * bugs are never retried. A `FetchError` whose `cause` is an `AbortError` is
 * a deliberate caller abort — retrying it would be wrong (the caller asked
 * us to stop).
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

/** Frozen context handed to the `shouldRetry` predicate; only `.error` is read. */
interface RetryContext {
  readonly error: Error;
  readonly attemptNumber: number;
  readonly retriesLeft: number;
  readonly retriesConsumed: number;
  readonly retryDelay: number;
}

/**
 * Sleep `ms`, racing `signal`: an abort mid-sleep rejects with the RAW
 * `signal.reason` — possibly not an Error (`abort("stop")`) — which the
 * {@link withRetries} catch wraps into a {@link FetchError}.
 */
function backoff(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `attempt` until it succeeds, exhausts `retries`, or `shouldRetry`
 * vetoes a failure — sleeping {@link MIN_RETRY_DELAY_MS}×2ⁿ (jittered, capped)
 * between attempts. `signal.throwIfAborted()` guards every attempt and both
 * ends of each sleep, so a pre-aborted or mid-flight abort surfaces as the
 * raw `signal.reason`; an abort landing mid-sleep likewise rejects with it
 * (see {@link backoff}). A non-Error throw normalizes to `TypeError`.
 */
async function retryWithBackoff<T>(
  attempt: () => Promise<T>,
  options: {
    retries: number;
    signal?: AbortSignal;
    shouldRetry: (context: RetryContext) => boolean;
  },
): Promise<T> {
  const { retries, signal } = options;
  signal?.throwIfAborted();
  let attemptNumber = 0;
  let retriesConsumed = 0;
  while (retriesConsumed <= retries) {
    attemptNumber++;
    try {
      signal?.throwIfAborted();
      const result = await attempt();
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      const normalized =
        error instanceof Error
          ? error
          : new TypeError(
              `Non-error was thrown: "${String(error)}". You should only throw errors.`,
            );
      const retriesLeft = Math.max(0, retries - retriesConsumed);
      const delay = Math.min(
        Math.round((Math.random() + 1) * MIN_RETRY_DELAY_MS * RETRY_FACTOR ** retriesConsumed),
        MAX_RETRY_DELAY_MS,
      );
      const context: RetryContext = Object.freeze({
        error: normalized,
        attemptNumber,
        retriesLeft,
        retriesConsumed,
        retryDelay: retriesLeft > 0 ? delay : 0,
      });
      if (retriesLeft <= 0 || !options.shouldRetry(context)) throw normalized;
      signal?.throwIfAborted();
      await backoff(delay, signal);
      signal?.throwIfAborted();
      retriesConsumed++;
    }
  }
  // Unreachable: the last permitted attempt returns or throws above.
  throw new Error("Retry attempts exhausted without throwing an error.");
}

/**
 * The SDK's single retry policy: exponential backoff with jitter (see
 * {@link retryWithBackoff}), retrying transport failures and transient
 * statuses only (see {@link shouldRetry}). ALL network I/O goes through this
 * helper — page fetches inside `createScraper`, the Brave search provider,
 * everything — so backoff tuning lives in exactly one place and no call site
 * grows ad-hoc `setTimeout` retries.
 *
 * Internal (not part of the public API).
 *
 * @param attempt One wire attempt. Called again per retry.
 * @param options.retries Retries after the first attempt (total attempts =
 *   `retries + 1`); defaults to {@link DEFAULT_RETRIES}.
 * @param options.signal The caller's abort signal. The retry loop rejects
 *   with the raw `signal.reason` when it aborts mid-backoff (between
 *   attempts), so the abort→{@link FetchError} wrap lives HERE — every error
 *   leaving the SDK must be a `ScrapeError`. The reason is whatever the
 *   caller passed to `abort()` — possibly NOT an Error at all
 *   (`abort("stop")`) — so the wrap is unconditional once the signal is seen
 *   aborted.
 * @param options.url The request URL, so the wrapped {@link FetchError}
 *   carries it like every other fetch-layer error does.
 */
export async function withRetries<T>(
  attempt: () => Promise<T>,
  options: { retries?: number; signal?: AbortSignal; url?: string } = {},
): Promise<T> {
  try {
    return await retryWithBackoff(attempt, {
      retries: options.retries ?? DEFAULT_RETRIES,
      signal: options.signal,
      shouldRetry: (context) => shouldRetry(context.error),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") {
      throw new FetchError("Request aborted by caller", { url: options.url, cause });
    }
    // A custom abort reason (`controller.abort("stop")`, `abort(err)`) is
    // what the retry loop rejected with — possibly not an Error. It must still
    // leave as a FetchError with the reason preserved as `cause`. An
    // already-typed ScrapeError (e.g. the fetch layer's own abort wrap)
    // passes through — re-wrapping would bury the real cause.
    if (options.signal?.aborted && !(cause instanceof ScrapeError)) {
      throw new FetchError("Request aborted by caller", { url: options.url, cause });
    }
    throw cause;
  }
}
