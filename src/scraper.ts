import pLimit from "p-limit";
import pRetry from "p-retry";
import { detectChallenge } from "./captcha.js";
import { crawlImpl } from "./crawl.js";
import {
  ConfigError,
  FetchError,
  HttpError,
  RobotsError,
  ScrapeError,
  scrubUrl,
  TimeoutError,
} from "./errors.js";
import { extract, extractAll } from "./extract.js";
import { DEFAULT_RETRIES, DEFAULT_TIMEOUT, DEFAULT_USER_AGENT, fetchHtmlOnce } from "./fetch.js";
import { mapImpl } from "./map.js";
import { parseHtml } from "./parse.js";
import { PROXY_FETCH_CONFLICT, ProxyPool, type ProxyPoolOptions } from "./proxy.js";
import { isLikelyDynamic, type RenderedPage } from "./render.js";
import { fetchRobotsTxtResult, type RobotsAgent, robotsAllowed, robotsUrlFor } from "./robots.js";
import {
  CookieJar,
  headerKey,
  type ResolvedStealth,
  resolveStealth,
  setCookieHeaders,
  stealthRequestHeaders,
} from "./stealth.js";
import type {
  CaptchaSolution,
  CrawlOptions,
  CrawlResult,
  ExtractOptions,
  ExtractResult,
  FetchHtmlOptions,
  FetchHtmlResult,
  FieldSpecRecord,
  MapOptions,
  MapResult,
  RequestDelay,
  ScrapeBatchItem,
  ScrapeOptions,
  Scraper,
  ScraperOptions,
} from "./types.js";

const DEFAULT_CONCURRENCY = 4;
/** Crawl-delay is honoured but capped — a hostile delay must not stall the process. */
const MAX_CRAWL_DELAY_MS = 30_000;

/**
 * Test seam, deliberately NOT declared on the public {@link ScraperOptions}:
 * `__proxyPool` is forwarded verbatim to every {@link ProxyPool} this scraper
 * builds, so tests can inject a `fetchFactory`/`now` (see
 * {@link ProxyPoolOptions}) and drive scraper-level proxy behaviour — ban
 * signals, origin bindings, the sitemap probe — without network. Set it via
 * a cast; it is not public API and may change without notice.
 */
interface InternalScraperOptions extends ScraperOptions {
  __proxyPool?: Pick<ProxyPoolOptions, "fetchFactory" | "now" | "banThreshold" | "cooldownMs">;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The User-Agent actually sent on the wire: an explicit userAgent wins
 * (per-call over instance); under stealth the profile's UA is the fallback so
 * robots matching and any direct probe see the same UA the request sends.
 */
function wireUserAgent(
  explicitUserAgent: string | undefined,
  stealth: ResolvedStealth | null,
): string {
  return (
    explicitUserAgent ??
    (stealth === null
      ? DEFAULT_USER_AGENT
      : (stealthRequestHeaders(stealth)["user-agent"] ?? DEFAULT_USER_AGENT))
  );
}

/**
 * Sample this request's pacing gap: a fixed `number` returns as-is; a
 * `{ min, max }` range draws uniformly in `[min, max]` — re-sampled on every
 * call, so request cadence is not a metronome.
 */
function sampleRequestDelay(delay: RequestDelay | undefined): number {
  if (delay === undefined || typeof delay === "number") return delay ?? 0;
  return delay.min + Math.random() * (delay.max - delay.min);
}

/**
 * Whether `delay` is a valid {@link RequestDelay}: a non-negative finite
 * number, or a `{ min, max }` range with `0 <= min <= max`, both finite.
 * Anything else (negative, NaN/Infinity, malformed range, wrong runtime type)
 * is a {@link ConfigError}.
 */
function isValidRequestDelay(delay: RequestDelay | undefined): boolean {
  if (delay === undefined) return true;
  if (typeof delay === "number") return Number.isFinite(delay) && delay >= 0;
  if (typeof delay !== "object" || delay === null) return false;
  return (
    Number.isFinite(delay.min) &&
    delay.min >= 0 &&
    Number.isFinite(delay.max) &&
    delay.max >= delay.min
  );
}

/**
 * Whether a failure is worth retrying. `p-retry` already short-circuits plain
 * `TypeError`s (non-network bugs), so an explicit `false` there is just clarity.
 * A `FetchError` whose `cause` is an `AbortError` is a deliberate caller abort —
 * retrying it would be wrong (the caller asked us to stop).
 */
function shouldRetry(error: unknown): boolean {
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
 * Create a stateful scraper.
 *
 * Instance state, shared across every call on the returned object:
 * - a per-origin `robots.txt` cache (fetched once, deduplicated as a Promise);
 * - a per-origin serial queue, so one origin is never hit twice concurrently
 *   (bypassed when `serializePerOrigin` is false);
 * - a global `p-limit` concurrency cap wrapping the per-origin queues;
 * - stealth state (per-origin cookie jar + last-visited-URL referer chain),
 *   only consulted on calls where `stealth` resolves on.
 *
 * Defaults set here are merged *under* per-call options — a call-level option
 * always wins, and `userAgent`, `timeout`, `retries`, `robots`,
 * `serializePerOrigin`, `requestDelay`, `concurrency`, `fetch` fall back to
 * the instance defaults.
 *
 * @example
 * const scraper = createScraper({ concurrency: 2, requestDelay: 250 });
 * const page = await scraper.scrape("https://example.com", { title: "h1" });
 */
export function createScraper(options: ScraperOptions = {}): Scraper {
  const defaults = {
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    timeout: options.timeout ?? DEFAULT_TIMEOUT,
    retries: options.retries ?? DEFAULT_RETRIES,
    robots: options.robots ?? true,
    serializePerOrigin: options.serializePerOrigin ?? true,
    requestDelay: options.requestDelay ?? 0,
    concurrency: Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY),
    stealth: options.stealth,
    solver: options.solver,
    fetch: options.fetch,
    proxyRotation: options.proxyRotation ?? "per-origin",
    render: options.render,
    renderMode: options.renderMode,
  };
  const limit = pLimit(defaults.concurrency);
  // Instance-level proxies build ONE stateful pool up front — origin bindings
  // and proxy health are shared across every call on this scraper (that's
  // what makes on-ban useful). Validation is eager: a bad proxy URL fails at
  // createScraper, not mid-crawl. A custom `fetch` cannot be routed through
  // a proxy dispatcher, so combining the two is a config error — the same
  // check runs per call in fetchHtmlImpl for per-call combinations.
  const instanceProxyList = options.proxy !== undefined ? [options.proxy] : options.proxies;
  if (instanceProxyList !== undefined && options.fetch !== undefined) {
    throw new ConfigError(PROXY_FETCH_CONFLICT);
  }
  // Internal test seam — see InternalScraperOptions. Forwarded to every pool
  // the scraper builds (instance and per-call) so rotation, health and the
  // sitemap probe all run on the injected factory.
  const proxyPoolHooks = (options as InternalScraperOptions).__proxyPool;
  const instancePool =
    instanceProxyList === undefined
      ? null
      : new ProxyPool({
          proxies: instanceProxyList,
          rotation: defaults.proxyRotation,
          ...proxyPoolHooks,
        });
  // Both maps grow by one entry per origin seen and are never evicted — a
  // long-lived scraper crawling many origins leaks slowly. Acceptable for v1;
  // follow-up is a bound (LRU/eviction or an explicit `close()` that clears).
  const robotsCache = new Map<string, Promise<RobotsAgent | null>>();
  const robotsKeys = new Map<string, { userAgent: string; fetch: typeof globalThis.fetch }>();
  const originQueues = new Map<string, Promise<void>>();
  // Stealth state, per scraper instance (see createScraper docs): the jar is
  // only read/written on calls where stealth's `cookies` is on, and the referer
  // chain likewise only when `refererChain` is on — the honest default path
  // never touches either.
  const cookieJar = new CookieJar();
  const lastUrlByOrigin = new Map<string, string>();

  const fetchImpl: typeof globalThis.fetch = defaults.fetch ?? globalThis.fetch;

  function mergedOptions(call: FetchHtmlOptions | ScrapeOptions | undefined): FetchHtmlOptions & {
    baseUrl?: string | URL;
    parseOptions?: ScrapeOptions["parseOptions"];
    concurrency?: number;
  } {
    return {
      userAgent: call?.userAgent ?? defaults.userAgent,
      headers: call?.headers,
      timeout: call?.timeout ?? defaults.timeout,
      retries: call?.retries ?? defaults.retries,
      robots: call?.robots ?? defaults.robots,
      serializePerOrigin: call?.serializePerOrigin ?? defaults.serializePerOrigin,
      requestDelay: call?.requestDelay ?? defaults.requestDelay,
      stealth: call?.stealth ?? defaults.stealth,
      solver: call?.solver ?? defaults.solver,
      throwOnHttpError: call?.throwOnHttpError ?? true,
      signal: call?.signal,
      fetch: call?.fetch ?? defaults.fetch,
      // `proxy`/`proxies` are deliberately NOT merged here: they are consumed
      // at this layer (proxy-pool resolution) and must never ride `...merged`
      // into fetchHtmlOnce, which builds its own stateless pool when it sees
      // them (it supports them for direct callers).
      proxyRotation: call?.proxyRotation ?? defaults.proxyRotation,
      render: call?.render ?? defaults.render,
      renderMode: call?.renderMode ?? defaults.renderMode,
      baseUrl: (call as ScrapeOptions | undefined)?.baseUrl,
      parseOptions: (call as ScrapeOptions | undefined)?.parseOptions,
      concurrency: (call as ScrapeOptions | undefined)?.concurrency,
    };
  }

  /**
   * Robots agent for `origin`, fetched once and cached.
   *
   * The cache entry is only valid for the `(userAgent, fetch)` pair that fetched
   * it: a later call on the same origin with a different injected `fetch` or UA
   * must not reuse robots.txt obtained through the first caller's parameters.
   * A mismatch replaces the entry rather than erroring.
   */
  function robotsAgentFor(
    origin: string,
    userAgent: string,
    fetchImpl: typeof globalThis.fetch,
    timeout: number,
    signal: AbortSignal | undefined,
  ): Promise<RobotsAgent | null> {
    const key = robotsKeys.get(origin);
    let cached = robotsCache.get(origin);
    if (cached === undefined || key?.userAgent !== userAgent || key?.fetch !== fetchImpl) {
      cached = fetchRobotsTxtResult(robotsUrlFor(`${origin}/`), {
        userAgent,
        timeout,
        fetch: fetchImpl,
        signal,
      }).then((result) => {
        if (result.kind === "failed") {
          // A failed robots fetch must not poison the cache: allow-all is a
          // fallback, not an answer — evict so the next call refetches. Guard
          // on identity: a concurrent call for a different (userAgent, fetch)
          // pair may already have replaced the entry, and that one must win.
          if (robotsCache.get(origin) === cached) {
            robotsCache.delete(origin);
            robotsKeys.delete(origin);
          }
          return null;
        }
        return result.kind === "agent" ? result.agent : null;
      });
      robotsCache.set(origin, cached);
      robotsKeys.set(origin, { userAgent, fetch: fetchImpl });
    }
    return cached;
  }

  /**
   * Enqueue `task` on `origin`'s serial queue. Each call replaces the tail of the
   * chain with a promise that resolves when this task settles; the chain itself
   * never rejects, so a failed task does not stall later ones.
   *
   * `delayMs` paces the START of this task off the END of the previous one on the
   * same origin — a minimum gap between consecutive requests, not a period. The
   * first task queued on an origin has nothing to pace against and is not delayed.
   */
  function enqueueOnOrigin<T>(origin: string, task: () => Promise<T>, delayMs = 0): Promise<T> {
    const previous = originQueues.get(origin);
    const paced =
      previous === undefined || delayMs <= 0
        ? task
        : async (): Promise<T> => {
            await sleep(delayMs);
            return task();
          };
    const run = (previous ?? Promise.resolve()).then(paced, paced);
    originQueues.set(
      origin,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /**
   * One fetch, gated by robots.txt and bounded to the origin's serial queue
   * (unless `serializePerOrigin` is false).
   *
   * Composition order matters: the per-origin serial queue sits OUTSIDE the
   * global `p-limit`, and the limit sits inside it. A task parked behind a busy
   * origin's chain therefore holds NO global slot — the cap only binds while a
   * request is actually in flight. (The reverse order would let queued same-origin
   * tasks squat on global slots and starve other origins.)
   *
   * `dynamicTrigger` is the `scrape*`-only extension of the `auto` render
   * trigger: it receives the static result and answers "this content is
   * insufficient" (a fields spec that extracted to all-`undefined`). It runs
   * ONLY when a renderer is configured and `renderMode` is `auto` — with no
   * renderer there is nothing to escalate to, so the extra parse is skipped.
   */
  async function fetchHtmlImpl(
    url: string | URL,
    call: FetchHtmlOptions | ScrapeOptions | undefined,
    dynamicTrigger?: (result: FetchHtmlResult) => boolean,
  ): Promise<FetchHtmlResult> {
    const merged = mergedOptions(call);
    let target: URL;
    try {
      target = new URL(String(url));
    } catch (cause) {
      throw new ConfigError(`Invalid URL ${scrubUrl(String(url))}`, { cause });
    }
    const origin = target.origin;
    const stealth = resolveStealth(merged.stealth);
    const explicitUserAgent = call?.userAgent ?? options.userAgent;
    const userAgent = wireUserAgent(explicitUserAgent, stealth);
    // Proxy resolution happens once per call. A per-call `proxy`/`proxies`
    // builds a FRESH stateless pool for this request — health state cannot
    // survive the call — while instance-level config shares the scraper's
    // pool (bindings + health persist). `proxy` pins one proxy and wins over
    // `proxies` at the same level.
    const callProxyList = call?.proxy !== undefined ? [call.proxy] : call?.proxies;
    const proxyPool =
      callProxyList === undefined
        ? instancePool
        : new ProxyPool({
            proxies: callProxyList,
            rotation: merged.proxyRotation,
            ...proxyPoolHooks,
          });
    if (proxyPool !== null && merged.fetch !== undefined) {
      throw new ConfigError(PROXY_FETCH_CONFLICT, { url: target.toString() });
    }
    const effectiveFetch = proxyPool?.fetchFor(origin) ?? merged.fetch ?? fetchImpl;
    // p-retry short-circuits a pre-aborted signal with a raw AbortError; wrap it
    // here so every error leaving the SDK is a ScrapeError (see errors.ts).
    if (merged.signal?.aborted) {
      throw new FetchError("Request aborted by caller", {
        url: target.toString(),
        cause: merged.signal.reason,
      });
    }
    // Validate here so p-retry's own TypeErrors never leak past the SDK
    // boundary (every thrown error must be a ScrapeError).
    if (merged.retries !== undefined && (!Number.isInteger(merged.retries) || merged.retries < 0)) {
      throw new ConfigError(`\`retries\` must be a non-negative integer, got ${merged.retries}`, {
        url: target.toString(),
      });
    }
    if (merged.timeout !== undefined && merged.timeout < 0) {
      throw new ConfigError(`\`timeout\` must be non-negative, got ${merged.timeout}`, {
        url: target.toString(),
      });
    }
    if (!isValidRequestDelay(merged.requestDelay)) {
      const shown =
        typeof merged.requestDelay === "object"
          ? JSON.stringify(merged.requestDelay)
          : String(merged.requestDelay);
      throw new ConfigError(
        `\`requestDelay\` must be a non-negative finite number or a \`{ min, max }\` range with 0 <= min <= max, got ${shown}`,
        { url: target.toString() },
      );
    }
    if (
      merged.renderMode !== undefined &&
      merged.renderMode !== "auto" &&
      merged.renderMode !== "always"
    ) {
      throw new ConfigError(
        `\`renderMode\` must be "auto" or "always", got ${JSON.stringify(merged.renderMode)}`,
        { url: target.toString() },
      );
    }
    if (merged.renderMode === "always" && merged.render === undefined) {
      throw new ConfigError('`renderMode: "always"` requires a `render` renderer', {
        url: target.toString(),
      });
    }
    if (merged.render !== undefined && typeof merged.render.render !== "function") {
      throw new ConfigError("`render` must implement `render(url, options)`", {
        url: target.toString(),
      });
    }
    const renderer = merged.render;
    const renderMode = merged.renderMode ?? "auto";
    // Crawl carries its extraction spec on the options object itself, so the
    // same "fields extracted to all-undefined" auto trigger applies there
    // without a decider argument.
    const crawlFields = (call as CrawlOptions | undefined)?.fields;

    // Bypassing the origin queue does not bypass the global cap — `limit`
    // sits inside the scheduled task either way. It does bypass `requestDelay`,
    // which only exists inside the queue.
    const schedule: <T>(task: () => Promise<T>) => Promise<T> =
      merged.serializePerOrigin === false
        ? (task) => task()
        : (task) => enqueueOnOrigin(origin, task, sampleRequestDelay(merged.requestDelay));

    /**
     * Merge the stealth-state headers (cookie jar, referer chain) into the
     * caller's header bag for one attempt. Caller headers win: an explicit
     * `referer` suppresses the chain, and an explicit `cookie` is APPENDED to
     * the jar's cookies (`jar; caller`) rather than replaced.
     *
     * `extraCookies` are one-shot cookie pairs applied to this attempt only
     * (solver-provided cookies when the jar is off); when the jar is on they
     * are stored into it instead and arrive through the jar.
     */
    const wireHeaders = (
      extraCookies?: Record<string, string>,
    ): Record<string, string> | undefined => {
      if (stealth === null && extraCookies === undefined) return merged.headers;
      const headers: Record<string, string> = { ...merged.headers };
      const cookieParts: string[] = [];
      if (stealth?.cookies === true) {
        const jarHeader = cookieJar.cookieHeaderFor(target);
        if (jarHeader !== undefined) cookieParts.push(jarHeader);
      }
      if (extraCookies !== undefined) {
        for (const [name, value] of Object.entries(extraCookies)) {
          cookieParts.push(`${name}=${value}`);
        }
      }
      if (cookieParts.length > 0) {
        // Merge into the caller's own Cookie header — never clobber it.
        const cookieKey = headerKey(headers, "cookie") ?? "cookie";
        headers[cookieKey] =
          headers[cookieKey] === undefined
            ? cookieParts.join("; ")
            : `${cookieParts.join("; ")}; ${headers[cookieKey]}`;
      }
      // A caller-set `referer` skips the whole block intentionally: their
      // header wins WHOLESALE, including the sec-fetch-site we would have
      // paired with it (their Referer + the profile's `sec-fetch-site: none`
      // may tell a mismatched story — that inconsistency is then the caller's
      // responsibility, per the StealthOptions docs).
      if (stealth?.refererChain === true && headerKey(headers, "referer") === undefined) {
        const last = lastUrlByOrigin.get(target.origin);
        if (last !== undefined) {
          headers.referer = last;
          // Same-origin navigation, not a typed-URL visit — the fetch metadata
          // must tell the same story the Referer does. Safari sends NO Fetch
          // Metadata, so its profile stays silent here too.
          if (stealth.browser !== "safari" && headerKey(headers, "sec-fetch-site") === undefined) {
            headers["sec-fetch-site"] = "same-origin";
          }
        }
      }
      return headers;
    };

    /**
     * Record a completed response into the stealth state: jar the `Set-Cookie`
     * headers and remember the URL as the last same-origin page — keyed by the
     * RESPONSE's origin so a cross-origin redirect chains correctly. No-op when
     * stealth is off.
     *
     * Known asymmetry: only COMPLETED responses are recorded. When
     * `fetchHtmlOnce` throws {@link HttpError} (the no-solver path), any
     * `Set-Cookie` on that error page is dropped and the referer chain skips
     * it — a real browser would store them. Deliberate: {@link HttpError}
     * carries no headers, and smuggling them through the error path would add
     * plumbing for marginal fidelity.
     */
    const recordResponse = (result: FetchHtmlResult): void => {
      if (stealth === null) return;
      let responseOrigin = origin;
      try {
        responseOrigin = new URL(result.url).origin;
      } catch {
        // Unparseable response URL — fall back to the request's origin.
      }
      if (stealth.cookies) {
        cookieJar.storeResponseCookies(responseOrigin, setCookieHeaders(result.headers));
      }
      if (stealth.refererChain) {
        lastUrlByOrigin.set(responseOrigin, result.url);
      }
    };

    const solverConfigured = merged.solver !== undefined;

    /**
     * `throwOnHttpError` is suppressed whenever an error-status body must be
     * inspected above the fetch layer: a solver needs the challenge data, and
     * a proxy pool needs the challenge page itself as a ban signal — letting
     * HttpError throw inside fetchHtmlOnce would record a 503 challenge as
     * proxy SUCCESS (503 is deliberately not a ban status) and skip
     * `reportBan` entirely. `finalize` then re-throws the HttpError the
     * caller would have seen.
     */
    const inspectErrorBodies = solverConfigured || proxyPool !== null;

    /**
     * Re-apply `throwOnHttpError` semantics once the body has been inspected
     * (solver path, or pool challenge attribution): a still-failing response
     * surfaces as the same {@link HttpError} it would have thrown eagerly.
     */
    const finalize = (result: FetchHtmlResult): FetchHtmlResult => {
      if (
        inspectErrorBodies &&
        merged.throwOnHttpError !== false &&
        (result.status < 200 || result.status >= 300)
      ) {
        throw new HttpError(`HTTP ${result.status} ${result.statusText}`.trim(), {
          url: target.toString(),
          status: result.status,
          statusText: result.statusText,
        });
      }
      return result;
    };

    let solverAttempted = false;

    /**
     * One wire attempt: fetch, record stealth state, and — when a challenge is
     * detected and a solver is configured — solve once and retry the SAME
     * request once with the returned credentials (`solverUsed` is the
     * never-infinite-retry guard: one solver attempt per call, and the guard
     * also spans p-retry attempts).
     */
    const attemptOnce = async (): Promise<FetchHtmlResult> => {
      let result: FetchHtmlResult;
      try {
        result = await fetchHtmlOnce(
          target.toString(),
          {
            ...merged,
            userAgent: explicitUserAgent,
            headers: wireHeaders(),
            // Suppress HttpError while a solver or the proxy pool may need
            // the error-status body (challenge detection → reportBan).
            throwOnHttpError: inspectErrorBodies ? false : merged.throwOnHttpError,
          },
          effectiveFetch,
        );
      } catch (error) {
        // A timeout through a proxy counts against the proxy that served it —
        // the pool's wrapper cannot tell a timeout abort from a caller abort,
        // but this layer can: TimeoutError means OUR clock fired. A
        // caller-abort FetchError is never a proxy fault.
        if (proxyPool !== null && error instanceof TimeoutError) {
          proxyPool.reportBan(origin);
        }
        throw error;
      }
      recordResponse(result);

      // Challenge detection runs whenever someone can act on it: a solver
      // needs the challenge data, a proxy pool needs the ban signal (a served
      // challenge page marks the proxy as burned for this origin).
      const challenge = inspectErrorBodies
        ? detectChallenge({
            url: result.url,
            status: result.status,
            headers: result.headers,
            html: result.html,
          })
        : null;
      if (
        challenge !== null &&
        proxyPool !== null &&
        (challenge.type === "cloudflare-interstitial" || result.status >= 400)
      ) {
        // Interstitials are always blocks; widget markers only count on error
        // statuses — a captcha widget embedded in a 200 form page is content,
        // not a ban. (403/503-status challenges already recorded by the
        // status path are deduplicated inside reportBan.)
        proxyPool.reportBan(origin);
      }

      if (!solverConfigured || solverAttempted || challenge === null) return finalize(result);
      const solver = merged.solver;
      if (solver === undefined) return finalize(result);
      solverAttempted = true;

      let solution: CaptchaSolution;
      try {
        solution = await solver.solve(challenge, { signal: merged.signal });
      } catch (cause) {
        // A solver is a user callback: an abort surfaces as FetchError (same
        // contract as the fetch itself); anything else is wrapped so every
        // SDK-thrown error stays a ScrapeError.
        if (cause instanceof DOMException && cause.name === "AbortError") {
          throw new FetchError("Request aborted by caller", {
            url: target.toString(),
            cause,
          });
        }
        throw new ConfigError("Captcha solver failed", { url: target.toString(), cause });
      }

      // Solution cookies are ALWAYS recorded in the jar — it is the
      // persistence channel, so a clearance solved once surfaces on any later
      // request whose options enable stealth cookies. On THIS retry they
      // arrive via the jar when enabled, else via a one-shot Cookie header.
      const solutionCookies = solution.cookies;
      if (solutionCookies !== undefined) {
        for (const [name, value] of Object.entries(solutionCookies)) {
          cookieJar.set(target.origin, name, value);
        }
      }
      // Copy: wireHeaders can return the caller's `headers` object by
      // reference — writing the solution UA into it would mutate user input
      // and leak the UA into any later call reusing that object.
      const retryHeaders = {
        ...(wireHeaders(stealth?.cookies === true ? undefined : solutionCookies) ?? {}),
      };
      if (solution.userAgent !== undefined) {
        // A solution is bound to the UA that produced it — it MUST win, over
        // the profile and over the caller's own user-agent header.
        retryHeaders[headerKey(retryHeaders, "user-agent") ?? "user-agent"] = solution.userAgent;
      }
      const retried = await fetchHtmlOnce(
        target.toString(),
        {
          ...merged,
          userAgent: solution.userAgent ?? explicitUserAgent,
          headers: retryHeaders,
          throwOnHttpError: false,
        },
        effectiveFetch,
      );
      recordResponse(retried);
      return finalize(retried);
    };

    return schedule(async () => {
      // The robots check runs inside the global cap so a burst over many fresh
      // origins cannot fire N unbounded robots.txt requests. It shares the
      // origin's serial queue — deliberate: robots.txt and page fetches are the
      // same request stream to the origin, so they serialise identically. It also
      // means a RobotsError leaves the origin queue un-stalled. (With
      // serializePerOrigin disabled there is no shared queue; the check itself
      // still applies, but crawl-delay is honoured per request, not between
      // them — concurrent same-origin requests wait it in parallel.)
      return limit(async () => {
        let crawlDelayMs = 0;
        if (merged.robots === true) {
          const agent = await robotsAgentFor(
            origin,
            userAgent,
            effectiveFetch,
            merged.timeout ?? DEFAULT_TIMEOUT,
            merged.signal,
          );
          if (!robotsAllowed(agent, target.toString(), userAgent)) {
            throw new RobotsError(`robots.txt disallows ${scrubUrl(target.toString())}`, {
              url: target.toString(),
            });
          }
          const delay = agent?.getCrawlDelay(userAgent);
          if (delay !== undefined && delay > 0) {
            crawlDelayMs = Math.min(delay * 1000, MAX_CRAWL_DELAY_MS);
          }
        }

        /**
         * One render-engine navigation — "an expensive fetcher": navigate,
         * wait, return the final HTML. The engine owns its own context
         * (stealth headers, cookie jar and proxy routing do NOT apply inside
         * it), so the result carries an empty header bag; the same
         * `throwOnHttpError` semantics as a static response apply to a
         * renderer-reported error status. The declared crawl-delay still
         * paces the render — politeness does not end at the transport.
         *
         * A renderer is a user callback, like `solver`: a caller abort
         * surfaces as FetchError, a ScrapeError passes through, anything else
         * is wrapped in ConfigError so the taxonomy holds.
         *
         * Deliberately NOT wrapped in `p-retry`: one navigation per render
         * call — `retries` paces the static HTTP path only.
         */
        const renderOnce = async (): Promise<FetchHtmlResult> => {
          if (renderer === undefined) throw new ConfigError("No renderer configured");
          if (crawlDelayMs > 0) await sleep(crawlDelayMs);
          let page: RenderedPage;
          try {
            page = await renderer.render(target.toString(), {
              timeout: merged.timeout,
              signal: merged.signal,
              userAgent,
            });
          } catch (cause) {
            if (cause instanceof DOMException && cause.name === "AbortError") {
              throw new FetchError("Request aborted by caller", {
                url: target.toString(),
                cause,
              });
            }
            if (cause instanceof ScrapeError) throw cause;
            throw new ConfigError("Renderer failed", { url: target.toString(), cause });
          }
          const rendered: FetchHtmlResult = {
            url: scrubUrl(page.url || target.toString()),
            status: page.status ?? 200,
            statusText: "",
            html: page.html,
            contentType: "text/html",
            headers: new Headers(),
            rendered: true,
          };
          recordResponse(rendered);
          if (
            merged.throwOnHttpError !== false &&
            (rendered.status < 200 || rendered.status >= 300)
          ) {
            throw new HttpError(`HTTP ${rendered.status}`.trim(), {
              url: target.toString(),
              status: rendered.status,
            });
          }
          return rendered;
        };

        // `"always"`: the static wire fetch never fires — the renderer IS the
        // fetch, so its failure is the call's failure. robots.txt has still
        // gated the URL above.
        if (renderer !== undefined && renderMode === "always") {
          return await renderOnce();
        }

        /**
         * `auto` escalation: the static result is insufficient when it looks
         * like a JS shell (the isLikelyDynamic heuristic) OR a fields spec —
         * scrape*()'s decider or crawl's own `fields` — extracted to
         * all-`undefined`. The heuristic runs first: it is the cheaper check
         * and the only one fetchHtml-level calls have.
         */
        const wantsRender = (result: FetchHtmlResult): boolean => {
          if (isLikelyDynamic(result.html)) return true;
          if (dynamicTrigger?.(result) === true) return true;
          if (crawlFields !== undefined) {
            const root = parseHtml(result.html, (call as ScrapeOptions | undefined)?.parseOptions);
            const data = extract(root, crawlFields, { baseUrl: result.url });
            return Object.values(data).every((value) => value === undefined);
          }
          return false;
        };

        try {
          const staticResult = await pRetry(
            async () => {
              if (crawlDelayMs > 0) await sleep(crawlDelayMs);
              return attemptOnce();
            },
            {
              retries: merged.retries ?? DEFAULT_RETRIES,
              factor: 2,
              minTimeout: 500,
              maxTimeout: 8_000,
              randomize: true,
              signal: merged.signal,
              shouldRetry: (context) => shouldRetry(context.error),
            },
          );
          if (renderer !== undefined && renderMode === "auto" && wantsRender(staticResult)) {
            try {
              // The escalation fires a SECOND same-origin request that
              // schedule() cannot pace — the static fetch already consumed
              // this task's `requestDelay` slot. Pace the render off it here
              // ("always" needs nothing: schedule() paced the render
              // directly). `requestDelay` only exists while the origin queue
              // does, so `serializePerOrigin: false` skips this too.
              const paceMs =
                merged.serializePerOrigin === false ? 0 : sampleRequestDelay(merged.requestDelay);
              if (paceMs > 0 && merged.signal?.aborted !== true) await sleep(paceMs);
              // A caller abort that landed during the pause is the call's
              // error, not a render failure to fall back from.
              if (merged.signal?.aborted) {
                throw new FetchError("Request aborted by caller", {
                  url: target.toString(),
                  cause: merged.signal.reason,
                });
              }
              return await renderOnce();
            } catch (renderError) {
              // `auto` degrades gracefully: a failed render never makes the
              // page worse than the static answer. A caller abort is not a
              // render failure, though — it is honoured, not swallowed.
              if (merged.signal?.aborted) throw renderError;
              return staticResult;
            }
          }
          return staticResult;
        } catch (cause) {
          // p-retry rejects with `signal.reason` — a raw DOMException — when the
          // caller's signal aborts mid-backoff (between attempts). That bypasses
          // fetchHtmlOnce's AbortError→FetchError wrap, so wrap it here too:
          // the taxonomy promises every SDK-thrown error is a ScrapeError.
          if (cause instanceof DOMException && cause.name === "AbortError") {
            throw new FetchError("Request aborted by caller", {
              url: target.toString(),
              cause,
            });
          }
          throw cause;
        }
      });
    });
  }

  /** Parse and extract from a fetched page. `baseUrl` defaults to the page URL. */
  function extractOptionsFor(url: string, call: ScrapeOptions | undefined): ExtractOptions {
    return { baseUrl: call?.baseUrl ?? url };
  }

  /**
   * Build the `auto`-mode fields decider for `scrape*` calls: a spec that
   * extracted to all-`undefined` on the static page suggests JS-dependent
   * content — the same parse/extract pipeline the caller runs downstream.
   * For `scrapeAll`-shaped calls (`container` set) every container record
   * must be all-`undefined`; an empty match list counts, since an
   * unrendered listing is exactly what that usually means.
   */
  function fieldsAllUndefined(
    fields: FieldSpecRecord,
    container: string | undefined,
    call: ScrapeOptions | undefined,
  ): (result: FetchHtmlResult) => boolean {
    return (result) => {
      const root = parseHtml(result.html, call?.parseOptions);
      const options = extractOptionsFor(result.url, call);
      if (container === undefined) {
        const data = extract(root, fields, options);
        return Object.values(data).every((value) => value === undefined);
      }
      const items = extractAll(root, container, fields, options);
      return items.every((item) => Object.values(item).every((value) => value === undefined));
    };
  }

  async function scrapeImpl<S extends FieldSpecRecord>(
    url: string | URL,
    fields: S,
    call?: ScrapeOptions,
  ): Promise<ExtractResult<S>> {
    const fetched = await fetchHtmlImpl(url, call, fieldsAllUndefined(fields, undefined, call));
    const root = parseHtml(fetched.html, call?.parseOptions);
    return extract(root, fields, extractOptionsFor(fetched.url, call));
  }

  async function scrapeAllImpl<S extends FieldSpecRecord>(
    url: string | URL,
    container: string,
    fields: S,
    call?: ScrapeOptions,
  ): Promise<Array<ExtractResult<S>>> {
    const fetched = await fetchHtmlImpl(url, call, fieldsAllUndefined(fields, container, call));
    const root = parseHtml(fetched.html, call?.parseOptions);
    return extractAll(root, container, fields, extractOptionsFor(fetched.url, call));
  }

  /**
   * `scrapeMany` fails fast: the first rejection rejects the whole batch
   * (in-flight work keeps running to completion but its results are dropped).
   * `scrapeManySafe` is the never-rejecting counterpart for callers that want
   * per-URL outcomes.
   *
   * `concurrency` on the call is a CAP, never a floor: `batchLimit` bounds how
   * many `scrapeImpl` calls are in flight for this batch, and each still passes
   * through the instance-wide `limit`, so a per-call value can only lower the
   * effective parallelism below the scraper's configured cap.
   */
  async function scrapeManyImpl<S extends FieldSpecRecord>(
    urls: readonly (string | URL)[],
    fields: S,
    call?: ScrapeOptions,
  ): Promise<Array<ExtractResult<S>>> {
    const merged = mergedOptions(call);
    const batchLimit = pLimit(Math.max(1, merged.concurrency ?? defaults.concurrency));
    return Promise.all(urls.map((url) => batchLimit(() => scrapeImpl(url, fields, call))));
  }

  async function scrapeManySafeImpl<S extends FieldSpecRecord>(
    urls: readonly (string | URL)[],
    fields: S,
    call?: ScrapeOptions,
  ): Promise<Array<ScrapeBatchItem<S>>> {
    const merged = mergedOptions(call);
    const batchLimit = pLimit(Math.max(1, merged.concurrency ?? defaults.concurrency));
    return Promise.all(
      urls.map((url) =>
        batchLimit(async (): Promise<ScrapeBatchItem<S>> => {
          const urlString = String(url);
          try {
            const fetched = await fetchHtmlImpl(
              url,
              call,
              fieldsAllUndefined(fields, undefined, call),
            );
            const root = parseHtml(fetched.html, call?.parseOptions);
            const data = extract(root, fields, extractOptionsFor(fetched.url, call));
            return { url: scrubUrl(fetched.url), ok: true, data, status: fetched.status };
          } catch (error) {
            // A caller abort surfacing as a raw DOMException (e.g. thrown past
            // the retry layer by p-retry's signal handling) is a FetchError,
            // not a ConfigError — same wrap as fetchHtmlImpl.
            const scrapeError =
              error instanceof ScrapeError
                ? error
                : error instanceof DOMException && error.name === "AbortError"
                  ? new FetchError("Request aborted by caller", {
                      url: urlString,
                      cause: error,
                    })
                  : new ConfigError(`Unexpected error scraping ${scrubUrl(urlString)}`, {
                      cause: error,
                    });
            return {
              url: scrubUrl(urlString),
              ok: false,
              error: scrapeError,
              ...(error instanceof HttpError ? { status: error.status } : {}),
            };
          }
        }),
      ),
    );
  }

  return {
    userAgent: defaults.userAgent,
    fetchHtml: (url, opts) => fetchHtmlImpl(url, opts),
    scrape: (url, fields, opts) => scrapeImpl(url, fields, opts),
    scrapeAll: (url, container, fields, opts) => scrapeAllImpl(url, container, fields, opts),
    scrapeMany: (urls, fields, opts) => scrapeManyImpl(urls, fields, opts),
    scrapeManySafe: (urls, fields, opts) => scrapeManySafeImpl(urls, fields, opts),
    // map fetches robots.txt itself (for Sitemap: directives) OUTSIDE
    // fetchHtmlImpl, so the resolved instance defaults must reach it here —
    // a per-call `undefined` would fall back to the global fetch instead of
    // this scraper's own.
    // async so config failures (bad proxy URL, proxy+fetch conflict) REJECT
    // the promise instead of throwing synchronously out of a Promise-typed
    // handler.
    map: async (url, opts) => {
      const merged = mergedOptions(opts);
      // Same proxy resolution as fetchHtmlImpl so the sitemap/robots probe —
      // which bypasses the fetch pipeline — exits through the same proxy as
      // the page fetches (going direct would leak the real IP and could see
      // a different robots.txt than the pages).
      const callProxyList = opts?.proxy !== undefined ? [opts.proxy] : opts?.proxies;
      const probePool =
        callProxyList === undefined
          ? instancePool
          : new ProxyPool({
              proxies: callProxyList,
              rotation: merged.proxyRotation,
              ...proxyPoolHooks,
            });
      let sitemapProbeFetch = merged.fetch ?? fetchImpl;
      if (probePool !== null) {
        if (merged.fetch !== undefined) {
          throw new ConfigError(PROXY_FETCH_CONFLICT);
        }
        try {
          sitemapProbeFetch = probePool.fetchFor(new URL(String(url)).origin);
        } catch {
          // Unparseable seed URL — mapImpl raises the ConfigError itself.
        }
      }
      return mapImpl(fetchHtmlImpl, url, {
        ...opts,
        robots: merged.robots,
        timeout: merged.timeout,
        signal: merged.signal,
        // Page fetches must see the RAW `fetch` (undefined unless the caller
        // injected one): handing them our resolved fallback would trip the
        // proxy/fetch conflict check inside fetchHtmlImpl. The probe is the
        // only consumer that needs the resolved default, so it gets its own
        // field instead.
        fetch: merged.fetch,
        sitemapProbeFetch,
        // `userAgent` deliberately stays whatever the caller passed (via the
        // spread above): injecting the resolved default would suppress
        // fetchHtmlImpl's stealth-profile UA fallback while the profile's
        // sec-ch-ua/sec-fetch-* headers still go out — a mismatched story.
        // map's own robots.txt probe bypasses fetchHtmlImpl, so it gets the
        // fully resolved (stealth-aware) UA through a separate field.
        sitemapProbeUserAgent: wireUserAgent(
          opts?.userAgent ?? options.userAgent,
          resolveStealth(merged.stealth),
        ),
      });
    },
    crawl: (seedUrl, opts) => crawlImpl(fetchHtmlImpl, seedUrl, opts),
  };
}

/** Process-wide default scraper; module-level functions delegate to it. */
const defaultScraper = createScraper();

/**
 * Fetch one page through the shared default scraper and return the decoded
 * body plus response metadata — no parsing, no extraction.
 *
 * Goes through the same pipeline as {@link Scraper.fetchHtml}: robots.txt is
 * honored by default, same-origin requests are serialized, and failures are
 * retried per the shared policy.
 *
 * @param url The page to fetch.
 * @param options Per-request options; anything unset falls back to the
 *   default scraper's defaults.
 * @returns The decoded page and response metadata.
 */
export const fetchHtml: Scraper["fetchHtml"] = (url, options) =>
  defaultScraper.fetchHtml(url, options);

/**
 * Fetch `url`, parse it, and extract `fields` — the main entry point.
 *
 * `fields` is a {@link FieldSpecRecord}: each key maps to a CSS selector
 * string or a `{ selector, attr, all, transform, resolve }` object, and the
 * resolved result type is inferred from the spec (see {@link FieldValue}).
 * URL-carrying attribute values (`href`, `src`, …) are resolved against the
 * page URL, or `options.baseUrl` when given.
 *
 * Rejects with a {@link ScrapeError} subclass: {@link HttpError} on a non-2xx
 * response, {@link RobotsError} when robots.txt disallows the URL,
 * {@link FetchError}/{@link TimeoutError} on transport failures, and
 * {@link ConfigError}/{@link ParseError} on bad input.
 *
 * Delegates to a process-wide default scraper — use {@link createScraper} for
 * isolated state (robots cache, per-origin queues) or different defaults.
 *
 * @example
 * const page = await scrape("https://example.com", {
 *   title: "h1",
 *   links: { selector: "article a", attr: "href", all: true },
 * });
 * // page.title: string | undefined, page.links: string[]
 */
export function scrape<S extends FieldSpecRecord>(
  url: string | URL,
  fields: S,
  options?: ScrapeOptions,
): Promise<ExtractResult<S>> {
  return defaultScraper.scrape(url, fields, options);
}

/**
 * Like {@link scrape} but extracts one record per `container` match — the
 * listing-page shape. Field selectors are scoped strictly inside each
 * container, so values cannot leak in from sibling items.
 *
 * @param url The page to scrape.
 * @param container CSS selector for the repeating element.
 * @param fields The extraction spec, applied within each container.
 * @param options Per-call options; see {@link ScrapeOptions}.
 * @returns One result per container match, in document order.
 */
export function scrapeAll<S extends FieldSpecRecord>(
  url: string | URL,
  container: string,
  fields: S,
  options?: ScrapeOptions,
): Promise<Array<ExtractResult<S>>> {
  return defaultScraper.scrapeAll(url, container, fields, options);
}

/**
 * Scrape several URLs with the same spec, through the shared default scraper.
 *
 * Fails fast: the first rejection rejects the whole batch (in-flight work
 * still completes, but its results are dropped). `options.concurrency` is a
 * cap for this batch — it can only lower parallelism below the scraper's
 * global cap, never raise it. For per-URL outcomes instead, use
 * {@link scrapeManySafe}.
 */
export function scrapeMany<S extends FieldSpecRecord>(
  urls: readonly (string | URL)[],
  fields: S,
  options?: ScrapeOptions,
): Promise<Array<ExtractResult<S>>> {
  return defaultScraper.scrapeMany(urls, fields, options);
}

/**
 * Like {@link scrapeMany} but never rejects: each URL resolves to a
 * {@link ScrapeBatchItem} — `{ ok: true, data, status }` or
 * `{ ok: false, error }` — so one dead URL cannot sink the batch.
 */
export function scrapeManySafe<S extends FieldSpecRecord>(
  urls: readonly (string | URL)[],
  fields: S,
  options?: ScrapeOptions,
): Promise<Array<ScrapeBatchItem<S>>> {
  return defaultScraper.scrapeManySafe(urls, fields, options);
}

/**
 * Discover the URLs of a site through the shared default scraper.
 *
 * Strategy: `Sitemap:` directives from robots.txt plus `/sitemap.xml` are
 * parsed as sitemap XML (a `<sitemapindex>` recurses into its children,
 * bounded at 50 sitemap documents; `<urlset>` entries carry `<loc>` and
 * optional `<lastmod>`). When no sitemap yields URLs, the seed page itself is
 * fetched and its same-origin `a[href]` links are returned instead —
 * {@link MapResult.source} records which strategy answered.
 *
 * Every fetch goes through the normal scraper path: robots.txt is honored,
 * same-origin requests serialize, `requestDelay` paces them, and failures
 * retry per the shared policy. Results are normalized (absolute, fragment
 * stripped) and deduplicated; `options.limit` truncates.
 *
 * @param url Any URL on the site to map. The sitemap probe uses only its
 *   origin (robots.txt `Sitemap:` directives plus `/sitemap.xml`); when no
 *   sitemap yields URLs, this exact page is fetched and its links returned.
 * @param options Per-call options ({@link MapOptions}); anything unset falls
 *   back to the default scraper's defaults.
 * @returns The discovered URLs and how they were found.
 * @throws {ConfigError} On an unparseable or non-http(s) `url`, or an invalid
 *   `limit`. The seed-page fetch in the links fallback may also throw any
 *   {@link ScrapeError} a normal fetch would.
 *
 * @example
 * const { urls, source } = await map("https://example.com", { limit: 500 });
 * // source: "sitemap" | "links"; urls[i]: { url, lastModified? }
 */
export function map(url: string | URL, options?: MapOptions): Promise<MapResult> {
  return defaultScraper.map(url, options);
}

/**
 * Recursively crawl same-origin pages breadth-first from `seedUrl`, through
 * the shared default scraper.
 *
 * Only links on the seed's origin are followed (`URL.origin` — http/https on
 * the same host are different origins), deduplicated on the normalized URL.
 * `maxDepth` (default 2) bounds link distance from the seed, `maxPages`
 * (default 50) caps total fetches, and `include`/`exclude` filter discovered
 * URLs by pattern. With `fields` set, each fetched page also gets a spec
 * extraction into {@link CrawlPage.data}.
 *
 * Every page fetch goes through the normal scraper path — robots, per-origin
 * serialization, `requestDelay`, retries, stealth all apply — and fetches are
 * issued sequentially, in BFS order. A failing page is recorded in
 * {@link CrawlResult.pages} with `error` set rather than aborting the crawl;
 * an aborted `options.signal` stops dequeuing and returns what was collected.
 *
 * @param seedUrl The page to start from (always visited, depth 0).
 * @param options Per-call options ({@link CrawlOptions}).
 * @returns Per-page outcomes plus `visited`/`skipped` counters.
 * @throws {ConfigError} On an unparseable or non-http(s) `seedUrl`, or invalid
 *   `maxDepth`/`maxPages`/`include`/`exclude`.
 *
 * @example
 * const result = await crawl("https://example.com/docs", {
 *   maxDepth: 3,
 *   include: [/^https:\/\/example\.com\/docs\//],
 *   fields: { title: "h1" },
 * });
 * // result.pages[i]: { url, depth, data?, error? }
 */
export function crawl(seedUrl: string | URL, options?: CrawlOptions): Promise<CrawlResult> {
  return defaultScraper.crawl(seedUrl, options);
}
