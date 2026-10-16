import { describe, expect, it } from "vitest";
import {
  ConfigError,
  createScraper,
  FetchError,
  fetchHtml,
  fetchRobotsTxt,
  HttpError,
  parseRobots,
  RobotsError,
  robotsAllowed,
  robotsUrlFor,
  ScrapeError,
  scrape,
  scrapeAll,
  scrapeMany,
  scrapeManySafe,
  TimeoutError,
} from "../src/index.js";
import { readFixture } from "./fixtures.js";

type FetchImpl = typeof globalThis.fetch;

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };

/** A fetch mock that always serves `body` with the given status. */
function staticFetch(body: string, status = 200, headers: Record<string, string> = HTML_HEADERS) {
  const calls: Array<{ input: unknown; init?: RequestInit }> = [];
  const impl: FetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(body, { status, headers });
  }) as FetchImpl;
  return { impl, calls };
}

describe("fetchHtml", () => {
  it("decodes an injected response", async () => {
    const html = readFixture("product-listing.html");
    const { impl, calls } = staticFetch(html);
    const result = await fetchHtml("https://example.com/listing", { fetch: impl });
    expect(result.html).toContain("product");
    expect(result.status).toBe(200);
    expect(result.contentType).toBe("text/html; charset=utf-8");
    expect(calls).toHaveLength(1);
  });

  it("sends an identifiable User-Agent header", async () => {
    const { impl, calls } = staticFetch("<html></html>");
    await fetchHtml("https://example.com/", { fetch: impl });
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("user-agent")).toContain("scrape-sdk/");
  });

  it("uses the injected fetch, never the global one", async () => {
    const { impl } = staticFetch("<html></html>");
    const original = globalThis.fetch;
    let globalCalled = false;
    globalThis.fetch = (async () => {
      globalCalled = true;
      return new Response("");
    }) as FetchImpl;
    try {
      await fetchHtml("https://example.com/", { fetch: impl });
      expect(globalCalled).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("returns status without throwing when throwOnHttpError is false", async () => {
    const { impl } = staticFetch("<html>gone</html>", 404);
    const result = await fetchHtml("https://example.com/x", {
      fetch: impl,
      throwOnHttpError: false,
    });
    expect(result.status).toBe(404);
    expect(result.html).toContain("gone");
  });

  it("throws HttpError on 404 and does not retry", async () => {
    const { impl, calls } = staticFetch("<html>nope</html>", 404);
    const err = await fetchHtml("https://example.com/x", { fetch: impl }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it("retries a 429 and eventually succeeds", async () => {
    const html = readFixture("product-listing.html");
    const calls: unknown[] = [];
    const impl: FetchImpl = (async (input: unknown) => {
      calls.push(input);
      const status = calls.length < 2 ? 429 : 200;
      return new Response(html, { status, headers: HTML_HEADERS });
    }) as FetchImpl;
    const result = await fetchHtml("https://example.com/x", { fetch: impl });
    expect(result.status).toBe(200);
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("retries a 503 once and succeeds on the second call", async () => {
    const calls: unknown[] = [];
    const impl: FetchImpl = (async (input: unknown) => {
      calls.push(input);
      const status = calls.length === 1 ? 503 : 200;
      return new Response("<html>ok</html>", { status, headers: HTML_HEADERS });
    }) as FetchImpl;
    const result = await fetchHtml("https://example.com/x", { fetch: impl });
    expect(result.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("per-call fetch overrides the instance default fetch", async () => {
    const a = staticFetch("<html>from-a</html>");
    const b = staticFetch("<html>from-b</html>");
    const scraper = createScraper({ fetch: a.impl });
    const result = await scraper.fetchHtml("https://override.example/", { fetch: b.impl });
    expect(result.html).toContain("from-b");
    expect(b.calls).toHaveLength(1);
    expect(a.calls).toHaveLength(0);
  });

  it("falls back to the instance fetch when no per-call fetch is given", async () => {
    const a = staticFetch("<html>from-a</html>");
    const scraper = createScraper({ fetch: a.impl });
    const result = await scraper.fetchHtml("https://override.example/");
    expect(result.html).toContain("from-a");
    expect(a.calls).toHaveLength(1);
  });

  it("times out on a hanging fetch and raises TimeoutError", async () => {
    const hanging: FetchImpl = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as FetchImpl;
    const err = await fetchHtml("https://example.com/x", {
      fetch: hanging,
      timeout: 40,
      retries: 0,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
  });

  it("surfaces a caller abort as FetchError and does NOT retry it", async () => {
    let calls = 0;
    const impl: FetchImpl = ((_input: unknown, init?: RequestInit) => {
      calls += 1;
      return Promise.reject(
        init?.signal?.aborted
          ? new DOMException("aborted", "AbortError")
          : new Error("expected an aborted signal"),
      );
    }) as FetchImpl;
    const controller = new AbortController();
    controller.abort();
    const err = await fetchHtml("https://example.com/x", {
      fetch: impl,
      signal: controller.signal,
      retries: 3,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).cause).toBeInstanceOf(DOMException);
    // A deliberate abort must fail exactly once — never retried. (With a
    // pre-aborted signal the attempt is rejected before fetch is even called.)
    expect(calls).toBeLessThanOrEqual(1);
  });

  it("surfaces a mid-flight caller abort as FetchError and does NOT retry it", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const impl: FetchImpl = ((_input: unknown, init?: RequestInit) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        release = () =>
          reject(
            init?.signal?.aborted
              ? new DOMException("aborted", "AbortError")
              : new Error("expected abort"),
          );
      });
    }) as FetchImpl;
    const controller = new AbortController();
    const pending = fetchHtml("https://example.com/x", {
      fetch: impl,
      signal: controller.signal,
      retries: 3,
    }).catch((e) => e);
    // Let the fetch be in flight, then abort.
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    release?.();
    const err = await pending;
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).cause).toBeInstanceOf(DOMException);
    expect(calls).toBe(1);
  });

  it("surfaces a mid-backoff caller abort as FetchError, not a raw DOMException", async () => {
    // First attempt fails retryably (429); the caller aborts while p-retry is
    // sleeping between attempts. p-retry rejects with the raw signal.reason —
    // the SDK must re-wrap it as a FetchError before it escapes.
    let calls = 0;
    const impl: FetchImpl = (async () => {
      calls += 1;
      return new Response("<html>retry me</html>", { status: 429 });
    }) as FetchImpl;
    const controller = new AbortController();
    const pending = fetchHtml("https://example.com/x", {
      fetch: impl,
      signal: controller.signal,
      retries: 3,
    }).catch((e) => e);
    // Let the first attempt fail and the backoff begin, then abort.
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    const err = await pending;
    expect(err).toBeInstanceOf(FetchError);
    expect(err).toBeInstanceOf(ScrapeError);
    expect(err).not.toBeInstanceOf(DOMException);
    expect((err as FetchError).cause).toBeInstanceOf(DOMException);
    expect(calls).toBe(1);
  });

  it("retries a network FetchError", async () => {
    let calls = 0;
    const impl: FetchImpl = (async () => {
      calls += 1;
      if (calls === 1) throw new Error("ECONNRESET");
      return new Response("<html>ok</html>", { status: 200, headers: HTML_HEADERS });
    }) as FetchImpl;
    const result = await fetchHtml("https://example.com/x", { fetch: impl });
    expect(result.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("throws ConfigError for an unparseable URL instead of a raw TypeError", async () => {
    const { impl, calls } = staticFetch("<html></html>");
    const err = await fetchHtml("not a url", { fetch: impl, retries: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err).toBeInstanceOf(ScrapeError);
    expect(calls).toHaveLength(0);
  });

  it("throws ConfigError for a non-integer retries instead of p-retry's TypeError", async () => {
    const { impl, calls } = staticFetch("<html></html>");
    const err = await fetchHtml("https://example.com/x", { fetch: impl, retries: 1.5 }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ConfigError);
    expect(err).toBeInstanceOf(ScrapeError);
    expect(calls).toHaveLength(0);
  });

  it("throws ConfigError for a negative timeout", async () => {
    const { impl, calls } = staticFetch("<html></html>");
    const err = await fetchHtml("https://example.com/x", { fetch: impl, timeout: -1 }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ConfigError);
    expect(calls).toHaveLength(0);
  });
});

describe("scrape", () => {
  it("scrapes a single page with typed fields", async () => {
    const html = readFixture("product-listing.html");
    const { impl } = staticFetch(html);
    const result = await scrape(
      "https://example.com/listing",
      {
        title: "h1#page-title",
        productNames: { selector: ".product-name", all: true },
        firstLink: { selector: ".product-link", attr: "href" },
      },
      { fetch: impl },
    );
    expect(result.title).toBe("Trail & Trek — Sale");
    expect(result.productNames).toHaveLength(3);
    // Relative href resolved against the fetched page URL.
    expect(result.firstLink).toBe("https://example.com/products/trail-shell-jacket");
  });

  it("scrapes containers with scrapeAll", async () => {
    const html = readFixture("product-listing.html");
    const { impl } = staticFetch(html);
    const items = await scrapeAll(
      "https://example.com/listing",
      "li.product",
      { name: ".product-name", price: ".price" },
      { fetch: impl },
    );
    expect(items).toHaveLength(3);
    expect(items[0]?.name).toBe("Trail Shell Jacket");
  });

  it("scrapeMany returns one result per url", async () => {
    const html = readFixture("product-listing.html");
    const { impl } = staticFetch(html);
    const results = await scrapeMany(
      ["https://example.com/a", "https://example.com/b", "https://example.com/c"],
      { title: "h1" },
      { fetch: impl },
    );
    expect(results).toHaveLength(3);
  });

  it("scrapeManySafe returns per-URL outcomes and never rejects", async () => {
    const impl: FetchImpl = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/good")) {
        return new Response("<html><h1>hi</h1></html>", {
          status: 200,
          headers: HTML_HEADERS,
        });
      }
      return new Response("", { status: 500 });
    }) as FetchImpl;
    const scraper = createScraper({ fetch: impl, retries: 0 });
    const results = await scraper.scrapeManySafe(
      ["https://example.com/good", "https://example.com/bad", "not a url"],
      { title: "h1" },
    );
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ ok: true, status: 200 });
    if (results[0]?.ok) expect(results[0].data.title).toBe("hi");
    expect(results[1]).toMatchObject({ ok: false, status: 500 });
    if (!results[1]?.ok && results[1] !== undefined) {
      expect(results[1].error).toBeInstanceOf(HttpError);
    }
    expect(results[2]?.ok).toBe(false);
    if (results[2] && !results[2].ok) {
      expect(results[2].error).toBeInstanceOf(ScrapeError);
    }
  });

  it("scrapeManySafe surfaces a mid-backoff abort as FetchError, not ConfigError", async () => {
    const impl: FetchImpl = (async () => new Response("", { status: 429 })) as FetchImpl;
    const controller = new AbortController();
    const scraper = createScraper({ fetch: impl, retries: 3 });
    const pending = scraper.scrapeManySafe(
      ["https://example.com/x"],
      { title: "h1" },
      {
        signal: controller.signal,
      },
    );
    // Abort while p-retry sleeps between attempts.
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    const results = await pending;
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    if (results[0] && !results[0].ok) {
      expect(results[0].error).toBeInstanceOf(FetchError);
      expect(results[0].error).not.toBeInstanceOf(ConfigError);
    }
  });

  it("scrapeManySafe is exported at module level", async () => {
    const { impl } = staticFetch("<html><h1>t</h1></html>");
    const results = await scrapeManySafe(
      ["https://example.com/a"],
      { title: "h1" },
      { fetch: impl },
    );
    expect(results[0]?.ok).toBe(true);
  });
});

describe("robots", () => {
  const TARGET = "https://example.com/private/page";

  function robotsFetch(robotsTxt: string | null, pageHtml: string) {
    const calls: string[] = [];
    const impl: FetchImpl = (async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/robots.txt")) {
        if (robotsTxt === null) return new Response("", { status: 404 });
        return new Response(robotsTxt, { status: 200, headers: { "content-type": "text/plain" } });
      }
      return new Response(pageHtml, { status: 200, headers: HTML_HEADERS });
    }) as FetchImpl;
    return { impl, calls };
  }

  it("parses and checks allow/disallow", () => {
    const agent = parseRobots(
      "https://example.com/robots.txt",
      "User-agent: *\nDisallow: /private",
    );
    expect(robotsAllowed(agent, "https://example.com/public", "ua")).toBe(true);
    expect(robotsAllowed(agent, "https://example.com/private", "ua")).toBe(false);
  });

  it("blocks a disallowed URL and never fetches the page", async () => {
    const { impl, calls } = robotsFetch("User-agent: *\nDisallow: /private", "<html></html>");
    const scraper = createScraper({ fetch: impl });
    const err = await scraper.fetchHtml(TARGET, { robots: true }).catch((e) => e);
    expect(err).toBeInstanceOf(RobotsError);
    // Only robots.txt was requested — the page was never fetched.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("https://example.com/robots.txt");
  });

  it("fetches robots.txt once per origin across multiple scrapes", async () => {
    const { impl, calls } = robotsFetch("User-agent: *\nAllow: /", "<html>x</html>");
    const scraper = createScraper({ fetch: impl, robots: true });
    await scraper.scrape("https://example.com/a", { t: "h1" });
    await scraper.scrape("https://example.com/b", { t: "h1" });
    const robotsCalls = calls.filter((u) => u.endsWith("/robots.txt"));
    expect(robotsCalls).toHaveLength(1);
    expect(calls).toHaveLength(3);
  });

  it("does not fetch robots.txt when robots is false (default)", async () => {
    const { impl, calls } = robotsFetch("User-agent: *\nDisallow: /", "<html></html>");
    const scraper = createScraper({ fetch: impl });
    await scraper.fetchHtml(TARGET);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(TARGET);
  });

  it("uses the per-call fetch for both robots.txt and the page", async () => {
    const a = robotsFetch("User-agent: *\nAllow: /", "<html>from-a</html>");
    const b = robotsFetch("User-agent: *\nAllow: /", "<html>from-b</html>");
    const scraper = createScraper({ fetch: a.impl });
    const result = await scraper.fetchHtml(TARGET, { fetch: b.impl, robots: true });
    expect(result.html).toContain("from-b");
    // robots.txt + the page, both through fetchB.
    expect(b.calls).toEqual(["https://example.com/robots.txt", TARGET]);
    expect(a.calls).toHaveLength(0);
  });

  it("honours a crawl-delay before hitting the page", async () => {
    const { impl } = robotsFetch("User-agent: *\nCrawl-delay: 1\nAllow: /", "<html></html>");
    const scraper = createScraper({ fetch: impl });
    const start = Date.now();
    await scraper.fetchHtml("https://example.com/x", { robots: true });
    expect(Date.now() - start).toBeGreaterThanOrEqual(900);
  });

  it("treats an unreachable robots.txt as allow-all", async () => {
    const { impl, calls } = robotsFetch(null, "<html>ok</html>");
    const scraper = createScraper({ fetch: impl });
    const result = await scraper.fetchHtml(TARGET, { robots: true });
    expect(result.status).toBe(200);
    expect(calls).toContain(TARGET);
  });

  it("does not poison the robots cache on a transient fetch failure", async () => {
    // First robots fetch fails (network blip); a failed result must be evicted
    // so the NEXT call to the same origin refetches robots.txt rather than
    // reusing the fallback allow-all for the scraper's lifetime.
    let robotsCalls = 0;
    const impl: FetchImpl = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/robots.txt")) {
        robotsCalls += 1;
        if (robotsCalls === 1) throw new Error("ECONNRESET");
        return new Response("User-agent: *\nDisallow: /private", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response("<html>ok</html>", { status: 200, headers: HTML_HEADERS });
    }) as FetchImpl;
    const scraper = createScraper({ fetch: impl, robots: true });
    const first = await scraper.fetchHtml("https://example.com/ok");
    expect(first.status).toBe(200);
    expect(robotsCalls).toBe(1);
    // Second call must refetch robots.txt — and now the fresh policy applies.
    const err = await scraper.fetchHtml(TARGET).catch((e) => e);
    expect(err).toBeInstanceOf(RobotsError);
    expect(robotsCalls).toBe(2);
  });

  it("re-fetches robots.txt when the effective fetch identity changes", async () => {
    const a = robotsFetch("User-agent: *\nAllow: /", "<html>from-a</html>");
    const b = robotsFetch("User-agent: *\nDisallow: /private", "<html>from-b</html>");
    const scraper = createScraper({ fetch: a.impl });
    await scraper.fetchHtml("https://example.com/ok", { robots: true });
    // Same origin, different injected fetch: robots.txt must be re-fetched
    // through b — and its stricter policy must apply.
    const err = await scraper.fetchHtml(TARGET, { fetch: b.impl, robots: true }).catch((e) => e);
    expect(err).toBeInstanceOf(RobotsError);
    expect(a.calls).toEqual(["https://example.com/robots.txt", "https://example.com/ok"]);
    expect(b.calls).toEqual(["https://example.com/robots.txt"]);
  });

  it("passes the caller signal through to the robots.txt fetch", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const impl: FetchImpl = (async (input: unknown, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      const url = String(input);
      if (url.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nAllow: /", { status: 200 });
      }
      return new Response("<html></html>", { status: 200, headers: HTML_HEADERS });
    }) as FetchImpl;
    const controller = new AbortController();
    const scraper = createScraper({ fetch: impl });
    await scraper.fetchHtml("https://example.com/x", { robots: true, signal: controller.signal });
    controller.abort();
    expect(signals.length).toBeGreaterThanOrEqual(2);
    // Both the robots fetch and the page fetch observed the caller's abort.
    for (const s of signals) expect(s?.aborted).toBe(true);
  });

  it("resolves robotsUrlFor to the origin root", () => {
    expect(robotsUrlFor("https://a.b.com:8080/deep/path?q=1")).toBe(
      "https://a.b.com:8080/robots.txt",
    );
  });

  it("fetchRobotsTxt returns null on missing file", async () => {
    const impl: FetchImpl = (async () => new Response("", { status: 404 })) as FetchImpl;
    expect(await fetchRobotsTxt("https://example.com/robots.txt", { fetch: impl })).toBeNull();
  });
});

describe("per-host serialisation", () => {
  it("serialises two same-origin requests", async () => {
    const starts: number[] = [];
    const impl: FetchImpl = (async () => {
      starts.push(Date.now());
      await new Promise((r) => setTimeout(r, 50));
      return new Response("<html></html>", { status: 200, headers: HTML_HEADERS });
    }) as FetchImpl;
    const scraper = createScraper({ fetch: impl });
    await Promise.all([
      scraper.fetchHtml("https://same.example/a"),
      scraper.fetchHtml("https://same.example/b"),
    ]);
    expect(starts).toHaveLength(2);
    const gap = (starts[1] as number) - (starts[0] as number);
    expect(Math.abs(gap)).toBeGreaterThanOrEqual(40);
  });

  it("runs different-origin requests in parallel", async () => {
    const impl: FetchImpl = (async () => {
      await new Promise((r) => setTimeout(r, 60));
      return new Response("<html></html>", { status: 200, headers: HTML_HEADERS });
    }) as FetchImpl;
    const scraper = createScraper({ fetch: impl });
    const start = Date.now();
    await Promise.all([
      scraper.fetchHtml("https://one.example/a"),
      scraper.fetchHtml("https://two.example/b"),
    ]);
    // Two 60ms requests in parallel finish well under the serial ~120ms.
    expect(Date.now() - start).toBeLessThan(110);
  });

  it("lets a cross-origin request start while same-origin tasks are queued", async () => {
    // Regression: the global p-limit must wrap the actual fetch, not the wait
    // on the per-origin queue. With the wrong composition the queued A-tasks
    // would hold both global slots and B could not start until they drained.
    const starts = new Map<string, number>();
    const impl: FetchImpl = (async (input: unknown) => {
      starts.set(String(input), Date.now());
      await new Promise((r) => setTimeout(r, 80));
      return new Response("<html></html>", { status: 200, headers: HTML_HEADERS });
    }) as FetchImpl;
    const scraper = createScraper({ fetch: impl, concurrency: 2 });
    const t0 = Date.now();
    await Promise.all([
      scraper.fetchHtml("https://a.example/1"),
      scraper.fetchHtml("https://a.example/2"),
      scraper.fetchHtml("https://a.example/3"),
      scraper.fetchHtml("https://b.example/1"),
    ]);
    const bStart = starts.get("https://b.example/1");
    const a1Start = starts.get("https://a.example/1");
    expect(bStart).toBeDefined();
    expect(a1Start).toBeDefined();
    // B must have started during the first wave (~0ms), not after ~160ms of
    // waiting for the A queue to drain.
    expect((bStart as number) - (a1Start as number)).toBeLessThan(50);
    // Sanity: the three same-origin fetches serialised — third start is late.
    const a3Start = starts.get("https://a.example/3") as number;
    expect(a3Start - t0).toBeGreaterThanOrEqual(140);
  });

  it("a rejected task does not stall its origin queue", async () => {
    const order: string[] = [];
    const impl: FetchImpl = (async (input: unknown) => {
      const url = String(input);
      order.push(url);
      if (url.endsWith("/fail")) throw new Error("network down");
      return new Response("<html></html>", { status: 200, headers: HTML_HEADERS });
    }) as FetchImpl;
    const scraper = createScraper({ fetch: impl, retries: 0 });
    const failed = scraper.fetchHtml("https://x.example/fail").catch((e) => e);
    const ok = scraper.fetchHtml("https://x.example/ok");
    const [failResult, okResult] = await Promise.all([failed, ok]);
    expect(failResult).toBeInstanceOf(FetchError);
    expect(okResult.status).toBe(200);
    expect(order).toEqual(["https://x.example/fail", "https://x.example/ok"]);
  });
});
