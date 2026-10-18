import type { ProxyAgent } from "undici";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  createScraper,
  FetchError,
  fetchHtml,
  fetchHtmlOnce,
  HttpError,
  isBun,
  type ProxyFetchFactory,
  ProxyPool,
  type ProxyPoolOptions,
  type ScraperOptions,
  TimeoutError,
} from "../src/index.js";
import { defaultFetch, proxyRequestInit } from "../src/proxy.js";

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

describe("proxy credential hygiene", () => {
  it("a dead-proxy transport failure never surfaces the credentialed URL", async () => {
    // Port 1 refuses connections instantly — a deterministic transport
    // failure through the REAL proxy machinery (undici's dispatcher on
    // Node, the native `proxy` option on Bun), no factory stub.
    // fetchHtmlOnce stores the runtime error verbatim as FetchError.cause,
    // so this pins that neither lane's error embeds the credentialed proxy
    // URL anywhere in the chain. Probed on Bun 1.4.0 ("Unable to connect…"
    // / "getaddrinfo ENOTFOUND <host>" — host only) and undici ("fetch
    // failed" / "connect ECONNREFUSED <host>:<port>").
    const error: unknown = await fetchHtmlOnce("http://example.com/", {
      proxy: "http://s3cret-user:p@ssw0rd@127.0.0.1:1",
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(FetchError);
    const messages: string[] = [];
    for (let current = error; current instanceof Error; current = current.cause) {
      messages.push(current.message);
    }
    for (const message of messages) {
      expect(message).not.toContain("s3cret-user");
      expect(message).not.toContain("p@ssw0rd");
    }
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

  it("a 200-served Amazon Robot Check wall reports a ban and rebinds", async () => {
    // amazon-robot-check arrives at status 200 — without the type check the
    // wall would count as proxy success and the burned egress kept.
    const { factory, calls } = recordingFactory((proxyUrl) =>
      proxyUrl === P1
        ? new Response(
            '<html><head><title>Robot Check</title></head><body><form action="/errors/validateCaptcha"></form></body></html>',
            { status: 200, headers: { "content-type": "text/html" } },
          )
        : okHtml(),
    );
    const scraper = scraperWithHooks(
      { fetchFactory: factory },
      { proxies: [P1, P2], proxyRotation: "on-ban" },
    );
    // No solver — the wall is still served to the caller (it IS the 200
    // body), but the pool must mark P1 burned and rebind the origin.
    const first = await scraper.fetchHtml("https://a.example/1", { robots: false, retries: 0 });
    expect(first.status).toBe(200);
    const result = await scraper.fetchHtml("https://a.example/2", { robots: false, retries: 0 });
    expect(result.status).toBe(200);
    expect(calls.map((c) => c.proxyUrl)).toEqual([P1, P2]);
  });

  it("a 200-served generic bot-check wall reports a ban and rebinds", async () => {
    // generic-bot-check joins the page-block set: an unbranded sparse wall
    // (challenge artifact + no real content) is burned egress, same as the
    // named vendor walls.
    const { factory, calls } = recordingFactory((proxyUrl) =>
      proxyUrl === P1
        ? new Response(
            '<html><body><p>Are you a robot?</p><form action="/wall/verify"></form></body></html>',
            { status: 200, headers: { "content-type": "text/html" } },
          )
        : okHtml(),
    );
    const scraper = scraperWithHooks(
      { fetchFactory: factory },
      { proxies: [P1, P2], proxyRotation: "on-ban" },
    );
    const first = await scraper.fetchHtml("https://a.example/1", { robots: false, retries: 0 });
    expect(first.status).toBe(200);
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

describe("runtime proxy seam (proxyRequestInit)", () => {
  /** Dispatcher stand-in — a real ProxyAgent is never constructed here. */
  const dispatcher = { close: async () => {} } as unknown as ProxyAgent;

  it("Node lane attaches the undici dispatcher and no `proxy` key", () => {
    const init = proxyRequestInit({ headers: { "x-a": "1" } }, P1, {
      bun: false,
      dispatcher,
    }) as Record<string, unknown>;
    expect(init.dispatcher).toBe(dispatcher);
    expect("proxy" in init).toBe(false);
    // Existing init fields survive the extension.
    expect(init.headers).toEqual({ "x-a": "1" });
  });

  it("Bun lane attaches the native `proxy` URL string and no dispatcher", () => {
    const init = proxyRequestInit(undefined, P1, { bun: true, dispatcher }) as Record<
      string,
      unknown
    >;
    expect(init.proxy).toBe(P1);
    expect("dispatcher" in init).toBe(false);
  });

  it("the default lane follows the runtime", () => {
    const init = proxyRequestInit(undefined, P1, { dispatcher }) as Record<string, unknown>;
    if (isBun) {
      expect(init.proxy).toBe(P1);
      expect("dispatcher" in init).toBe(false);
    } else {
      expect(init.dispatcher).toBe(dispatcher);
      expect("proxy" in init).toBe(false);
    }
  });

  it("Bun lane pins `proxy: false` for an UNCONFIGURED request (env-proxy immunity)", () => {
    const init = proxyRequestInit({ headers: { "x-a": "1" } }, null, { bun: true }) as Record<
      string,
      unknown
    >;
    expect(init.proxy).toBe(false);
    expect("dispatcher" in init).toBe(false);
    expect(init.headers).toEqual({ "x-a": "1" });
  });

  it("Node lane attaches nothing for an unconfigured request", () => {
    const init = proxyRequestInit({ headers: { "x-a": "1" } }, null, {
      bun: false,
      dispatcher,
    }) as Record<string, unknown>;
    expect("proxy" in init).toBe(false);
    // No dispatcher either — there is no proxy to route through.
    expect("dispatcher" in init).toBe(false);
    expect(init.headers).toEqual({ "x-a": "1" });
  });

  it("defaultFetch resolves globalThis.fetch per call — post-import patching still intercepts", async () => {
    // Pinning both lanes without network: a stub swapped in AFTER module
    // load must still serve the call, and only the Bun lane may carry the
    // `proxy` init key.
    const inits: Array<RequestInit | undefined> = [];
    const stub = (async (_input: unknown, init?: RequestInit) => {
      inits.push(init);
      return new Response("ok");
    }) as FetchImpl;
    const saved = globalThis.fetch;
    globalThis.fetch = stub;
    try {
      const res = await defaultFetch("https://example.com/");
      expect(res.status).toBe(200);
    } finally {
      globalThis.fetch = saved;
    }
    expect(inits).toHaveLength(1);
    const init = inits[0] as Record<string, unknown> | undefined;
    if (isBun) {
      expect(init?.proxy).toBe(false);
    } else {
      expect(init === undefined || !("proxy" in init)).toBe(true);
    }
  });

  // Real behavioural pin — only meaningful on the runtime whose fetch reads
  // the env vars. Bun.serve provides the loopback target; a dead env proxy
  // proves the pin: without `proxy: false` the request would CONNECT to
  // 127.0.0.1:1 and fail.
  (isBun ? it : it.skip)("defaultFetch ignores HTTP_PROXY/NO_PROXY env vars", async () => {
    const savedHttp = process.env.HTTP_PROXY;
    const savedHttpLower = process.env.http_proxy;
    const savedNoProxy = process.env.NO_PROXY;
    const savedNoProxyLower = process.env.no_proxy;
    process.env.HTTP_PROXY = "http://127.0.0.1:1"; // dead proxy
    process.env.http_proxy = "http://127.0.0.1:1";
    process.env.NO_PROXY = ""; // no localhost exemption
    process.env.no_proxy = "";
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("ok"),
    });
    try {
      const res = await defaultFetch(`http://127.0.0.1:${server.port}/`);
      expect(res.status).toBe(200);
      // Sanity: the env proxy really would have routed a plain fetch.
      await expect(fetch(`http://127.0.0.1:${server.port}/`)).rejects.toThrow();
    } finally {
      await server.stop(true);
      if (savedHttp === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = savedHttp;
      if (savedHttpLower === undefined) delete process.env.http_proxy;
      else process.env.http_proxy = savedHttpLower;
      if (savedNoProxy === undefined) delete process.env.NO_PROXY;
      else process.env.NO_PROXY = savedNoProxy;
      if (savedNoProxyLower === undefined) delete process.env.no_proxy;
      else process.env.no_proxy = savedNoProxyLower;
    }
  });
});

describe("Bun.FetchSession ambient declaration", () => {
  // `Bun.FetchSession` exists only in src/runtime.ts's ambient declaration —
  // nothing else validates it against the real runtime API. These run on the
  // Bun lanes (`bun test`, `bun run test`) and skip under Node.
  (isBun ? it : it.skip)(
    "is a real constructable session whose proxy binding connects",
    async () => {
      expect(typeof Bun.FetchSession).toBe("function");
      // A dead loopback proxy: if the session honours its `proxy` option the
      // fetch fails trying to CONNECT through it — a connect attempt, not a
      // silent direct request.
      const session = new Bun.FetchSession({ proxy: "http://127.0.0.1:1" });
      try {
        await expect(session.fetch("http://127.0.0.1:9/")).rejects.toThrow();
      } finally {
        session.close();
      }
    },
  );
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
