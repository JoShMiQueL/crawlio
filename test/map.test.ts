import { describe, expect, it } from "vitest";
import { ConfigError, createScraper, map } from "../src/index.js";

type FetchImpl = typeof globalThis.fetch;

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };
const XML_HEADERS = { "content-type": "application/xml" };

interface Route {
  body: string;
  status?: number;
  headers?: Record<string, string>;
}

/** A fetch mock routing exact URLs to fixture responses; unlisted URLs 404. */
function router(routes: Record<string, string | Route>) {
  const calls: string[] = [];
  const impl: FetchImpl = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    const route = routes[url];
    if (route === undefined) return new Response("not found", { status: 404 });
    const body = typeof route === "string" ? route : route.body;
    const status = typeof route === "string" ? 200 : (route.status ?? 200);
    const headers = typeof route === "string" ? HTML_HEADERS : (route.headers ?? HTML_HEADERS);
    return new Response(body, { status, headers });
  }) as FetchImpl;
  return { impl, calls };
}

const URLSET = (locs: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs}</urlset>`;

const INDEX = (locs: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs}</sitemapindex>`;

describe("map", () => {
  it("reads urlset entries with and without lastmod", async () => {
    const { impl, calls } = router({
      "https://example.com/sitemap.xml": {
        body: URLSET(
          `<url><loc>https://example.com/a</loc><lastmod>2024-01-15</lastmod></url>` +
            `<url><loc>https://example.com/b</loc></url>`,
        ),
        headers: XML_HEADERS,
      },
    });
    const scraper = createScraper({ fetch: impl });
    const result = await scraper.map("https://example.com/");
    expect(result.source).toBe("sitemap");
    expect(result.urls).toEqual([
      { url: "https://example.com/a", lastModified: "2024-01-15" },
      { url: "https://example.com/b" },
    ]);
    // robots.txt twice (map's own Sitemap-directive probe, then the scraper's
    // internal robots gate for the sitemap fetch), then the sitemap itself.
    expect(calls).toEqual([
      "https://example.com/robots.txt",
      "https://example.com/robots.txt",
      "https://example.com/sitemap.xml",
    ]);
  });

  it("discovers sitemap URLs from the robots.txt Sitemap directive", async () => {
    const { impl, calls } = router({
      "https://example.com/robots.txt": {
        body: "User-agent: *\nAllow: /\nSitemap: https://example.com/maps/sm.xml\n",
        headers: { "content-type": "text/plain" },
      },
      "https://example.com/maps/sm.xml": {
        body: URLSET(`<url><loc>https://example.com/one</loc></url>`),
        headers: XML_HEADERS,
      },
    });
    const scraper = createScraper({ fetch: impl });
    const result = await scraper.map("https://example.com/deep/page");
    expect(result.source).toBe("sitemap");
    expect(result.urls).toEqual([{ url: "https://example.com/one" }]);
    expect(calls).toContain("https://example.com/maps/sm.xml");
  });

  it("skips a robots.txt Sitemap directive on a foreign origin", async () => {
    // A cross-origin `Sitemap:` loc must never be fetched — the file is only
    // authoritative for its own origin, and following it is an SSRF channel.
    const { impl, calls } = router({
      "https://example.com/robots.txt": {
        body: "User-agent: *\nAllow: /\nSitemap: https://other.example/x.xml\n",
        headers: { "content-type": "text/plain" },
      },
      "https://example.com/sitemap.xml": {
        body: URLSET(`<url><loc>https://example.com/ok</loc></url>`),
        headers: XML_HEADERS,
      },
    });
    const scraper = createScraper({ fetch: impl });
    const result = await scraper.map("https://example.com/");
    expect(calls).not.toContain("https://other.example/x.xml");
    expect(result.source).toBe("sitemap");
    expect(result.urls).toEqual([{ url: "https://example.com/ok" }]);
  });

  it("follows a sitemapindex into its nested sitemaps", async () => {
    const { impl } = router({
      "https://example.com/sitemap.xml": {
        body: INDEX(
          `<sitemap><loc>https://example.com/sm-a.xml</loc></sitemap>` +
            `<sitemap><loc>https://example.com/sm-b.xml</loc></sitemap>`,
        ),
        headers: XML_HEADERS,
      },
      "https://example.com/sm-a.xml": {
        body: URLSET(`<url><loc>https://example.com/a</loc></url>`),
        headers: XML_HEADERS,
      },
      "https://example.com/sm-b.xml": {
        body: URLSET(`<url><loc>https://example.com/b</loc><lastmod>2024-02-02</lastmod></url>`),
        headers: XML_HEADERS,
      },
    });
    const scraper = createScraper({ fetch: impl });
    const result = await scraper.map("https://example.com/");
    expect(result.source).toBe("sitemap");
    expect(result.urls.map((entry) => entry.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it("bounds nested sitemap fetches to 50 documents", async () => {
    const routes: Record<string, string | Route> = {
      "https://example.com/": "<html></html>",
      "https://example.com/sitemap.xml": {
        body: INDEX(
          Array.from(
            { length: 60 },
            (_, i) => `<sitemap><loc>https://example.com/sm-${i}.xml</loc></sitemap>`,
          ).join(""),
        ),
        headers: XML_HEADERS,
      },
    };
    const { impl, calls } = router(routes);
    const scraper = createScraper({ fetch: impl, robots: false });
    await scraper.map("https://example.com/");
    // 1 index + 49 nested = 50 sitemap documents, then the seed-page fallback.
    const sitemapCalls = calls.filter((u) => u.endsWith(".xml"));
    expect(sitemapCalls).toHaveLength(50);
  });

  it("falls back to same-origin links when no sitemap yields URLs", async () => {
    const { impl } = router({
      "https://example.com/": `<html><body>
        <a href="/a">a</a>
        <a href="https://example.com/b#section">b</a>
        <a href="https://other.example/c">off-origin</a>
        <a href="mailto:x@example.com">mail</a>
        <a href="d">relative</a>
      </body></html>`,
    });
    const scraper = createScraper({ fetch: impl, robots: false });
    const result = await scraper.map("https://example.com/");
    expect(result.source).toBe("links");
    expect(result.urls.map((entry) => entry.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/d",
    ]);
  });

  it("skips a dead sitemap candidate and tries the next one", async () => {
    const { impl } = router({
      "https://example.com/robots.txt": {
        body: "User-agent: *\nAllow: /\nSitemap: https://example.com/dead.xml\n",
        headers: { "content-type": "text/plain" },
      },
      "https://example.com/sitemap.xml": {
        body: URLSET(`<url><loc>https://example.com/ok</loc></url>`),
        headers: XML_HEADERS,
      },
    });
    const scraper = createScraper({ fetch: impl });
    const result = await scraper.map("https://example.com/");
    expect(result.source).toBe("sitemap");
    expect(result.urls).toEqual([{ url: "https://example.com/ok" }]);
  });

  it("deduplicates and normalizes sitemap entries", async () => {
    const { impl } = router({
      "https://example.com/sitemap.xml": {
        body: URLSET(
          `<url><loc>https://example.com/a</loc></url>` +
            `<url><loc>/a#frag</loc></url>` +
            `<url><loc>https://example.com/a</loc><lastmod>2024-03-03</lastmod></url>`,
        ),
        headers: XML_HEADERS,
      },
    });
    const scraper = createScraper({ fetch: impl, robots: false });
    const result = await scraper.map("https://example.com/");
    expect(result.urls).toEqual([{ url: "https://example.com/a" }]);
  });

  it("truncates the result to limit", async () => {
    const { impl } = router({
      "https://example.com/sitemap.xml": {
        body: URLSET(
          Array.from(
            { length: 5 },
            (_, i) => `<url><loc>https://example.com/p${i}</loc></url>`,
          ).join(""),
        ),
        headers: XML_HEADERS,
      },
    });
    const scraper = createScraper({ fetch: impl, robots: false });
    const result = await scraper.map("https://example.com/", { limit: 2 });
    expect(result.urls).toHaveLength(2);
    expect(result.urls[0]?.url).toBe("https://example.com/p0");
  });

  it("tries every declared candidate before nested sitemaps", async () => {
    const { impl, calls } = router({
      "https://example.com/robots.txt": {
        body: "User-agent: *\nAllow: /\nSitemap: https://example.com/index.xml\n",
        headers: { "content-type": "text/plain" },
      },
      "https://example.com/index.xml": {
        body: INDEX(`<sitemap><loc>https://example.com/child.xml</loc></sitemap>`),
        headers: XML_HEADERS,
      },
      "https://example.com/child.xml": {
        body: URLSET(`<url><loc>https://example.com/child-url</loc></url>`),
        headers: XML_HEADERS,
      },
      "https://example.com/sitemap.xml": {
        body: URLSET(`<url><loc>https://example.com/direct</loc></url>`),
        headers: XML_HEADERS,
      },
    });
    const scraper = createScraper({ fetch: impl });
    const result = await scraper.map("https://example.com/");
    expect(result.urls.map((entry) => entry.url)).toEqual([
      "https://example.com/direct",
      "https://example.com/child-url",
    ]);
    // /sitemap.xml is a declared candidate — the index's child must wait.
    expect(calls.indexOf("https://example.com/sitemap.xml")).toBeLessThan(
      calls.indexOf("https://example.com/child.xml"),
    );
  });

  it("falls through to the links fallback on a malformed sitemap", async () => {
    const { impl } = router({
      "https://example.com/sitemap.xml": {
        body: "this is not <xml at all <<<",
        headers: XML_HEADERS,
      },
      "https://example.com/": `<html><body><a href="/a">a</a></body></html>`,
    });
    const scraper = createScraper({ fetch: impl, robots: false });
    const result = await scraper.map("https://example.com/");
    expect(result.source).toBe("links");
    expect(result.urls).toEqual([{ url: "https://example.com/a" }]);
  });

  it("drops urlset entries on a different origin than the sitemap", async () => {
    const { impl } = router({
      "https://example.com/sitemap.xml": {
        body: URLSET(
          `<url><loc>https://example.com/ok</loc></url>` +
            `<url><loc>https://other.example/nope</loc></url>` +
            `<url><loc>http://example.com/not-this-origin</loc></url>`,
        ),
        headers: XML_HEADERS,
      },
    });
    const scraper = createScraper({ fetch: impl, robots: false });
    const result = await scraper.map("https://example.com/");
    expect(result.urls).toEqual([{ url: "https://example.com/ok" }]);
  });

  it("skips nested sitemap locs on a different origin than the index", async () => {
    const { impl, calls } = router({
      "https://example.com/sitemap.xml": {
        body: INDEX(
          `<sitemap><loc>https://example.com/sm-ok.xml</loc></sitemap>` +
            `<sitemap><loc>https://other.example/nope.xml</loc></sitemap>` +
            `<sitemap><loc>http://example.com/not-this-origin.xml</loc></sitemap>`,
        ),
        headers: XML_HEADERS,
      },
      "https://example.com/sm-ok.xml": {
        body: URLSET(`<url><loc>https://example.com/a</loc></url>`),
        headers: XML_HEADERS,
      },
    });
    const scraper = createScraper({ fetch: impl, robots: false });
    const result = await scraper.map("https://example.com/");
    expect(result.urls).toEqual([{ url: "https://example.com/a" }]);
    // Off-origin children are invalid per the sitemap protocol — never fetched.
    expect(calls).not.toContain("https://other.example/nope.xml");
    expect(calls).not.toContain("http://example.com/not-this-origin.xml");
  });

  it("filters links against the post-redirect origin in the links fallback", async () => {
    const impl: FetchImpl = (async (input: unknown) => {
      const url = String(input);
      if (url === "http://example.com/") {
        const response = new Response(
          `<html><body>
            <a href="https://example.com/a">a</a>
            <a href="http://example.com/b">b</a>
          </body></html>`,
          { status: 200, headers: HTML_HEADERS },
        );
        // Simulate a http→https redirect: the response URL is what fetch reports.
        Object.defineProperty(response, "url", { value: "https://example.com/" });
        return response;
      }
      return new Response("not found", { status: 404 });
    }) as FetchImpl;
    const scraper = createScraper({ fetch: impl, robots: false });
    const result = await scraper.map("http://example.com/");
    expect(result.source).toBe("links");
    expect(result.urls).toEqual([{ url: "https://example.com/a" }]);
  });

  it("returns what was collected when the signal aborts mid-discovery", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const impl: FetchImpl = (async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nAllow: /\nSitemap: https://example.com/a.xml\n", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === "https://example.com/a.xml") {
        return new Response(URLSET(`<url><loc>https://example.com/a</loc></url>`), {
          status: 200,
          headers: XML_HEADERS,
        });
      }
      // The next candidate's fetch is where the caller loses interest — the
      // already-collected entries survive.
      if (url === "https://example.com/sitemap.xml") controller.abort();
      return new Response("not found", { status: 404 });
    }) as FetchImpl;
    const scraper = createScraper({ fetch: impl });
    const result = await scraper.map("https://example.com/", { signal: controller.signal });
    expect(result.urls).toEqual([{ url: "https://example.com/a" }]);
    expect(result.source).toBe("sitemap");
  });

  it("a pre-aborted signal returns an empty result instead of throwing", async () => {
    const { impl } = router({});
    const controller = new AbortController();
    controller.abort();
    const scraper = createScraper({ fetch: impl });
    const result = await scraper.map("https://example.com/", { signal: controller.signal });
    expect(result.urls).toEqual([]);
  });

  it("rejects an invalid limit with ConfigError", async () => {
    const { impl } = router({});
    const scraper = createScraper({ fetch: impl, robots: false });
    await expect(scraper.map("https://example.com/", { limit: -1 })).rejects.toBeInstanceOf(
      ConfigError,
    );
    await expect(scraper.map("https://example.com/", { limit: 1.5 })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it("under stealth, the Sitemap probe and the fetches share the profile UA", async () => {
    // Records (url, headers) per request — the recording-fetch convention.
    const calls: Array<{ url: string; headers: Headers }> = [];
    const impl: FetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      if (url === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nAllow: /\n", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === "https://example.com/sitemap.xml") {
        return new Response(URLSET(`<url><loc>https://example.com/a</loc></url>`), {
          status: 200,
          headers: XML_HEADERS,
        });
      }
      return new Response("not found", { status: 404 });
    }) as FetchImpl;
    // No explicit userAgent anywhere — the profile UA is the fallback.
    const scraper = createScraper({ fetch: impl, stealth: true });
    const result = await scraper.map("https://example.com/");
    expect(result.source).toBe("sitemap");
    // calls[0] is map's own robots.txt Sitemap: probe — it bypasses the
    // fetch pipeline, so the scraper hands it the wire UA explicitly. Under
    // stealth that must be the profile's UA, not the honest crawlio/ default;
    // fetchHtml (the sitemap document + the internal robots gate) resolves
    // the same fallback, so EVERY request goes out as the profile.
    expect(calls[0]?.url).toBe("https://example.com/robots.txt");
    expect(calls.some((call) => call.url === "https://example.com/sitemap.xml")).toBe(true);
    for (const call of calls) {
      expect(call.headers.get("user-agent")).toContain("Chrome/131.0.0.0");
      expect(call.headers.get("user-agent")).not.toContain("crawlio/");
    }
  });

  it("is exported at module level", async () => {
    const { impl } = router({
      "https://mod.example/": `<html><body><a href="/x">x</a></body></html>`,
    });
    const result = await map("https://mod.example/", { fetch: impl, robots: false });
    expect(result.source).toBe("links");
    expect(result.urls).toEqual([{ url: "https://mod.example/x" }]);
  });
});
