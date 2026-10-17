import type { CheerioAPI } from "cheerio";
import { ConfigError, FetchError, ScrapeError, scrubUrl } from "./errors.js";
import { extract } from "./extract.js";
import { parseHtml } from "./parse.js";
import type { CrawlOptions, CrawlPage, CrawlResult, FetchHtmlResult, Scraper } from "./types.js";

/** Only http(s) URLs are crawlable — `mailto:`, `tel:`, `javascript:` are not pages. */
const HTTP_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

const DEFAULT_MAX_DEPTH = 2;
/** Politeness bound: a crawl never exceeds this many page fetches by default. */
const DEFAULT_MAX_PAGES = 50;

/**
 * Normalize a raw `href` value against `baseUrl`: resolve relative references
 * and strip the fragment. Returns `undefined` for anything that is not an
 * http(s) URL — blank, unresolvable, or a non-page scheme.
 *
 * Query parameters are NOT canonicalized: `?a=1&b=2` and `?b=2&a=1` stay
 * distinct URLs (and are deduplicated separately by the crawl's `seen` set).
 */
export function normalizeLink(href: string, baseUrl: string): string | undefined {
  if (href.trim() === "") return undefined;
  let url: URL;
  try {
    url = new URL(href, baseUrl);
  } catch {
    return undefined;
  }
  if (!HTTP_PROTOCOLS.has(url.protocol)) return undefined;
  url.hash = "";
  return url.toString();
}

/**
 * Collect the distinct same-origin http(s) targets of `a[href]` in `root`,
 * normalized against `pageUrl` (relative resolved, fragment stripped).
 * Off-origin links are dropped — this is the crawl's same-origin boundary and
 * map's links fallback.
 */
export function sameOriginLinks(root: CheerioAPI, pageUrl: string, origin: string): string[] {
  const links = new Set<string>();
  root("a[href]").each((_index, element) => {
    const href = root(element).attr("href");
    if (href === undefined) return;
    const normalized = normalizeLink(href, pageUrl);
    if (normalized === undefined) return;
    try {
      if (new URL(normalized).origin !== origin) return;
    } catch {
      return;
    }
    links.add(normalized);
  });
  return [...links];
}

/**
 * Coerce an arbitrary throw into the SDK taxonomy — the same wrap
 * `scrapeManySafe` applies, so a per-page outcome is always a `ScrapeError`:
 * a raw `AbortError` DOMException (thrown past the retry layer) becomes a
 * {@link FetchError}, anything unrecognised a {@link ConfigError}.
 */
function asScrapeError(error: unknown, url: string): ScrapeError {
  if (error instanceof ScrapeError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new FetchError("Request aborted by caller", { url, cause: error });
  }
  return new ConfigError(`Unexpected error crawling ${scrubUrl(url)}`, { cause: error });
}

/**
 * Whether `url` matches at least one pattern. `lastIndex` is reset before each
 * test so a caller-supplied `g`/`y`-flagged RegExp cannot leak match state
 * between URLs.
 */
function matchesAny(patterns: RegExp[], url: string): boolean {
  return patterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(url);
  });
}

function checkNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigError(`\`${name}\` must be a non-negative integer, got ${value}`);
  }
}

function checkPatterns(name: string, patterns: RegExp[] | undefined): void {
  if (patterns === undefined) return;
  if (!Array.isArray(patterns) || patterns.some((pattern) => !(pattern instanceof RegExp))) {
    throw new ConfigError(`\`${name}\` must be an array of RegExp`);
  }
}

/**
 * The crawl loop behind {@link Scraper.crawl}: breadth-first, same-origin
 * only, bounded by `maxDepth` and `maxPages`.
 *
 * `fetchHtml` is the scraper's own fetch path, so robots.txt gating,
 * per-origin serialization, `requestDelay`, retries, and stealth apply to
 * every page exactly as they would to a standalone `fetchHtml` call. Fetches
 * are issued sequentially — a crawl is deliberately polite, not parallel.
 *
 * Pages are dequeued strictly in BFS order; a page that fails is recorded
 * with {@link CrawlPage.error} (never thrown — `scrapeManySafe` semantics) and
 * the crawl continues. An aborted `options.signal` stops dequeuing and the
 * function returns what it has rather than rejecting.
 */
export async function crawlImpl(
  fetchHtml: Scraper["fetchHtml"],
  seedUrl: string | URL,
  options: CrawlOptions = {},
): Promise<CrawlResult> {
  let seed: URL;
  try {
    seed = new URL(String(seedUrl));
  } catch (cause) {
    throw new ConfigError(`Invalid URL ${scrubUrl(String(seedUrl))}`, { cause });
  }
  if (!HTTP_PROTOCOLS.has(seed.protocol)) {
    throw new ConfigError(`\`crawl\` only supports http(s) URLs, got ${seed.protocol}`, {
      url: seed.toString(),
    });
  }
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  checkNonNegativeInteger("maxDepth", maxDepth);
  checkNonNegativeInteger("maxPages", maxPages);
  checkPatterns("include", options.include);
  checkPatterns("exclude", options.exclude);

  seed.hash = "";
  const origin = seed.origin;
  const seen = new Set<string>([seed.toString()]);
  const queue: Array<{ url: string; depth: number }> = [{ url: seed.toString(), depth: 0 }];
  const pages: CrawlPage[] = [];
  let visited = 0;
  let skipped = 0;

  while (queue.length > 0) {
    if (options.signal?.aborted || pages.length >= maxPages) {
      // Whatever is still queued will never be fetched — count it as skipped.
      skipped += queue.length;
      break;
    }
    const current = queue.shift();
    if (current === undefined) break;
    const { url, depth } = current;

    let result: FetchHtmlResult | undefined;
    let error: ScrapeError | undefined;
    try {
      result = await fetchHtml(url, options);
    } catch (cause) {
      error = asScrapeError(cause, url);
    }

    const links: string[] = [];
    let data: Record<string, unknown> | undefined;
    if (result !== undefined) {
      visited += 1;
      // The fetch may have redirected: dedupe on the post-redirect URL too,
      // or a self-link to it (resolved against result.url below) would
      // enqueue and refetch a page already visited.
      const postRedirect = normalizeLink(result.url, url);
      if (postRedirect !== undefined) seen.add(postRedirect);
      // Links resolve against the post-redirect URL, so the same-origin
      // boundary must move with it — a http→https or apex→www redirect on the
      // seed would otherwise drop every discovered link.
      let pageOrigin = origin;
      try {
        pageOrigin = new URL(result.url).origin;
      } catch {
        // Unparseable response URL — keep filtering on the seed's origin.
      }
      try {
        const root = parseHtml(result.html, options.parseOptions);
        if (depth < maxDepth) links.push(...sameOriginLinks(root, result.url, pageOrigin));
        if (options.fields !== undefined) {
          data = extract(root, options.fields, { baseUrl: result.url });
        }
      } catch (cause) {
        // The page fetched but would not parse/extract — record it as failed;
        // any links already collected above still count (we got HTML, we use it).
        error = error ?? asScrapeError(cause, url);
      }
    }

    pages.push({
      url,
      depth,
      ...(data === undefined ? {} : { data }),
      ...(error === undefined ? {} : { error }),
    });

    for (const link of links) {
      if (seen.has(link)) continue;
      if (
        options.include !== undefined &&
        options.include.length > 0 &&
        !matchesAny(options.include, link)
      ) {
        skipped += 1;
        continue;
      }
      if (options.exclude !== undefined && matchesAny(options.exclude, link)) {
        skipped += 1;
        continue;
      }
      seen.add(link);
      queue.push({ url: link, depth: depth + 1 });
    }
  }

  return { pages, visited, skipped };
}
