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
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectChallenge } from "../src/captcha.js";
import { createScraper, extract, type MapResult, parseHtml, RobotsError } from "../src/index.js";

const LIVE = !!process.env.CRAWLIO_LIVE;

/** Generous per-test budget — real networks and polite delays are slow. */
const LIVE_TIMEOUT = 60_000;

/** Where extracted data lands — gitignored, uploaded as an artifact by live.yml. */
const LIVE_RESULTS_DIR = "live-results";

/** Persist an extraction for humans: pretty JSON at live-results/<name>.json. */
function writeLiveResult(name: string, data: unknown): void {
  mkdirSync(LIVE_RESULTS_DIR, { recursive: true });
  writeFileSync(join(LIVE_RESULTS_DIR, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
}

/** Append markdown to the GitHub step summary when running inside Actions. */
function appendStepSummary(markdown: string): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath === undefined || summaryPath === "") return;
  appendFileSync(summaryPath, markdown);
}

/** `|` inside a cell would break a markdown table — escape it. */
function mdCell(value: unknown): string {
  return String(value).replaceAll("|", "\\|");
}

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
    // MediaWiki wikitable rows: icon td | name | pantheon | attack type |
    // role | cost | release date. Data cells carry a leading icon
    // `<a><img></a>` ahead of the text link(s) — `a:not(:has(img))` skips
    // those image anchors. The header row is all <th>, so it (and any
    // separator row) drops out on the missing god link.
    const GOD_ROWS = ".mw-parser-output table.wikitable tr";

    interface GodRow {
      name: string;
      url: string;
      pantheon: string;
      attackType: string[];
      role: string;
      cost: string;
      releaseDate: string;
    }

    // Populated by the scrapeAll test and consumed by the scrapeMany one —
    // the batch run reuses the extracted URLs instead of refetching the list.
    let godRows: GodRow[] = [];

    /** Markdown section for the GitHub step summary (renders on the run page). */
    function wikiSummaryMarkdown(
      gods: GodRow[],
      details: ReadonlyArray<{ name?: string; pantheon?: string; roles?: string[] }>,
    ): string {
      const lines = [
        "",
        "## live/wiki — SMITE 2 god extraction",
        "",
        `**${gods.length}** gods scraped from the list; **${details.length}** detail pages fetched in batch.`,
        "",
        "| God | Pantheon | Attack | Role | Cost | Released |",
        "| --- | --- | --- | --- | --- | --- |",
      ];
      for (const god of gods.slice(0, 15)) {
        lines.push(
          `| ${mdCell(god.name)} | ${mdCell(god.pantheon)} | ${mdCell(god.attackType.join(" "))} | ${mdCell(god.role)} | ${mdCell(god.cost)} | ${mdCell(god.releaseDate)} |`,
        );
      }
      lines.push(
        "",
        "### scrapeMany — god detail pages",
        "",
        "| God | Pantheon | Roles |",
        "| --- | --- | --- |",
      );
      for (const detail of details) {
        lines.push(
          `| ${mdCell(detail.name ?? "")} | ${mdCell(detail.pantheon ?? "")} | ${mdCell((detail.roles ?? []).join(", "))} |`,
        );
      }
      lines.push("");
      return lines.join("\n");
    }

    it(
      "scrapeAll extracts full god rows",
      async () => {
        const rows = await scraper.scrapeAll(PAGE, GOD_ROWS, {
          name: { selector: "td:nth-of-type(2) a" },
          url: { selector: "td:nth-of-type(2) a", attr: "href" },
          pantheon: { selector: "td:nth-of-type(3)" },
          attackType: { selector: "td:nth-of-type(4) a:not(:has(img))", all: true },
          role: { selector: "td:nth-of-type(5)" },
          cost: { selector: "td:nth-of-type(6)" },
          releaseDate: { selector: "td:nth-of-type(7)" },
        });
        godRows = rows.filter(
          (row): row is GodRow =>
            typeof row.name === "string" &&
            row.name.trim() !== "" &&
            typeof row.url === "string" &&
            typeof row.pantheon === "string" &&
            typeof row.role === "string" &&
            typeof row.cost === "string" &&
            typeof row.releaseDate === "string",
        );

        writeLiveResult("wiki-gods", godRows);
        console.log(`live/wiki: ${godRows.length} gods extracted — first 10:`);
        for (const god of godRows.slice(0, 10)) {
          console.log(
            `  ${god.name} | ${god.pantheon} | ${god.attackType.join(" ")} | ${god.role} | ${god.cost} | ${god.releaseDate}`,
          );
        }

        expect(godRows.length).toBeGreaterThan(50);
        for (const god of godRows) {
          const url = new URL(god.url);
          expect(url.origin).toBe("https://wiki.smite2.com");
          expect(url.pathname.startsWith("/w/")).toBe(true);
          expect(god.pantheon.trim().length).toBeGreaterThan(0);
          expect(god.role.trim().length).toBeGreaterThan(0);
          // Attack type is 1-2 tokens per god ("Melee", "Ranged Magical", …).
          expect(god.attackType.length).toBeGreaterThanOrEqual(1);
          for (const type of god.attackType) {
            expect(type.trim().length).toBeGreaterThan(0);
          }
          expect(god.releaseDate).toMatch(/20\d\d-\d\d-\d\d/);
          expect(god.cost).toMatch(/\d/);
        }
        // Spot-check a stable god — Ymir shipped with the original Smite.
        expect(godRows.map((god) => god.name)).toContain("Ymir");
      },
      LIVE_TIMEOUT,
    );

    // Depends on the god list above: the first 5 extracted urls are the
    // batch targets — one shared scraper, its concurrency + requestDelay
    // pacing the detail-page fetches.
    it(
      "scrapeMany extracts god detail pages in batch",
      async () => {
        const targets = godRows.slice(0, 5).map((god) => god.url);
        expect(targets.length).toBe(5);
        const started = Date.now();
        const details = await scraper.scrapeMany(targets, {
          name: { selector: "table.infobox th.title" },
          // Infobox rows are `<th>label:</th><td>value</td>` — anchor on the
          // label text so row order doesn't matter, and skip icon anchors
          // (they contain an <img>; the text links don't).
          pantheon: {
            selector: 'table.infobox tr:has(> th:contains("Pantheon")) td a:not(:has(img))',
          },
          roles: {
            selector: 'table.infobox tr:has(> th:contains("Role")) td a:not(:has(img))',
            all: true,
          },
        });
        const elapsed = ((Date.now() - started) / 1_000).toFixed(1);
        console.log(
          `live/wiki: scrapeMany fetched ${targets.length} god detail pages in ${elapsed}s:`,
        );
        for (const detail of details) {
          console.log(
            `  ${detail.name ?? ""} | ${detail.pantheon ?? ""} | ${detail.roles.join(", ")}`,
          );
        }

        for (const detail of details) {
          expect(detail.name?.trim().length).toBeGreaterThan(0);
          expect(detail.pantheon?.trim().length).toBeGreaterThan(0);
          expect(detail.roles.length).toBeGreaterThan(0);
        }

        writeLiveResult("wiki-god-details", details);
        appendStepSummary(wikiSummaryMarkdown(godRows, details));
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
        // Amazon's "Robot Check" wall IS a detectChallenge shape now
        // ("amazon-robot-check", matched on "Robot Check"/"validateCaptcha"
        // markers) — the detector itself is the honest challenged signal.
        const challenged = challenge !== null;
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
