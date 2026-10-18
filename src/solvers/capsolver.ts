/**
 * `capSolver` — the first built-in {@link CaptchaSolver}: CapSolver's
 * `AntiCloudflareTask` for `cloudflare-interstitial` challenges.
 *
 * The honest constraints, all consequences of how `cf_clearance` works:
 * - A proxy is REQUIRED — the clearance is bound to the exit IP that solved
 *   it, so the provider must solve through the same egress the failed
 *   request used ({@link CaptchaChallenge.proxyUrl}, or `options.proxy` as
 *   fallback). Solving without one buys a cookie your IP cannot spend.
 * - The returned `userAgent` must be reused verbatim on the retry — the
 *   scraper does this; see {@link CaptchaSolution}.
 * - Widget types (turnstile/recaptcha/hCaptcha) are out of scope — their
 *   tokens are form-post answers a plain HTTP retry cannot apply.
 * - It is a paid third-party service, and the clearance does not change your
 *   TLS fingerprint — a transport that does not look like a browser can be
 *   re-challenged even with a valid cookie.
 */
import { ConfigError, ParseError, TimeoutError } from "../errors.js";
import { DEFAULT_USER_AGENT, fetchHtmlOnce } from "../fetch.js";
import { defaultFetch } from "../proxy.js";
import { withRetries } from "../retry.js";
import { parseBaseUrl, resolveApiKey } from "../search/shared.js";
import { fuseSignal } from "../signal.js";
import { stealthRequestHeaders } from "../stealth.js";
import type { CaptchaChallenge, CaptchaSolution, CaptchaSolver } from "../types.js";

/** Options accepted by {@link capSolver}. */
export interface CapSolverOptions {
  /**
   * API key. Defaults to the `CAPSOLVER_API_KEY` environment variable; an
   * explicit value wins. It travels in the JSON body's `clientKey` field —
   * CapSolver's own contract, no header form exists.
   */
  apiKey?: string;
  /**
   * Proxy the provider solves through, `http://[user:pass@]host:port` — the
   * fallback when the challenge carries no {@link CaptchaChallenge.proxyUrl}.
   * `cf_clearance` is IP-bound, so this MUST be the same egress the scraping
   * request uses.
   */
  proxy?: string;
  /** API endpoint. Default `https://api.capsolver.com` — overridable for tests. */
  baseUrl?: string;
  /** Delay between `getTaskResult` polls, in milliseconds. Default `2000`. */
  pollIntervalMs?: number;
  /**
   * Total solve budget in milliseconds — `createTask` plus polling. Default
   * `120000`; solving is slow (tens of seconds is normal).
   */
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://api.capsolver.com";
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The UA sent on the task when the challenge carries none: the SDK's own
 * stealth default (the desktop Chrome profile), matching CapSolver's "keep
 * the same UA you use" guidance for callers that scrape under `stealth`.
 */
const DEFAULT_SOLVER_USER_AGENT =
  stealthRequestHeaders({
    browser: "chrome",
    locale: "en-US",
    cookies: false,
    refererChain: false,
  })["user-agent"] ?? DEFAULT_USER_AGENT;

/**
 * Sleep `ms`, rejecting early when `signal` aborts — the poll loop's pacing,
 * not a retry (the provider decides when the task is done; we just wait).
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Map a `ready` task's `solution` to {@link CaptchaSolution}: cookies are
 * what the retry applies (`cf_clearance` lives there); `userAgent` is the
 * binding the retry must reuse; `token` is carried, not applied (per the
 * CaptchaSolution contract).
 */
function toSolution(raw: unknown): CaptchaSolution {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("CapSolver returned a ready task without a solution");
  }
  const solution = raw as Record<string, unknown>;
  // Untrusted provider data — only string values make the wire.
  const cookies: Record<string, string> = {};
  if (typeof solution.cookies === "object" && solution.cookies !== null) {
    for (const [name, value] of Object.entries(solution.cookies)) {
      if (typeof value === "string") cookies[name] = value;
    }
  }
  return {
    cookies,
    ...(typeof solution.userAgent === "string" ? { userAgent: solution.userAgent } : {}),
    ...(typeof solution.token === "string" ? { token: solution.token } : {}),
  };
}

/**
 * A {@link CaptchaSolver} over the CapSolver API — the reference built-in.
 *
 * The API key comes from `options.apiKey` or `CAPSOLVER_API_KEY` (explicit
 * wins); a missing key is a {@link ConfigError} at construction. Requests go
 * through the same machinery the search providers use: `fetchHtmlOnce` for
 * timeout/abort handling wrapped in the shared {@link withRetries} policy.
 * `robots.txt` does not apply — this is a provider API, not a crawled site.
 *
 * `solve` rejects for widget-type challenges (their tokens cannot be applied
 * by an HTTP retry), when no proxy is known (the clearance would be bound to
 * the wrong IP), on provider `errorId`/`failed` responses (an {@link Error}
 * naming `errorCode` + `errorDescription`), on budget exhaustion
 * ({@link TimeoutError}), and on caller abort (`AbortError` — the seam's
 * convention, so the scraper surfaces it as a caller abort, not a failure).
 *
 * @param options Provider configuration; see {@link CapSolverOptions}.
 *
 * @example
 * const scraper = createScraper({
 *   solver: capSolver(), // CAPSOLVER_API_KEY env
 *   proxies: [process.env.PROXY_URL as string],
 * });
 */
export function capSolver(options: CapSolverOptions = {}): CaptchaSolver {
  const apiKey = resolveApiKey(options.apiKey, "CAPSOLVER_API_KEY", "capSolver");
  const baseUrl = parseBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL)
    .toString()
    .replace(/\/+$/, "");
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new ConfigError(`\`pollIntervalMs\` must be positive, got ${pollIntervalMs}`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigError(`\`timeoutMs\` must be positive, got ${timeoutMs}`);
  }

  /**
   * POST a JSON command through the shared fetch machinery and decode the
   * reply — same pattern as the POST-style search providers, except the key
   * rides the body's `clientKey` (CapSolver has no header form).
   */
  const postJson = async (
    path: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    const url = `${baseUrl}${path}`;
    const fetched = await withRetries(
      () =>
        fetchHtmlOnce(
          url,
          {
            method: "POST",
            headers: { accept: "application/json", "content-type": "application/json" },
            body: JSON.stringify({ clientKey: apiKey, ...payload }),
            signal,
          },
          defaultFetch,
        ),
      { signal, url },
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(fetched.html);
    } catch (cause) {
      throw new ParseError("CapSolver API returned invalid JSON", { url, cause });
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new ParseError("CapSolver API returned a non-object payload", { url });
    }
    return parsed as Record<string, unknown>;
  };

  /** `errorId != 0` means the API rejected the call — name its code + description. */
  const apiError = (payload: Record<string, unknown>): Error | null => {
    if (typeof payload.errorId !== "number" || payload.errorId === 0) return null;
    const code =
      typeof payload.errorCode === "string" ? payload.errorCode : `errorId ${payload.errorId}`;
    const description =
      typeof payload.errorDescription === "string" ? payload.errorDescription : "no description";
    return new Error(`CapSolver error — ${code}: ${description}`);
  };

  return {
    async solve(challenge: CaptchaChallenge, { signal }): Promise<CaptchaSolution> {
      if (challenge.type !== "cloudflare-interstitial") {
        throw new Error(
          `capSolver only solves "cloudflare-interstitial" challenges — a "${challenge.type}" token is a form-post answer a plain HTTP retry cannot apply`,
        );
      }
      const proxy = challenge.proxyUrl ?? options.proxy;
      if (proxy === undefined) {
        throw new Error(
          "capSolver needs a proxy — cf_clearance is bound to the exit IP that solved it, so solving without the request's egress proxy is wasted money (scrape through `proxy`/`proxies`, or pass `proxy` to capSolver)",
        );
      }

      // One budget for createTask + every poll: an internal timer fused with
      // the caller's signal, so whichever fires first stops the solve.
      const deadline = Date.now() + timeoutMs;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const fused = fuseSignal(controller.signal, signal);
      try {
        let payload = await postJson(
          "/createTask",
          {
            task: {
              type: "AntiCloudflareTask",
              websiteURL: challenge.url,
              proxy,
              userAgent: challenge.userAgent ?? DEFAULT_SOLVER_USER_AGENT,
              // Optional per the API — free data for the solver.
              html: challenge.html,
            },
          },
          fused.signal,
        );
        const createError = apiError(payload);
        if (createError !== null) throw createError;
        if (payload.status === "processing" && typeof payload.taskId !== "string") {
          throw new Error("CapSolver returned a processing task without a taskId");
        }

        // `ready` can arrive inline on createTask; otherwise poll the task.
        while (payload.status === "processing" && Date.now() < deadline) {
          await sleep(pollIntervalMs, fused.signal);
          payload = await postJson("/getTaskResult", { taskId: payload.taskId }, fused.signal);
          const pollError = apiError(payload);
          if (pollError !== null) throw pollError;
        }

        if (payload.status === "ready") return toSolution(payload.solution);
        if (payload.status === "failed") {
          const code =
            typeof payload.errorCode === "string" ? payload.errorCode : "ERROR_TASK_FAILED";
          const description =
            typeof payload.errorDescription === "string"
              ? payload.errorDescription
              : "the provider reported failure";
          throw new Error(`CapSolver task failed — ${code}: ${description}`);
        }
        if (payload.status === "processing") {
          throw new TimeoutError(`capSolver did not solve the challenge within ${timeoutMs}ms`);
        }
        throw new Error(
          `CapSolver returned an unexpected status ${JSON.stringify(payload.status)}`,
        );
      } catch (cause) {
        // Abort classification: the caller's signal surfaces as AbortError
        // (the solver seam's convention — the scraper wraps it as FetchError);
        // our own timer means the budget ran out.
        if (signal?.aborted === true) {
          throw new DOMException("Request aborted by caller", "AbortError");
        }
        if (controller.signal.aborted) {
          throw new TimeoutError(`capSolver did not solve the challenge within ${timeoutMs}ms`, {
            cause,
          });
        }
        throw cause;
      } finally {
        clearTimeout(timer);
        fused.release();
      }
    },
  };
}
