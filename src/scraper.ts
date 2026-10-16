import pLimit from "p-limit";
import pRetry from "p-retry";
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
import { parseHtml } from "./parse.js";
import { fetchRobotsTxtResult, type RobotsAgent, robotsAllowed, robotsUrlFor } from "./robots.js";
import type {
  ExtractOptions,
  ExtractResult,
  FetchHtmlOptions,
  FetchHtmlResult,
  FieldSpecRecord,
  ScrapeBatchItem,
  ScrapeOptions,
  Scraper,
  ScraperOptions,
} from "./types.js";

const DEFAULT_CONCURRENCY = 4;
/** Crawl-delay is honoured but capped — a hostile delay must not stall the process. */
const MAX_CRAWL_DELAY_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
 * - a per-origin serial queue, so one host is never hit twice concurrently;
 * - a global `p-limit` concurrency cap wrapping the per-host queues.
 *
 * Defaults set here are merged *under* per-call options — a call-level option
 * always wins, and `userAgent`, `timeout`, `retries`, `robots`, `concurrency`,
 * `fetch` fall back to the instance defaults.
 */
export function createScraper(options: ScraperOptions = {}): Scraper {
  const defaults = {
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    timeout: options.timeout ?? DEFAULT_TIMEOUT,
    retries: options.retries ?? DEFAULT_RETRIES,
    robots: options.robots ?? false,
    concurrency: Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY),
    fetch: options.fetch,
  };
  const limit = pLimit(defaults.concurrency);
  // Both maps grow by one entry per origin seen and are never evicted — a
  // long-lived scraper crawling many hosts leaks slowly. Acceptable for v1;
  // follow-up is a bound (LRU/eviction or an explicit `close()` that clears).
  const robotsCache = new Map<string, Promise<RobotsAgent | null>>();
  const robotsKeys = new Map<string, { userAgent: string; fetch: typeof globalThis.fetch }>();
  const hostQueues = new Map<string, Promise<void>>();

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
      throwOnHttpError: call?.throwOnHttpError ?? true,
      signal: call?.signal,
      fetch: call?.fetch ?? defaults.fetch,
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
   */
  function enqueueOnOrigin<T>(origin: string, task: () => Promise<T>): Promise<T> {
    const previous = hostQueues.get(origin) ?? Promise.resolve();
    const run = previous.then(task, task);
    hostQueues.set(
      origin,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /**
   * One fetch, gated by robots.txt and bounded to the origin's serial queue.
   *
   * Composition order matters: the per-origin serial queue sits OUTSIDE the
   * global `p-limit`, and the limit sits inside it. A task parked behind a busy
   * origin's chain therefore holds NO global slot — the cap only binds while a
   * request is actually in flight. (The reverse order would let queued same-host
   * tasks squat on global slots and starve other origins.)
   */
  async function fetchHtmlImpl(
    url: string | URL,
    call: FetchHtmlOptions | ScrapeOptions | undefined,
  ): Promise<FetchHtmlResult> {
    const merged = mergedOptions(call);
    let target: URL;
    try {
      target = new URL(String(url));
    } catch (cause) {
      throw new ConfigError(`Invalid URL ${scrubUrl(String(url))}`, { cause });
    }
    const origin = target.origin;
    const userAgent = merged.userAgent ?? DEFAULT_USER_AGENT;
    const effectiveFetch = merged.fetch ?? fetchImpl;
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

    return enqueueOnOrigin(origin, async () => {
      // The robots check runs inside the global cap so a burst over many fresh
      // origins cannot fire N unbounded robots.txt requests. It shares the
      // origin's serial queue — deliberate: robots.txt and page fetches are the
      // same request stream to the host, so they serialise identically. It also
      // means a RobotsError leaves the origin queue un-stalled.
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

        try {
          return await pRetry(
            async () => {
              if (crawlDelayMs > 0) await sleep(crawlDelayMs);
              return fetchHtmlOnce(target.toString(), merged, effectiveFetch);
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

  async function scrapeImpl<S extends FieldSpecRecord>(
    url: string | URL,
    fields: S,
    call?: ScrapeOptions,
  ): Promise<ExtractResult<S>> {
    const fetched = await fetchHtmlImpl(url, call);
    const root = parseHtml(fetched.html, call?.parseOptions);
    return extract(root, fields, extractOptionsFor(fetched.url, call));
  }

  async function scrapeAllImpl<S extends FieldSpecRecord>(
    url: string | URL,
    container: string,
    fields: S,
    call?: ScrapeOptions,
  ): Promise<Array<ExtractResult<S>>> {
    const fetched = await fetchHtmlImpl(url, call);
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
            const fetched = await fetchHtmlImpl(url, call);
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
  };
}

/** Process-wide default scraper; module-level functions delegate to it. */
const defaultScraper = createScraper();

export const fetchHtml: Scraper["fetchHtml"] = (url, options) =>
  defaultScraper.fetchHtml(url, options);

export function scrape<S extends FieldSpecRecord>(
  url: string | URL,
  fields: S,
  options?: ScrapeOptions,
): Promise<ExtractResult<S>> {
  return defaultScraper.scrape(url, fields, options);
}

export function scrapeAll<S extends FieldSpecRecord>(
  url: string | URL,
  container: string,
  fields: S,
  options?: ScrapeOptions,
): Promise<Array<ExtractResult<S>>> {
  return defaultScraper.scrapeAll(url, container, fields, options);
}

export function scrapeMany<S extends FieldSpecRecord>(
  urls: readonly (string | URL)[],
  fields: S,
  options?: ScrapeOptions,
): Promise<Array<ExtractResult<S>>> {
  return defaultScraper.scrapeMany(urls, fields, options);
}

export function scrapeManySafe<S extends FieldSpecRecord>(
  urls: readonly (string | URL)[],
  fields: S,
  options?: ScrapeOptions,
): Promise<Array<ScrapeBatchItem<S>>> {
  return defaultScraper.scrapeManySafe(urls, fields, options);
}

/** Alias kept for compatibility with earlier API shape. */
export const scrapePage = scrape;
/** Alias kept for compatibility with earlier API shape. */
export const scrapePageAll = scrapeAll;
/** Alias kept for compatibility with earlier API shape. */
export const scrapePages = scrapeMany;
/** Alias kept for compatibility with earlier API shape. */
export const scrapeUrls = scrapeMany;
/** Alias kept for compatibility with earlier API shape. */
export const scrapeDocuments = scrapeMany;
