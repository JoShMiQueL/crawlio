/**
 * Redirect handling + URL-scheme allowlist coverage — real loopback
 * `node:http` servers (the same convention as mcp-bin.test.ts and
 * proxy.test.ts), so the `redirect: "manual"` hop chain in fetchHtmlOnce
 * exercises the runtime's REAL fetch under both `vitest` (undici on Node)
 * and `bun test`.
 */
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  createScraper,
  FetchError,
  fetchHtmlOnce,
  RobotsError,
  scrape,
} from "../src/index.js";

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Force-close keep-alive sockets so the test file exits promptly.
      server.closeAllConnections();
    });
  }
});

/** Start a loopback server; resolves its `http://127.0.0.1:<port>` base. */
async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("URL scheme allowlist", () => {
  it("rejects file:, data: and ftp: before any fetch fires", async () => {
    const calls: string[] = [];
    const impl = (async (input: unknown) => {
      calls.push(String(input));
      return new Response("<html></html>", { headers: HTML_HEADERS });
    }) as typeof globalThis.fetch;
    const scraper = createScraper({ fetch: impl, robots: false });
    for (const url of ["file:///etc/passwd", "data:text/html,<h1>x</h1>", "ftp://example.com/x"]) {
      const err = await scraper.scrape(url, { title: "h1" }).catch((e: unknown) => e);
      expect(err, url).toBeInstanceOf(ConfigError);
    }
    expect(calls).toEqual([]);
  });

  it("rejects non-http(s) on the module-level scrape and on fetchHtmlOnce", async () => {
    const err = await scrape("data:text/html,<h1>x</h1>", { title: "h1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    await expect(fetchHtmlOnce("file:///etc/hostname")).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("manual redirect chain", () => {
  it("strips credential headers on a cross-origin redirect", async () => {
    let landed: IncomingHttpHeaders | undefined;
    const baseB = await listen((req, res) => {
      landed = req.headers;
      res.writeHead(200, HTML_HEADERS).end("<h1>B</h1>");
    });
    const baseA = await listen((_req, res) => {
      // A cross-origin redirect that also tries to plant a cookie.
      res.writeHead(302, { location: `${baseB}/land`, "set-cookie": "s=1" }).end();
    });
    const scraper = createScraper({ robots: false });
    const result = await scraper.fetchHtml(`${baseA}/start`, {
      headers: {
        cookie: "session=abc",
        referer: "https://a.example/previous",
        origin: "https://a.example",
        authorization: "Bearer hunter2",
        "proxy-authorization": "Basic aaa",
        "sec-fetch-site": "same-origin",
        "x-keep": "yes",
      },
    });
    expect(result.status).toBe(200);
    // The landing URL is the one the manual chain tracked.
    expect(result.url).toBe(`${baseB}/land`);
    expect(landed?.cookie).toBeUndefined();
    expect(landed?.referer).toBeUndefined();
    expect(landed?.origin).toBeUndefined();
    expect(landed?.authorization).toBeUndefined();
    expect(landed?.["proxy-authorization"]).toBeUndefined();
    expect(landed?.["sec-fetch-site"]).toBeUndefined();
    // Non-sensitive headers and the honest UA still ride along.
    expect(landed?.["x-keep"]).toBe("yes");
    expect(String(landed?.["user-agent"])).toContain("crawlio/");
  });

  it("keeps caller headers on a same-origin redirect", async () => {
    let landed: IncomingHttpHeaders | undefined;
    const base = await listen((req, res) => {
      if (req.url === "/start") {
        res.writeHead(301, { location: "/final" }).end();
        return;
      }
      landed = req.headers;
      res.writeHead(200, HTML_HEADERS).end("<h1>ok</h1>");
    });
    const scraper = createScraper({ robots: false });
    const result = await scraper.fetchHtml(`${base}/start`, { headers: { cookie: "a=b" } });
    expect(result.url).toBe(`${base}/final`);
    expect(landed?.cookie).toBe("a=b");
  });

  it("refuses a redirect whose target is not http(s)", async () => {
    for (const location of ["data:text/html,<h1>evil</h1>", "file:///etc/passwd", "ftp://x/"]) {
      const base = await listen((_req, res) => {
        res.writeHead(302, { location }).end();
      });
      const scraper = createScraper({ robots: false, retries: 0 });
      const err = await scraper.fetchHtml(`${base}/start`).catch((e: unknown) => e);
      expect(err, location).toBeInstanceOf(FetchError);
    }
  });

  it("bounds a redirect loop instead of following forever", async () => {
    let hops = 0;
    const base = await listen((_req, res) => {
      hops += 1;
      res.writeHead(302, { location: "/loop" }).end();
    });
    const scraper = createScraper({ robots: false, retries: 0 });
    const err = await scraper.fetchHtml(`${base}/loop`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as Error).message).toMatch(/redirect/i);
    // 1 initial request + 20 follows — the 21st redirect is refused.
    expect(hops).toBe(21);
  });

  it("re-checks robots.txt when the redirect lands on a different origin", async () => {
    const baseB = await listen((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow: /\n");
        return;
      }
      res.writeHead(200, HTML_HEADERS).end("<h1>B</h1>");
    });
    const baseA = await listen((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(302, { location: `${baseB}/land` }).end();
    });
    const scraper = createScraper();
    const err = await scraper.fetchHtml(`${baseA}/start`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RobotsError);
  });

  it("accepts the landing when its origin's robots.txt allows", async () => {
    const baseB = await listen((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(200, HTML_HEADERS).end("<h1>B</h1>");
    });
    const baseA = await listen((req, res) => {
      if (req.url === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n");
        return;
      }
      res.writeHead(302, { location: `${baseB}/land` }).end();
    });
    const scraper = createScraper();
    const result = await scraper.fetchHtml(`${baseA}/start`);
    expect(result.status).toBe(200);
    expect(result.url).toBe(`${baseB}/land`);
  });

  it("applies the caller's abort signal across redirect hops", async () => {
    const baseB = await listen((_req, _res) => {
      // Deliberately never responds — the abort must fire mid-hop.
    });
    const baseA = await listen((_req, res) => {
      res.writeHead(302, { location: `${baseB}/hang` }).end();
    });
    const controller = new AbortController();
    const scraper = createScraper({ robots: false, retries: 0 });
    const pending = scraper
      .fetchHtml(`${baseA}/start`, { signal: controller.signal })
      .catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 60));
    controller.abort();
    const err = await pending;
    expect(err).toBeInstanceOf(FetchError);
  });
});
