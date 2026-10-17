import { describe, expect, it } from "vitest";
import {
  ConfigError,
  createScraper,
  fetchHtml,
  fetchHtmlOnce,
  HttpError,
  type ProxyFetchFactory,
  ProxyPool,
  type ProxyPoolOptions,
  type ScraperOptions,
  TimeoutError,
} from "../src/index.js";

type FetchImpl = typeof globalThis.fetch;

const P1 = "http://proxy-one.example:8080";
const P2 = "http://proxy-two.example:8080";
const P3 = "http://proxy-three.example:8080";

const okHtml = (body = "<html><h1>ok</h1></html>") =>
  new Response(body, { status: 200, headers: { "content-type": "text/html" } });

/**
 * A fetchFactory stub recording (proxyUrl, targetUrl) per wire request — the
 * same seam the SDK uses to swap undici's ProxyAgent for tests, so all
 * rotation/health logic runs here with zero network.
 */
function recordingFactory(
  handler: (
    proxyUrl: string,
    url: string,
    init?: RequestInit,
  ) => Response | Promise<Response> = () => okHtml(),
) {
  const calls: Array<{ proxyUrl: string; url: string }> = [];
  const factory: ProxyFetchFactory = (proxyUrl) =>
    (async (input: Parameters<FetchImpl>[0], init?: RequestInit) => {
      const url = String(input);
      calls.push({ proxyUrl, url });
      return handler(proxyUrl, url, init);
    }) as FetchImpl;
  return { factory, calls };
}

/**
 * The `__proxyPool` field is the internal test seam `createScraper` reads but
 * `ScraperOptions` deliberately does not declare — hence the cast.
 */
function scraperWithHooks(
  hooks: Pick<ProxyPoolOptions, "fetchFactory" | "now" | "banThreshold" | "cooldownMs">,
  options: ScraperOptions = {},
) {
  return createScraper({ ...options, __proxyPool: hooks } as ScraperOptions);
}

describe("proxy rotation", () => {
  it("per-origin binds each origin to one proxy (round-robin on first touch)", async () => {
    const { factory, calls } = recordingFactory();
    const pool = new ProxyPool({ proxies: [P1, P2], fetchFactory: factory });
    const a = pool.fetchFor("https://a.example");
    const b = pool.fetchFor("https://b.example");
    await a("https://a.example/1");
    await a("https://a.example/2");
    await b("https://b.example/1");
    await a("https://a.example/3");
    expect(calls.map((c) => c.proxyUrl)).toEqual([P1, P1, P2, P1]);
    // The wrapper is stable per origin — the scraper keys its robots cache on it.
    expect(pool.fetchFor("https://a.example")).toBe(a);
  });

  it("per-origin stays sticky across ban-status responses", async () => {
    const { factory, calls } = recordingFactory((proxyUrl) =>
      proxyUrl === P1 ? new Response("blocked", { status: 403 }) : okHtml(),
    );
    const pool = new ProxyPool({ proxies: [P1, P2], fetchFactory: factory });
    const a = pool.fetchFor("https://a.example");
    await a("https://a.example/1");
    await a("https://a.example/2");
    // Sticky by design — per-origin never rebinds; use on-ban for that.
    expect(calls.map((c) => c.proxyUrl)).toEqual([P1, P1]);
  });

  it("per-request round-robins every wire request", async () => {
    const { factory, calls } = recordingFactory();
    const pool = new ProxyPool({
      proxies: [P1, P2, P3],
      rotation: "per-request",
      fetchFactory: factory,
    });
    const a = pool.fetchFor("https://a.example");
    for (let i = 0; i < 4; i++) await a(`https://a.example/${i}`);
    expect(calls.map((c) => c.proxyUrl)).toEqual([P1, P2, P3, P1]);
  });

  it("a single pinned proxy serves every origin", async () => {
    const { factory, calls } = recordingFactory();
    const pool = new ProxyPool({ proxies: [P1], fetchFactory: factory });
    await pool.fetchFor("https://a.example")("https://a.example/1");
    await pool.fetchFor("https://b.example")("https://b.example/1");
    expect(calls.map((c) => c.proxyUrl)).toEqual([P1, P1]);
  });
});

describe("on-ban rotation", () => {
  it.each([403, 407, 429])("reassigns the origin's proxy on HTTP %i", async (status) => {
    const { factory, calls } = recordingFactory((proxyUrl) =>
      proxyUrl === P1 ? new Response("no", { status }) : okHtml(),
    );
    const pool = new ProxyPool({
      proxies: [P1, P2],
      rotation: "on-ban",
      fetchFactory: factory,
    });
    const a = pool.fetchFor("https://a.example");
    await a("https://a.example/1"); // P1 → ban status → rebind
    await a("https://a.example/2"); // → P2
    expect(calls.map((c) => c.proxyUrl)).toEqual([P1, P2]);
  });

  it("reassigns on transport failure", async () => {
    const { factory, calls } = recordingFactory((proxyUrl) =>
      proxyUrl === P1 ? Promise.reject(new Error("connect ECONNREFUSED")) : okHtml(),
    );
    const pool = new ProxyPool({
      proxies: [P1, P2],
      rotation: "on-ban",
      fetchFactory: factory,
    });
    const a = pool.fetchFor("https://a.example");
    await a("https://a.example/1").catch(() => {});
    await a("https://a.example/2");
    expect(calls.map((c) => c.proxyUrl)).toEqual([P1, P2]);
  });

  it("reassigns on a reported challenge page (reportBan)", async () => {
    const { factory, calls } = recordingFactory();
    const pool = new ProxyPool({
      proxies: [P1, P2],
      rotation: "on-ban",
      fetchFactory: factory,
    });
    const a = pool.fetchFor("https://a.example");
    await a("https://a.example/1"); // P1 serves a clean 200
    pool.reportBan("https://a.example"); // scraper's challenge signal
    await a("https://a.example/2");
    expect(calls.map((c) => c.proxyUrl)).toEqual([P1, P2]);
  });

  it("dedupes a reportBan for a response already charged by status", async () => {
    // banThreshold 2: one 403 + one deduped challenge report on the SAME
    // response must not quarantine — proves a response is charged once.
    const { factory, calls } = recordingFactory((proxyUrl) =>
      proxyUrl === P1 ? new Response("no", { status: 403 }) : okHtml(),
    );
    const pool = new ProxyPool({
      proxies: [P1, P2],
      rotation: "on-ban",
      fetchFactory: factory,
      banThreshold: 2,
    });
    const a = pool.fetchFor("https://a.example");
    await a("https://a.example/1"); // P1 403 → charged once; origin → P2
    pool.reportBan("https://a.example"); // challenge on the same response — no-op
    const b = pool.fetchFor("https://b.example");
    await b("https://b.example/1"); // P1 is NOT cooled → round-robin serves it
    expect(calls.map((c) => c.proxyUrl)).toEqual([P1, P1]);
  });
});

describe("proxy health", () => {
  it("quarantines a proxy after N consecutive failures and re-admits it on cooldown expiry", async () => {
    let now = 0;
    const { factory, calls } = recordingFactory((proxyUrl) =>
      proxyUrl === P1 ? Promise.reject(new Error("down")) : okHtml(),
    );
    const pool = new ProxyPool({
      proxies: [P1, P2],
      rotation: "per-request",
      fetchFactory: factory,
      now: () => now,
      banThreshold: 3,
      cooldownMs: 300_000,
    });
    const a = pool.fetchFor("https://a.example");
    // Round-robin interleaves P2 successes; P1's own streak is what counts.
    for (let i = 0; i < 5; i++) {
      await a(`https://a.example/${i}`).catch(() => {});
    }
    // Calls: P1,P2,P1,P2,P1 → P1 failed 3× → quarantined until now+300_000.
    expect(calls.map((c) => c.proxyUrl)).toEqual([P1, P2, P1, P2, P1]);
    await a("https://a.example/quarantined");
    expect(calls.at(-1)?.proxyUrl).toBe(P2); // P1 skipped while cooled
    now += 300_001; // cooldown expires
    await a("https://a.example/back").catch(() => {}); // P1 still fails — but it's picked
    expect(calls.at(-1)?.proxyUrl).toBe(P1); // eligible again
  });

  it("falls back to the earliest-expiring proxy when all are quarantined", async () => {
    let now = 0;
    const { factory, calls } = recordingFactory(() => Promise.reject(new Error("down")));
    const pool = new ProxyPool({
      proxies: [P1, P2],
      rotation: "per-request",
      fetchFactory: factory,
      now: () => now,
      banThreshold: 3,
      cooldownMs: 100,
    });
    const a = pool.fetchFor("https://a.example");
    // P1,P2,P1,P2,P1 → P1 racks up its 3rd failure → cooled at t=0 (expiry 100).
    for (let i = 0; i < 5; i++) await a(`https://a.example/${i}`).catch(() => {});
    now = 50; // P1 quarantined → only P2 serves; one more failure cools it.
    await a("https://a.example/6").catch(() => {}); // P2 fail #3 → cooled until 150
    calls.length = 0;
    await a("https://a.example/7").catch(() => {});
    // All cooled → the earliest-expiring proxy serves: P1 (100 < 150).
    expect(calls[0]?.proxyUrl).toBe(P1);
    await a("https://a.example/8").catch(() => {});
    expect(calls[1]?.proxyUrl).toBe(P1); // still all-cooled → same fallback
  });

  it("a caller abort does not count as a proxy failure", async () => {
    const abort = new DOMException("aborted", "AbortError");
    const { factory, calls } = recordingFactory(() => Promise.reject(abort));
    const pool = new ProxyPool({
      proxies: [P1, P2],
      rotation: "per-request",
      fetchFactory: factory,
      banThreshold: 2,
    });
    const a = pool.fetchFor("https://a.example");
    for (let i = 0; i < 4; i++) await a(`https://a.example/${i}`).catch(() => {});
    // AbortError is never charged — rotation continues unpenalized.
    expect(calls.map((c) => c.proxyUrl)).toEqual([P1, P2, P1, P2]);
  });
});

describe("proxy config validation", () => {
  it("rejects combining proxies with an injected fetch — instance and per-call", async () => {
    let called = 0;
    const noop: FetchImpl = (async () => {
      called += 1;
      return okHtml();
    }) as FetchImpl;
    expect(() => createScraper({ fetch: noop, proxies: [P1] })).toThrow(ConfigError);
    await expect(
      fetchHtml("https://example.com/", { fetch: noop, proxy: P1, robots: false }),
    ).rejects.toBeInstanceOf(ConfigError);
    await expect(
      fetchHtml("https://example.com/", { fetch: noop, proxies: [P1], robots: false }),
    ).rejects.toBeInstanceOf(ConfigError);
    // The conflict throws before anything touches the wire.
    expect(called).toBe(0);
  });

  it("rejects SOCKS proxy URLs and points at fetch injection", async () => {
    for (const scheme of ["socks", "socks4", "socks5"]) {
      expect(() => createScraper({ proxies: [`${scheme}://proxy.example:1080`] })).toThrow(
        ConfigError,
      );
    }
    expect(() => createScraper({ proxies: ["socks5://proxy.example:1080"] })).toThrow(/fetch/);
    await expect(
      fetchHtml("https://example.com/", {
        proxy: "socks5://proxy.example:1080",
        robots: false,
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it("rejects non-http(s) schemes, malformed URLs, empty pools and bad rotations", () => {
    expect(() => new ProxyPool({ proxies: ["ftp://proxy.example"] })).toThrow(ConfigError);
    expect(() => new ProxyPool({ proxies: ["not a url"] })).toThrow(ConfigError);
    expect(() => new ProxyPool({ proxies: [] })).toThrow(ConfigError);
    expect(() => new ProxyPool({ proxies: [P1], rotation: "round-robin" as never })).toThrow(
      ConfigError,
    );
  });

  it("never leaks proxy credentials into error messages", () => {
    const socksErr = (() => {
      try {
        return new ProxyPool({ proxies: ["socks5://s3cret-user:p@ssw0rd@proxy.example:1080"] });
      } catch (error) {
        return error;
      }
    })();
    expect(socksErr).toBeInstanceOf(ConfigError);
    expect((socksErr as Error).message).not.toContain("s3cret-user");
    expect((socksErr as Error).message).not.toContain("p@ssw0rd");
    expect((socksErr as Error).message).toContain("socks5://proxy.example:1080");

    const schemeErr = (() => {
      try {
        return new ProxyPool({ proxies: ["ftp://s3cret-user:p@ssw0rd@proxy.example"] });
      } catch (error) {
        return error;
      }
    })();
    expect((schemeErr as Error).message).not.toContain("s3cret-user");
    expect((schemeErr as Error).message).not.toContain("p@ssw0rd");
    expect((schemeErr as Error).message).toContain("ftp://proxy.example");
  });
});

describe("pool housekeeping", () => {
  it("collapses duplicate proxy URLs into one health record", async () => {
    // Without dedup, `stateByUrl` (last-wins) and `states` (every entry)
    // disagree about which record owns the repeated URL.
    const { factory, calls } = recordingFactory();
    const pool = new ProxyPool({
      proxies: [P1, P1, P2],
      rotation: "per-request",
      fetchFactory: factory,
    });
    const a = pool.fetchFor("https://a.example");
    for (let i = 0; i < 4; i++) await a(`https://a.example/${i}`);
    expect(calls.map((c) => c.proxyUrl)).toEqual([P1, P2, P1, P2]);
  });

  it("close() resolves and is a no-op for custom fetch factories", async () => {
    const pool = new ProxyPool({ proxies: [P1], fetchFactory: recordingFactory().factory });
    await expect(pool.close()).resolves.toBeUndefined();
    // The pool remains usable afterwards.
    await pool.fetchFor("https://a.example")("https://a.example/1");
  });

  it("close() releases the default factory's dispatchers", async () => {
    const pool = new ProxyPool({ proxies: [P1] });
    await expect(pool.close()).resolves.toBeUndefined();
  });
});

describe("scraper-level proxy behaviour (via __proxyPool seam)", () => {
  it("a timeout through a proxy reports a ban — on-ban rebinds the origin", async () => {
    const { factory, calls } = recordingFactory((proxyUrl, _url, init) =>
      proxyUrl === P1
        ? // Hang until fetchHtmlOnce's own timeout aborts the request.
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          })
        : okHtml(),
    );
    const scraper = scraperWithHooks(
      { fetchFactory: factory },
      { proxies: [P1, P2], proxyRotation: "on-ban" },
    );
    await expect(
      scraper.fetchHtml("https://a.example/1", { robots: false, timeout: 20, retries: 0 }),
    ).rejects.toBeInstanceOf(TimeoutError);
    const result = await scraper.fetchHtml("https://a.example/2", {
      robots: false,
      timeout: 1000,
      retries: 0,
    });
    expect(result.status).toBe(200);
    expect(calls.map((c) => c.proxyUrl)).toEqual([P1, P2]);
  });

  it("a challenge page reports a ban to the pool, then still surfaces HttpError", async () => {
    // Pool + NO solver: a 503 challenge must reach reportBan (503 is not a
    // ban status — without body inspection it would count as proxy success)
    // and STILL throw the HttpError the caller would have seen.
    const { factory, calls } = recordingFactory((proxyUrl) =>
      proxyUrl === P1
        ? new Response("<html>window._cf_chl_opt = {}</html>", {
            status: 503,
            statusText: "Service Unavailable",
            headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
          })
        : okHtml(),
    );
    const scraper = scraperWithHooks(
      { fetchFactory: factory },
      { proxies: [P1, P2], proxyRotation: "on-ban" },
    );
    const error = await scraper
      .fetchHtml("https://a.example/1", { robots: false, retries: 0 })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(503);
    const result = await scraper.fetchHtml("https://a.example/2", { robots: false, retries: 0 });
    expect(result.status).toBe(200);
    expect(calls.map((c) => c.proxyUrl)).toEqual([P1, P2]);
  });

  it("routes map's robots/sitemap probe through the bound proxy", async () => {
    const { factory, calls } = recordingFactory((_proxyUrl, url) => {
      if (url === "https://example.com/robots.txt") {
        return new Response("User-agent: *\nAllow: /\n", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      if (url === "https://example.com/sitemap.xml") {
        return new Response(
          '<?xml version="1.0" encoding="UTF-8"?>\n' +
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
            "<url><loc>https://example.com/a</loc></url>" +
            "</urlset>",
          { status: 200, headers: { "content-type": "application/xml" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    const scraper = scraperWithHooks({ fetchFactory: factory }, { proxies: [P1] });
    const result = await scraper.map("https://example.com/", { retries: 0 });
    expect(result.source).toBe("sitemap");
    expect(result.urls).toEqual([{ url: "https://example.com/a" }]);
    // Probe robots.txt, the pipeline's own robots gate, then the sitemap —
    // every wire request exits through the bound proxy (no real-IP leak).
    expect(calls.map((c) => c.url)).toEqual([
      "https://example.com/robots.txt",
      "https://example.com/robots.txt",
      "https://example.com/sitemap.xml",
    ]);
    expect(calls.every((c) => c.proxyUrl === P1)).toBe(true);
  });

  it("an instance-level pool keeps per-origin bindings across scraper calls", async () => {
    const { factory, calls } = recordingFactory();
    const scraper = scraperWithHooks({ fetchFactory: factory }, { proxies: [P1, P2] });
    await scraper.fetchHtml("https://a.example/1", { robots: false, retries: 0 });
    await scraper.fetchHtml("https://a.example/2", { robots: false, retries: 0 });
    await scraper.fetchHtml("https://b.example/1", { robots: false, retries: 0 });
    await scraper.fetchHtml("https://a.example/3", { robots: false, retries: 0 });
    // a.example stays bound to P1 across calls; b.example binds to P2.
    expect(calls.map((c) => c.proxyUrl)).toEqual([P1, P1, P2, P1]);
  });
});

describe("fetchHtmlOnce proxy conflict", () => {
  it("rejects a positional fetch impl combined with proxies", async () => {
    const impl: FetchImpl = (async () => okHtml()) as FetchImpl;
    await expect(fetchHtmlOnce("https://example.com/", { proxy: P1 }, impl)).rejects.toBeInstanceOf(
      ConfigError,
    );
    await expect(
      fetchHtmlOnce("https://example.com/", { proxies: [P1] }, impl),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});
