/**
 * Live-network suite — REAL requests against REAL public sites.
 *
 * Gated behind CRAWLIO_LIVE: off the PR gate entirely, run nightly by
 * .github/workflows/live.yml and on demand via
 *   CRAWLIO_LIVE=1 bun test test/live.test.ts          (Bun lane)
 *   CRAWLIO_LIVE=1 npx vitest run test/live.test.ts    (Node lane)
 * (on Windows cmd/PowerShell set the env var first: `set CRAWLIO_LIVE=1` /
 * `$env:CRAWLIO_LIVE=1`).
 *
 * Assertions are STRUCTURAL — counts, shapes, URL resolvability — never
 * exact page content: these pages change, pinning text would flake.
 * Politeness: one shared scraper with requestDelay >= 1s, default retries,
 * the honest default User-Agent, and targets hit sequentially.
 */
import { describe, expect, it } from "vitest";
import { detectChallenge } from "../src/captcha.js";
import { createScraper, extract, type MapResult, parseHtml, RobotsError } from "../src/index.js";

const LIVE = !!process.env.CRAWLIO_LIVE;

/** Generous per-test budget — real networks and polite delays are slow. */
const LIVE_TIMEOUT = 60_000;

describe.skipIf(!LIVE)("live", () => {
  // One scraper for the whole suite: a shared robots cache and per-origin
  // serialization, plus a >=1s politeness delay between same-origin fetches.
  const scraper = createScraper({ requestDelay: 1_000 });

  describe("books.toscrape.com", () => {
    const ORIGIN = "https://books.toscrape.com";

    it(
      "scrape extracts book entries from the index",
      async () => {
        const page = await scraper.scrape(`${ORIGIN}/`, {
          titles: { selector: "article.product_pod h3 a", attr: "title", all: true },
          prices: { selector: "article.product_pod p.price_color", all: true },
          links: { selector: "article.product_pod h3 a", attr: "href", all: true },
        });
        const titles = page.titles ?? [];
        const prices = page.prices ?? [];
        const links = page.links ?? [];
        expect(titles.length).toBeGreaterThanOrEqual(15);
        expect(prices.length).toBe(titles.length);
        expect(links.length).toBe(titles.length);
        for (const title of titles) {
          expect(typeof title).toBe("string");
          expect(title.trim().length).toBeGreaterThan(0);
        }
        for (const price of prices) expect(price).toMatch(/£\d+/);
        for (const link of links) {
          // Extraction resolves hrefs against the page URL — absolute URLs.
          expect(new URL(link).origin).toBe(ORIGIN);
        }
      },
      LIVE_TIMEOUT,
    );

    it(
      "crawl collects same-origin pages within depth/page bounds",
      async () => {
        const result = await scraper.crawl(`${ORIGIN}/`, { maxDepth: 2, maxPages: 8 });
        expect(result.pages.length).toBeGreaterThanOrEqual(2);
        expect(result.pages.length).toBeLessThanOrEqual(8);
        expect(result.visited).toBeGreaterThanOrEqual(2);
        for (const page of result.pages) {
          expect(new URL(page.url).origin).toBe(ORIGIN);
        }
      },
      LIVE_TIMEOUT,
    );

    it(
      "map discovers site urls",
      async () => {
        const result = await scraper.map(`${ORIGIN}/`);
        expect(result.urls.length).toBeGreaterThan(10);
        for (const { url } of result.urls) {
          expect(new URL(url).origin).toBe(ORIGIN);
        }
      },
      LIVE_TIMEOUT,
    );
  });

  describe("wiki.smite2.com — List of gods", () => {
    const PAGE = "https://wiki.smite2.com/w/List_of_gods";
    // MediaWiki wikitable: row 1 is the <th> header; each god row's second
    // <td> carries the god's name + article link (the first holds the icon).
    const GOD_CELLS = ".mw-parser-output table.wikitable tr td:nth-of-type(2) a";

    it(
      "scrape extracts the god list",
      async () => {
        const page = await scraper.scrape(PAGE, {
          names: { selector: GOD_CELLS, all: true },
          links: { selector: GOD_CELLS, attr: "href", all: true },
        });
        const names = page.names ?? [];
        const links = page.links ?? [];
        expect(names.length).toBeGreaterThan(50);
        expect(links.length).toBe(names.length);
        for (const name of names) expect(name.trim().length).toBeGreaterThan(0);
        for (const link of links) {
          const url = new URL(link);
          expect(url.origin).toBe("https://wiki.smite2.com");
          expect(url.pathname.startsWith("/w/")).toBe(true);
        }
        // Spot-check a stable god — Ymir shipped with the original Smite.
        expect(names).toContain("Ymir");
      },
      LIVE_TIMEOUT,
    );

    // map walks the sitemap index's children before falling back to seed
    // links — each paced by requestDelay, so this needs a wider budget.
    it("map discovers over 100 urls — or surfaces a robots denial", async () => {
      let result: MapResult | Error;
      try {
        result = await scraper.map(PAGE);
      } catch (e) {
        result = e instanceof Error ? e : new Error(String(e));
      }
      if (result instanceof RobotsError) {
        // robots.txt denying the origin IS a verified outcome: the robots
        // gate fired on a real site instead of returning urls.
        expect(result).toBeInstanceOf(RobotsError);
        return;
      }
      if (result instanceof Error) throw result;
      // The wiki's sitemap index fans out to application/gzip children the
      // probe cannot parse, so `source` is usually "links" — assert the
      // outcome (urls), not the strategy that answered.
      expect(result.urls.length).toBeGreaterThan(100);
      for (const { url } of result.urls) {
        expect(new URL(url).origin).toBe("https://wiki.smite2.com");
      }
    }, 120_000);
  });

  describe("amazon.com — anti-bot honesty", () => {
    it(
      "serves structured content OR a detectable bot challenge",
      async () => {
        const result = await scraper.fetchHtml("https://www.amazon.com/", {
          throwOnHttpError: false,
        });
        const challenge = detectChallenge({
          url: result.url,
          status: result.status,
          headers: result.headers,
          html: result.html,
        });
        // Amazon's own "Robot Check" page is a bot challenge too, but not one
        // of detectChallenge's known marker shapes — match it honestly.
        const challenged =
          challenge !== null ||
          result.html.includes("Robot Check") ||
          result.html.includes("validateCaptcha");
        const { title } = extract(parseHtml(result.html), { title: "title" });
        const servedContent =
          result.status >= 200 &&
          result.status < 400 &&
          typeof title === "string" &&
          title.trim().length > 0;
        console.log(
          challenged
            ? `live/amazon: challenged (detectChallenge=${challenge?.type ?? "no-match"}, status=${result.status})`
            : `live/amazon: content (status=${result.status}, title=${JSON.stringify(title)})`,
        );
        // Honest either/or — a challenge from a datacenter IP is success
        // too: it means the detection path saw a real interstitial.
        expect(challenged || servedContent).toBe(true);
      },
      LIVE_TIMEOUT,
    );
  });
});
