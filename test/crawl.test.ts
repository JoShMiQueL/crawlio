import { describe, expect, it } from "vitest";
import { ConfigError, crawl, createScraper, HttpError, ScrapeError } from "../src/index.js";

type FetchImpl = typeof globalThis.fetch;

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };

interface Route {
  body: string;
  status?: number;
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
    return new Response(body, { status, headers: HTML_HEADERS });
  }) as FetchImpl;
  return { impl, calls };
}

const page = (title: string, links: string[] = []) =>
  `<html><body><h1>${title}</h1>${links
    .map((href) => `<a href="${href}">x</a>`)
    .join("")}</body></html>`;

/** Seed → a,b at depth 1 → a1,b1 at depth 2, plus dupes and an off-origin link. */
function graphRoutes(): Record<string, string | Route> {
  return {
    "https://example.com/": page("seed", ["/a", "/b"]),
    "https://example.com/a": page("a", ["/a1", "/", "https://other.example/x"]),
    "https://example.com/b": page("b", ["/b1"]),
    "https://example.com/a1": page("a1"),
    "https://example.com/b1": page("b1"),
  };
}

describe("crawl", () => {
  it("traverses breadth-first, same-origin only, deduplicated", async () => {
    const { impl, calls } = router(graphRoutes());
    const scraper = createScraper({ fetch: impl, robots: false });
    const result = await scraper.crawl("https://example.com/");
    expect(result.pages.map((p) => p.url)).toEqual([
      "https://example.com/",
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/a1",
      "https://example.com/b1",
    ]);
    expect(result.pages.map((p) => p.depth)).toEqual([0, 1, 1, 2, 2]);
    expect(result.visited).toBe(5);
    // The off-origin link on /a was never fetched.
    expect(calls.some((u) => u.startsWith("https://other.example"))).toBe(false);
  });

  it("honours maxDepth", async () => {
    const { impl } = router(graphRoutes());
    const scraper = createScraper({ fetch: impl, robots: false });
    const shallow = await scraper.crawl("https://example.com/", { maxDepth: 0 });
    expect(shallow.pages.map((p) => p.url)).toEqual(["https://example.com/"]);
    const one = await scraper.crawl("https://example.com/", { maxDepth: 1 });
    expect(one.pages.map((p) => p.url)).toEqual([
      "https://example.com/",
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it("caps the crawl at maxPages and counts the rest as skipped", async () => {
    const { impl } = router(graphRoutes());
    const scraper = createScraper({ fetch: impl, robots: false });
    const result = await scraper.crawl("https://example.com/", { maxPages: 3 });
    expect(result.pages).toHaveLength(3);
    expect(result.visited).toBe(3);
    // a1 and b1 were still queued when the cap hit.
    expect(result.skipped).toBe(2);
  });

  it("include restricts which links are enqueued", async () => {
    const { impl } = router(graphRoutes());
    const scraper = createScraper({ fetch: impl, robots: false });
    const result = await scraper.crawl("https://example.com/", {
      include: [/example\.com\/a/],
    });
    // Only /a and /a1 pass the filter; the seed itself is always visited.
    expect(result.pages.map((p) => p.url)).toEqual([
      "https://example.com/",
      "https://example.com/a",
      "https://example.com/a1",
    ]);
    expect(result.skipped).toBe(1); // /b filtered out
  });

  it("exclude drops matching links", async () => {
    const { impl } = router(graphRoutes());
    const scraper = createScraper({ fetch: impl, robots: false });
    const result = await scraper.crawl("https://example.com/", {
      exclude: [/\/b$/],
    });
    expect(result.pages.map((p) => p.url)).toEqual([
      "https://example.com/",
      "https://example.com/a",
      "https://example.com/a1",
    ]);
  });

  it("extracts fields per page when a spec is given", async () => {
    const { impl } = router(graphRoutes());
    const scraper = createScraper({ fetch: impl, robots: false });
    const result = await scraper.crawl("https://example.com/", {
      maxDepth: 1,
      fields: { title: "h1" },
    });
    expect(result.pages.map((p) => p.data?.title)).toEqual(["seed", "a", "b"]);
  });

  it("records a failing page as an error and keeps crawling", async () => {
    const routes = graphRoutes();
    routes["https://example.com/a"] = { body: "gone", status: 404 };
    const { impl } = router(routes);
    const scraper = createScraper({ fetch: impl, robots: false, retries: 0 });
    const result = await scraper.crawl("https://example.com/");
    const failed = result.pages.find((p) => p.url === "https://example.com/a");
    expect(failed?.error).toBeInstanceOf(HttpError);
    // /a produced no HTML, so /a1 is never discovered — but /b and /b1 are.
    expect(result.pages.map((p) => p.url)).toEqual([
      "https://example.com/",
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/b1",
    ]);
    expect(result.visited).toBe(3);
  });

  it("stops dequeuing on abort and returns what it has", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const routes = graphRoutes();
    const impl: FetchImpl = (async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      const route = routes[url];
      const response =
        route === undefined
          ? new Response("not found", { status: 404 })
          : new Response(typeof route === "string" ? route : route.body, {
              status: 200,
              headers: HTML_HEADERS,
            });
      // Once /a has been served, the caller loses interest.
      if (url === "https://example.com/a") controller.abort();
      return response;
    }) as FetchImpl;
    const scraper = createScraper({ fetch: impl, robots: false });
    const result = await scraper.crawl("https://example.com/", {
      signal: controller.signal,
    });
    expect(result.pages.map((p) => p.url)).toEqual([
      "https://example.com/",
      "https://example.com/a",
    ]);
    expect(calls).not.toContain("https://example.com/b");
  });

  it("a pre-aborted signal crawls nothing", async () => {
    const { impl } = router(graphRoutes());
    const controller = new AbortController();
    controller.abort();
    const scraper = createScraper({ fetch: impl, robots: false });
    const result = await scraper.crawl("https://example.com/", {
      signal: controller.signal,
    });
    expect(result.pages).toEqual([]);
    expect(result.visited).toBe(0);
  });

  it("page errors are ScrapeError instances", async () => {
    const { impl } = router({}); // everything 404s
    const scraper = createScraper({ fetch: impl, robots: false, retries: 0 });
    const result = await scraper.crawl("https://example.com/");
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.error).toBeInstanceOf(ScrapeError);
  });

  it("always visits the seed, even when exclude matches it", async () => {
    const { impl } = router(graphRoutes());
    const scraper = createScraper({ fetch: impl, robots: false });
    const result = await scraper.crawl("https://example.com/", {
      exclude: [/example\.com/],
    });
    // The seed is enqueued before filters apply; /a and /b are excluded.
    expect(result.pages.map((p) => p.url)).toEqual(["https://example.com/"]);
    expect(result.skipped).toBe(2);
  });

  it("treats query-param order as distinct URLs (no canonicalization)", async () => {
    const { impl } = router({
      "https://example.com/": page("seed", ["/p?a=1&b=2", "/p?b=2&a=1"]),
      "https://example.com/p?a=1&b=2": page("p-ab"),
      "https://example.com/p?b=2&a=1": page("p-ba"),
    });
    const scraper = createScraper({ fetch: impl, robots: false });
    const result = await scraper.crawl("https://example.com/", { maxDepth: 1 });
    expect(result.pages.map((p) => p.url)).toEqual([
      "https://example.com/",
      "https://example.com/p?a=1&b=2",
      "https://example.com/p?b=2&a=1",
    ]);
  });

  it("filters discovered links against the post-redirect origin", async () => {
    const impl: FetchImpl = (async (input: unknown) => {
      const url = String(input);
      if (url === "http://example.com/") {
        const response = new Response(
          page("seed", ["https://example.com/a", "http://example.com/b", "/c"]),
          { status: 200, headers: HTML_HEADERS },
        );
        // Simulate a http→https redirect: the response URL is what fetch reports.
        Object.defineProperty(response, "url", { value: "https://example.com/" });
        return response;
      }
      const bodies: Record<string, string> = {
        "https://example.com/a": page("a"),
        "https://example.com/c": page("c"),
      };
      const body = bodies[url];
      return body === undefined
        ? new Response("not found", { status: 404, headers: HTML_HEADERS })
        : new Response(body, { status: 200, headers: HTML_HEADERS });
    }) as FetchImpl;
    const scraper = createScraper({ fetch: impl, robots: false });
    const result = await scraper.crawl("http://example.com/", { maxDepth: 1 });
    // /c resolved to https://example.com/c; the http origin's /b is off-origin now.
    expect(result.pages.map((p) => p.url)).toEqual([
      "http://example.com/",
      "https://example.com/a",
      "https://example.com/c",
    ]);
  });

  it("does not refetch the post-redirect URL a page links back to", async () => {
    const calls: string[] = [];
    const impl: FetchImpl = (async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url === "http://example.com/") {
        const response = new Response(
          // A self-link to the https origin — where this page redirected to.
          page("seed", ["https://example.com/", "https://example.com/a"]),
          { status: 200, headers: HTML_HEADERS },
        );
        // Simulate a http→https redirect: the response URL is what fetch reports.
        Object.defineProperty(response, "url", { value: "https://example.com/" });
        return response;
      }
      if (url === "https://example.com/a") {
        return new Response(page("a"), { status: 200, headers: HTML_HEADERS });
      }
      return new Response("not found", { status: 404, headers: HTML_HEADERS });
    }) as FetchImpl;
    const scraper = createScraper({ fetch: impl, robots: false });
    const result = await scraper.crawl("http://example.com/", { maxDepth: 1 });
    // `seen` holds the pre-redirect seed; the post-redirect URL must count as
    // visited too — the self-link is deduped, only /a is followed.
    expect(result.pages.map((p) => p.url)).toEqual([
      "http://example.com/",
      "https://example.com/a",
    ]);
    expect(calls).not.toContain("https://example.com/");
    expect(result.visited).toBe(2);
  });

  it("rejects invalid bounds with ConfigError", async () => {
    const { impl } = router(graphRoutes());
    const scraper = createScraper({ fetch: impl, robots: false });
    await expect(scraper.crawl("https://example.com/", { maxDepth: -1 })).rejects.toBeInstanceOf(
      ConfigError,
    );
    await expect(scraper.crawl("https://example.com/", { maxPages: 1.5 })).rejects.toBeInstanceOf(
      ConfigError,
    );
    await expect(
      scraper.crawl("https://example.com/", { include: ["x"] as unknown as RegExp[] }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("is exported at module level", async () => {
    const { impl } = router({ "https://mod.example/": page("seed") });
    const result = await crawl("https://mod.example/", { fetch: impl, robots: false });
    expect(result.pages.map((p) => p.url)).toEqual(["https://mod.example/"]);
  });
});
