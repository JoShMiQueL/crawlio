import { type CheerioAPI, load } from "cheerio";
import { normalizeLink, sameOriginLinks } from "./crawl.js";
import { ConfigError, scrubUrl } from "./errors.js";
import { parseHtml } from "./parse.js";
import { fetchRobotsTxt, robotsUrlFor } from "./robots.js";
import type { MapEntry, MapOptions, MapResult, Scraper } from "./types.js";

/**
 * {@link mapImpl}'s options: the public {@link MapOptions} plus the resolved
 * User-Agent the `Sitemap:` robots.txt probe should send. That probe bypasses
 * the fetch pipeline, so it cannot share `fetchHtml`'s UA resolution (caller
 * → instance default → stealth profile → honest default) — the scraper hands
 * it the wire UA explicitly so robots.txt sees the same agent the page
 * fetches will send. Direct callers can omit it; `userAgent` is the fallback.
 *
 * `sitemapProbeFetch` is the same seam for the transport: the robots.txt
 * probe uses it instead of `options.fetch` — the scraper hands it the
 * proxy-bound fetch when proxies are configured, so the probe doesn't leak
 * the real IP. It is stripped off `fetchOptions` before those reach the page
 * fetches (a resolved fetch would otherwise trip the proxy/fetch conflict
 * check inside the pipeline).
 */
export interface MapImplOptions extends MapOptions {
  sitemapProbeUserAgent?: string;
  sitemapProbeFetch?: typeof globalThis.fetch;
}

/**
 * Bound on sitemap documents fetched per `map` call: a sitemap index can fan
 * out to hundreds of children, so nested `<sitemap>` fetches share this budget
 * with the top-level candidates. Politeness, not a limit anyone should hit.
 */
const MAX_SITEMAP_DOCUMENTS = 50;

/**
 * The URL-discovery pass behind {@link Scraper.map}.
 *
 * Strategy, in order:
 * 1. `Sitemap:` directives from robots.txt (unless `robots: false`), plus
 *    `/sitemap.xml` on the origin as a fallback candidate.
 * 2. Each candidate is fetched through `fetchHtml` — the scraper's own path,
 *    so robots gating, per-origin serialization, retries, and stealth apply —
 *    and parsed as XML: a `<sitemapindex>` recurses into its `<sitemap><loc>`
 *    documents (bounded by {@link MAX_SITEMAP_DOCUMENTS}), a `<urlset>`
 *    contributes its `<url><loc>` entries with optional `<lastmod>`.
 * 3. No sitemap yields URLs → fall back to fetching the seed page and
 *    harvesting its same-origin `a[href]` links.
 *
 * A failing or malformed sitemap document is skipped, not fatal — the seed
 * page fetch in the links fallback is the only request allowed to throw. A
 * caller abort stops discovery cleanly and returns whatever was collected —
 * even nothing: an aborted signal skips the links fallback rather than
 * firing one last fetch against a dead signal.
 */
export async function mapImpl(
  fetchHtml: Scraper["fetchHtml"],
  url: string | URL,
  options: MapImplOptions = {},
): Promise<MapResult> {
  // The probe UA is consumed here and never forwarded — fetchHtml resolves
  // the wire UA itself, and an extra field would just ride along ignored.
  const { sitemapProbeUserAgent, sitemapProbeFetch, ...fetchOptions } = options;
  let seed: URL;
  try {
    seed = new URL(String(url));
  } catch (cause) {
    throw new ConfigError(`Invalid URL ${scrubUrl(String(url))}`, { cause });
  }
  if (seed.protocol !== "http:" && seed.protocol !== "https:") {
    throw new ConfigError(`\`map\` only supports http(s) URLs, got ${seed.protocol}`, {
      url: seed.toString(),
    });
  }
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0)) {
    throw new ConfigError(`\`limit\` must be a non-negative integer, got ${options.limit}`, {
      url: seed.toString(),
    });
  }

  // Candidate sitemaps: robots.txt declarations first, then the conventional
  // location — deduplicated, normalized against the seed.
  const candidates: string[] = [];
  const pushCandidate = (loc: string, base: string): void => {
    const normalized = normalizeLink(loc, base);
    if (normalized === undefined || candidates.includes(normalized)) return;
    // Same-origin only: a robots.txt `Sitemap:` directive is authoritative
    // for its own origin — a foreign loc must not send the sitemap probe
    // off the target's origin (SSRF). `normalized` is URL-constructor
    // output — it always reparses.
    if (new URL(normalized).origin !== seed.origin) return;
    candidates.push(normalized);
  };
  if (options.robots !== false) {
    const agent = await fetchRobotsTxt(robotsUrlFor(seed.toString()), {
      userAgent: sitemapProbeUserAgent ?? options.userAgent,
      timeout: options.timeout,
      fetch: sitemapProbeFetch ?? options.fetch,
      signal: options.signal,
    });
    for (const loc of agent?.getSitemaps() ?? []) {
      pushCandidate(loc, seed.toString());
    }
  }
  pushCandidate("/sitemap.xml", seed.toString());

  const entries = new Map<string, MapEntry>();
  const fetchedSitemaps = new Set<string>();

  /**
   * Fetch and parse one sitemap document into `entries`, recursing into
   * `<sitemapindex>` children while the document budget lasts. All failures
   * (fetch, parse) are swallowed — a dead sitemap just means trying the next
   * candidate.
   */
  const collectSitemap = async (sitemapUrl: string): Promise<void> => {
    if (fetchedSitemaps.size >= MAX_SITEMAP_DOCUMENTS) return;
    if (fetchedSitemaps.has(sitemapUrl) || options.signal?.aborted) return;
    fetchedSitemaps.add(sitemapUrl);

    let xml: string;
    try {
      const result = await fetchHtml(sitemapUrl, fetchOptions);
      xml = result.html;
    } catch {
      return;
    }
    let root: CheerioAPI;
    try {
      root = load(xml, { xml: true });
    } catch {
      return;
    }
    // Per the sitemap protocol a document may only list URLs — and an index
    // may only reference child sitemaps — on its own origin; cross-origin
    // locs are invalid and dropped below.
    let sitemapOrigin: string;
    try {
      sitemapOrigin = new URL(sitemapUrl).origin;
    } catch {
      return;
    }

    root("sitemapindex").each((_index, index) => {
      const nested: string[] = [];
      root(index)
        .children("sitemap")
        .each((_i, sitemap) => {
          const loc = root(sitemap).children("loc").first().text().trim();
          if (loc !== "") nested.push(loc);
        });
      // Queue children rather than recursing inline: nested sitemaps are
      // fetched strictly one at a time, after the declared candidates.
      for (const loc of nested) {
        const normalized = normalizeLink(loc, sitemapUrl);
        if (normalized === undefined) continue;
        // `normalized` is URL-constructor output — it always reparses.
        if (new URL(normalized).origin !== sitemapOrigin) continue;
        pending.push(normalized);
      }
    });

    root("urlset").each((_index, urlset) => {
      root(urlset)
        .children("url")
        .each((_i, entry) => {
          const node = root(entry);
          const normalized = normalizeLink(node.children("loc").first().text(), sitemapUrl);
          if (normalized === undefined || entries.has(normalized)) return;
          // `normalized` is URL-constructor output — it always reparses.
          if (new URL(normalized).origin !== sitemapOrigin) return;
          const lastModified = node.children("lastmod").first().text().trim();
          entries.set(
            normalized,
            lastModified === "" ? { url: normalized } : { url: normalized, lastModified },
          );
        });
    });
  };

  // Nested sitemaps discovered while collecting are queued behind ALL the
  // declared candidates — draining inside the loop would let the first
  // index's subtree eat the whole document budget before later candidates
  // (like /sitemap.xml) are even tried.
  const pending: string[] = [];
  for (const candidate of candidates) {
    if (options.signal?.aborted) break;
    await collectSitemap(candidate);
  }
  while (pending.length > 0) {
    if (options.signal?.aborted) break;
    const next = pending.shift();
    if (next !== undefined) await collectSitemap(next);
  }

  if (entries.size === 0 && !options.signal?.aborted) {
    // No sitemap produced URLs — read the seed page instead. This fetch is
    // allowed to throw: with nothing else to go on, it IS the map's failure.
    const result = await fetchHtml(seed.toString(), fetchOptions);
    const root = parseHtml(result.html);
    // Links resolve against the post-redirect URL, so the origin boundary
    // must move with it — a http→https or apex→www redirect on the seed
    // would otherwise drop every discovered link.
    let origin = seed.origin;
    try {
      origin = new URL(result.url).origin;
    } catch {
      // Unparseable response URL — keep filtering on the seed's origin.
    }
    for (const link of sameOriginLinks(root, result.url, origin)) {
      if (!entries.has(link)) entries.set(link, { url: link });
    }
    const urls = [...entries.values()];
    return {
      urls: options.limit === undefined ? urls : urls.slice(0, options.limit),
      source: "links",
    };
  }

  const urls = [...entries.values()];
  return {
    urls: options.limit === undefined ? urls : urls.slice(0, options.limit),
    source: "sitemap",
  };
}
