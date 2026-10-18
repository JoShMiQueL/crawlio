/**
 * `flareSolverr` — the second built-in {@link CaptchaSolver}: a self-hosted
 * FlareSolverr instance (https://github.com/FlareSolverr/FlareSolverr)
 * solving `cloudflare-interstitial` challenges in a real browser.
 *
 * The honest constraints, versus {@link capSolver}:
 * - No API key and no per-solve fee — but you run the browser. FlareSolverr
 *   is a heavyweight companion service (a real Chromium), not a thin API.
 * - A proxy is NOT required when FlareSolverr is co-located: it solves from
 *   the host's public IP, which matches a direct-connection retry. When the
 *   scrape goes through `proxy`/`proxies`, `cf_clearance` is still IP-bound
 *   — the challenge's {@link CaptchaChallenge.proxyUrl} (or `options.proxy`
 *   as fallback) is sent so the browser exits the same egress.
 * - The returned `userAgent` must be reused verbatim on the retry — the
 *   scraper does this; see {@link CaptchaSolution}.
 * - Widget types (turnstile/recaptcha/hCaptcha) are out of scope — their
 *   tokens are form-post answers a plain HTTP retry cannot apply.
 * - FlareSolverr IS a real browser, so its TLS fingerprint is Chrome's —
 *   the one clearance ingredient the HTTP retry cannot re-grow.
 */
import { ConfigError, ParseError } from "../errors.js";
import { fetchHtmlOnce } from "../fetch.js";
import { defaultFetch } from "../proxy.js";
import { withRetries } from "../retry.js";
import { parseBaseUrl } from "../search/shared.js";
import type { CaptchaChallenge, CaptchaSolution, CaptchaSolver } from "../types.js";

/** Options accepted by {@link flareSolverr}. */
export interface FlareSolverrOptions {
  /**
   * FlareSolverr base URL — the solver appends `/v1`. Default
   * `http://localhost:8191`; overridable for remote instances and tests.
   */
  endpoint?: string;
  /**
   * Proxy FlareSolverr's browser solves through, `http://`/`socks4://`/
   * `socks5://host:port` — the fallback when the challenge carries no
   * {@link CaptchaChallenge.proxyUrl}. Unlike CapSolver this is OPTIONAL:
   * when omitted the browser exits the host's own IP, which is exactly
   * right for a direct-connection retry (the clearance binds to the IP the
   * retry leaves from). Only wrong when the scrape rides a proxy pool the
   * solver cannot see.
   */
  proxy?: string;
  /**
   * Solve budget in milliseconds, sent as FlareSolverr's `maxTimeout` — how
   * long its browser waits out the challenge. Default `60000`. The HTTP call
   * gets a small buffer above this so FlareSolverr's own timeout error
   * reaches us instead of a generic fetch timeout.
   */
  maxTimeoutMs?: number;
  /**
   * FlareSolverr session id, passed through verbatim. Sessions reuse the
   * same browser across solves — faster repeats and a consistent
   * fingerprint. Create/destroy them via FlareSolverr's own
   * `sessions.create`/`sessions.destroy` commands; this solver only rides
   * an existing one.
   */
  session?: string;
}

const DEFAULT_ENDPOINT = "http://localhost:8191";
const DEFAULT_MAX_TIMEOUT_MS = 60_000;
/** Fetch-timeout headroom over `maxTimeout` — see {@link FlareSolverrOptions.maxTimeoutMs}. */
const FETCH_TIMEOUT_BUFFER_MS = 5_000;

/**
 * Map an `ok` reply's `solution` to {@link CaptchaSolution}: the cookie
 * ARRAY FlareSolverr returns becomes the Record the retry applies
 * (`cf_clearance` lives there); `userAgent` is the binding the retry must
 * reuse. Empty cookies are legal — "Challenge not detected!" still comes
 * back `ok` with whatever cookies the session already held.
 */
function toSolution(payload: Record<string, unknown>): CaptchaSolution {
  const raw = payload.solution;
  if (typeof raw !== "object" || raw === null) {
    throw new Error("FlareSolverr returned status ok without a solution");
  }
  const solution = raw as Record<string, unknown>;
  // Untrusted provider data — entries lacking a string name/value are dropped.
  const cookies: Record<string, string> = {};
  if (Array.isArray(solution.cookies)) {
    for (const entry of solution.cookies) {
      if (typeof entry !== "object" || entry === null) continue;
      const { name, value } = entry as Record<string, unknown>;
      if (typeof name === "string" && typeof value === "string") cookies[name] = value;
    }
  }
  return {
    cookies,
    ...(typeof solution.userAgent === "string" ? { userAgent: solution.userAgent } : {}),
  };
}

/**
 * A {@link CaptchaSolver} over a self-hosted FlareSolverr instance — the
 * free, real-browser built-in for `cloudflare-interstitial` challenges.
 *
 * One `request.get` command posts to `{endpoint}/v1` through the same
 * machinery the search providers use: `fetchHtmlOnce` for timeout/abort
 * handling wrapped in the shared {@link withRetries} policy.
 * `returnOnlyCookies: true` keeps the heavy HTML payload off the wire.
 * `robots.txt` does not apply — this is a solver API, not a crawled site.
 *
 * `solve` rejects for widget-type challenges (their tokens cannot be applied
 * by an HTTP retry), on `status !== "ok"` replies (an {@link Error} carrying
 * the provider's `message`), and on caller abort (`AbortError` — the seam's
 * convention, so the scraper surfaces it as a caller abort, not a failure).
 *
 * @param options Instance configuration; see {@link FlareSolverrOptions}.
 *
 * @example
 * const scraper = createScraper({
 *   solver: flareSolverr(), // http://localhost:8191
 * });
 */
export function flareSolverr(options: FlareSolverrOptions = {}): CaptchaSolver {
  const endpoint = parseBaseUrl(options.endpoint ?? DEFAULT_ENDPOINT)
    .toString()
    .replace(/\/+$/, "");
  const maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  if (!Number.isFinite(maxTimeoutMs) || maxTimeoutMs <= 0) {
    throw new ConfigError(`\`maxTimeoutMs\` must be positive, got ${maxTimeoutMs}`);
  }

  /**
   * POST one `request.get` through the shared fetch machinery and decode the
   * reply — the same pattern as `capSolver`'s `postJson`, minus the polling:
   * FlareSolverr blocks until the challenge resolves or `maxTimeout` fires.
   */
  const postV1 = async (
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> => {
    const url = `${endpoint}/v1`;
    const fetched = await withRetries(
      () =>
        fetchHtmlOnce(
          url,
          {
            method: "POST",
            headers: { accept: "application/json", "content-type": "application/json" },
            body: JSON.stringify(payload),
            // FlareSolverr's own timeout fires first and returns a real
            // error message; the buffer keeps a generic fetch timeout from
            // cutting in ahead of it.
            timeout: maxTimeoutMs + FETCH_TIMEOUT_BUFFER_MS,
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
      throw new ParseError("FlareSolverr API returned invalid JSON", { url, cause });
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new ParseError("FlareSolverr API returned a non-object payload", { url });
    }
    return parsed as Record<string, unknown>;
  };

  return {
    async solve(challenge: CaptchaChallenge, { signal }): Promise<CaptchaSolution> {
      if (challenge.type !== "cloudflare-interstitial") {
        throw new Error(
          `flareSolverr only solves "cloudflare-interstitial" challenges — a "${challenge.type}" token is a form-post answer a plain HTTP retry cannot apply`,
        );
      }
      // Optional, unlike capSolver: a co-located instance solves from the
      // host's own IP — the right egress for a direct-connection retry.
      const proxy = challenge.proxyUrl ?? options.proxy;
      try {
        const payload = await postV1(
          {
            cmd: "request.get",
            url: challenge.url,
            maxTimeout: maxTimeoutMs,
            returnOnlyCookies: true,
            ...(proxy !== undefined ? { proxy: { url: proxy } } : {}),
            ...(options.session !== undefined ? { session: options.session } : {}),
          },
          signal,
        );
        // `status` is the verdict; `message` is prose either way ("Challenge
        // solved!", "Challenge not detected!") — read only for failures.
        if (payload.status !== "ok") {
          const message = typeof payload.message === "string" ? payload.message : "no message";
          throw new Error(`FlareSolverr failed — ${message}`);
        }
        return toSolution(payload);
      } catch (cause) {
        // Abort classification: the caller's signal surfaces as AbortError
        // (the solver seam's convention — the scraper wraps it as FetchError).
        if (signal?.aborted === true) {
          throw new DOMException("Request aborted by caller", "AbortError");
        }
        throw cause;
      }
    },
  };
}
