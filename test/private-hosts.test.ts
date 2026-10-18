/**
 * `blockPrivateHosts` coverage — the opt-in SSRF guard. Mixes injected
 * fetch/lookup seams (deterministic, no DNS dependence) with real loopback
 * `node:http` servers (the same convention as redirect.test.ts), and pins
 * the critical default: UNSET, private targets must keep working — the
 * whole suite scrapes loopback servers.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  BlockedHostError,
  ConfigError,
  createScraper,
  FetchError,
  type FetchHtmlOptions,
  fetchHtmlOnce,
  type Renderer,
  type ScraperOptions,
} from "../src/index.js";
import { assertPublicHost, isPrivateAddress } from "../src/private-hosts.js";
import { fetchRobotsTxtResult } from "../src/robots.js";

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };
type FetchImpl = typeof globalThis.fetch;
type HostLookup = (hostname: string) => Promise<readonly string[]>;

/** The internal DNS seam — not public API, set via a cast like `__proxyPool`. */
const withLookup = (lookup: HostLookup): FetchHtmlOptions =>
  ({ __dnsLookup: lookup }) as FetchHtmlOptions;

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

/** Start a loopback server; resolves its port. */
async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return (server.address() as AddressInfo).port;
}

describe("blockPrivateHosts — IP literals", () => {
  const PRIVATE_LITERALS = [
    "http://127.0.0.1/x",
    "http://[::1]/x",
    "http://169.254.169.254/x",
    "http://10.0.0.4/x",
    "http://172.16.5.5/x",
    "http://192.168.1.1/x",
    "http://100.64.0.1/x",
    "http://0.0.0.0/x",
    "http://[fe80::1]/x",
    "http://[fd00::1]/x",
    "http://[::ffff:10.0.0.1]/x",
  ];

  it("refuses private/reserved literals before any fetch fires", async () => {
    const calls: string[] = [];
    const impl = (async (input: unknown) => {
      calls.push(String(input));
      return new Response("<html></html>", { headers: HTML_HEADERS });
    }) as FetchImpl;
    for (const url of PRIVATE_LITERALS) {
      const err = await fetchHtmlOnce(url, {
        blockPrivateHosts: true,
        fetch: impl,
      }).catch((e: unknown) => e);
      expect(err, url).toBeInstanceOf(BlockedHostError);
      expect((err as BlockedHostError).code, url).toBe("blocked-host");
      expect((err as BlockedHostError).retryable, url).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("fetches the same literals when the option is off", async () => {
    const impl = (async () => new Response("<h1>ok</h1>", { headers: HTML_HEADERS })) as FetchImpl;
    for (const url of PRIVATE_LITERALS) {
      const result = await fetchHtmlOnce(url, { fetch: impl });
      expect(result.status, url).toBe(200);
    }
  });

  it("allows public IP literals", async () => {
    const calls: string[] = [];
    const impl = (async (input: unknown) => {
      calls.push(String(input));
      return new Response("<h1>ok</h1>", { headers: HTML_HEADERS });
    }) as FetchImpl;
    for (const url of ["http://8.8.8.8/x", "http://[2606:4700:4700::1111]/x"]) {
      const result = await fetchHtmlOnce(url, { blockPrivateHosts: true, fetch: impl });
      expect(result.status, url).toBe(200);
    }
    expect(calls).toHaveLength(2);
  });
});

describe("blockPrivateHosts — DNS-resolved hosts", () => {
  it("refuses a hostname resolving to a private address (injected lookup)", async () => {
    const calls: string[] = [];
    const impl = (async (input: unknown) => {
      calls.push(String(input));
      return new Response("<h1>ok</h1>", { headers: HTML_HEADERS });
    }) as FetchImpl;
    const err = await fetchHtmlOnce("http://internal.example/x", {
      blockPrivateHosts: true,
      fetch: impl,
      ...withLookup(async (hostname) => (hostname === "internal.example" ? ["10.9.9.9"] : [])),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlockedHostError);
    expect((err as BlockedHostError).address).toBe("10.9.9.9");
    expect(calls).toEqual([]);
  });

  it("blocks when ANY resolved address is private", async () => {
    const impl = (async () => new Response("<h1>ok</h1>", { headers: HTML_HEADERS })) as FetchImpl;
    const err = await fetchHtmlOnce("http://multi.example/", {
      blockPrivateHosts: true,
      fetch: impl,
      // A public A record alongside a private AAAA — the connect could pick either.
      ...withLookup(async () => ["93.184.216.34", "fd00::5"]),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlockedHostError);
    expect((err as BlockedHostError).address).toBe("fd00::5");
  });

  it("allows a hostname resolving only to public addresses", async () => {
    const impl = (async () => new Response("<h1>ok</h1>", { headers: HTML_HEADERS })) as FetchImpl;
    const result = await fetchHtmlOnce("http://public.example/", {
      blockPrivateHosts: true,
      fetch: impl,
      ...withLookup(async () => ["93.184.216.34", "2606:4700:4700::1111"]),
    });
    expect(result.status).toBe(200);
  });

  it("surfaces a DNS failure as a retryable FetchError", async () => {
    const impl = (async () => new Response("<h1>ok</h1>", { headers: HTML_HEADERS })) as FetchImpl;
    const err = await fetchHtmlOnce("http://gone.example/", {
      blockPrivateHosts: true,
      fetch: impl,
      ...withLookup(async () => {
        throw new Error("ENOTFOUND");
      }),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect((err as FetchError).retryable).not.toBe(false);
  });
});

describe("blockPrivateHosts — redirect hops", () => {
  it("refuses a redirect whose target is a private literal", async () => {
    const seen: string[] = [];
    const impl = (async (input: unknown) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("/start")) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        });
      }
      return new Response("<h1>landed</h1>", { headers: HTML_HEADERS });
    }) as FetchImpl;
    const err = await fetchHtmlOnce("http://public.example/start", {
      blockPrivateHosts: true,
      fetch: impl,
      ...withLookup(async () => ["93.184.216.34"]),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlockedHostError);
    // Only the first hop fired — the private target was never requested.
    expect(seen).toEqual(["http://public.example/start"]);
  });

  it("refuses a redirect hop whose hostname resolves private", async () => {
    const seen: string[] = [];
    const impl = (async (input: unknown) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("/start")) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://metadata.example/secret" },
        });
      }
      return new Response("<h1>landed</h1>", { headers: HTML_HEADERS });
    }) as FetchImpl;
    const err = await fetchHtmlOnce("http://public.example/start", {
      blockPrivateHosts: true,
      fetch: impl,
      ...withLookup(async (hostname) =>
        hostname === "metadata.example" ? ["169.254.169.254"] : ["93.184.216.34"],
      ),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlockedHostError);
    expect(seen).toEqual(["http://public.example/start"]);
  });
});

describe("blockPrivateHosts — scraper level and loopback defaults", () => {
  it("blocks a loopback target before any request fires — including the robots.txt probe", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, HTML_HEADERS).end("<h1>loopback</h1>");
    });
    const calls: string[] = [];
    const impl = (async (input: unknown) => {
      calls.push(String(input));
      return new Response("<h1>x</h1>", { headers: HTML_HEADERS });
    }) as FetchImpl;
    // robots left ON: the probe itself must be gated too — nothing at all
    // should be requested from a private host.
    const scraper = createScraper({ blockPrivateHosts: true, fetch: impl });
    const err = await scraper.fetchHtml(`http://127.0.0.1:${port}/page`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlockedHostError);
    expect(calls).toEqual([]);
  });

  it("allows the same loopback server when the option is unset", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, HTML_HEADERS).end("<h1>loopback</h1>");
    });
    const scraper = createScraper({ robots: false });
    const result = await scraper.fetchHtml(`http://127.0.0.1:${port}/page`);
    expect(result.status).toBe(200);
    expect(result.html).toContain("loopback");
  });

  it("blocks a localhost hostname when true", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, HTML_HEADERS).end("<h1>loopback</h1>");
    });
    const scraper = createScraper({ robots: false, blockPrivateHosts: true, retries: 0 });
    const err = await scraper.fetchHtml(`http://localhost:${port}/page`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlockedHostError);
  });

  it("honours a per-call override and the instance DNS seam", async () => {
    const calls: string[] = [];
    const impl = (async (input: unknown) => {
      calls.push(String(input));
      return new Response("<h1>ok</h1>", { headers: HTML_HEADERS });
    }) as FetchImpl;
    const scraper = createScraper({
      robots: false,
      fetch: impl,
      __dnsLookup: async (hostname: string) =>
        hostname === "internal.example" ? ["10.9.9.9"] : ["93.184.216.34"],
    } as ScraperOptions);
    // Instance default off → private-resolving host is allowed through.
    const allowed = await scraper.fetchHtml("http://internal.example/x");
    expect(allowed.status).toBe(200);
    // Per-call opt-in → the same URL is refused via the injected lookup.
    const err = await scraper
      .fetchHtml("http://internal.example/x", { blockPrivateHosts: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlockedHostError);
    expect(calls).toEqual(["http://internal.example/x"]);
  });

  it("rejects a non-boolean blockPrivateHosts rather than silently disabling", async () => {
    const impl = (async () => new Response("<h1>ok</h1>", { headers: HTML_HEADERS })) as FetchImpl;
    const err = await fetchHtmlOnce("http://example.com/", {
      fetch: impl,
      blockPrivateHosts: 1 as unknown as boolean,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    const scraperErr = await createScraper({ robots: false, fetch: impl })
      .fetchHtml("http://example.com/", {
        blockPrivateHosts: "yes" as unknown as boolean,
      })
      .catch((e: unknown) => e);
    expect(scraperErr).toBeInstanceOf(ConfigError);
  });
});

describe("isPrivateAddress — range table", () => {
  it("blocks the documented IPv4 ranges", () => {
    for (const address of [
      "0.0.0.0",
      "0.255.255.255",
      "10.0.0.0",
      "10.255.255.255",
      "100.64.0.0",
      "100.127.255.255",
      "127.0.0.1",
      "127.255.0.1",
      "169.254.0.1",
      "169.254.169.254",
      "172.16.0.0",
      "172.31.255.255",
      "192.0.0.10", // 192.0.0.0/24 IETF protocol assignments
      "192.0.2.1", // TEST-NET-1
      "192.168.0.0",
      "192.168.255.255",
      "198.51.100.7", // TEST-NET-2
      "203.0.113.9", // TEST-NET-3
      "198.18.0.0",
      "198.19.255.255",
      "224.0.0.1",
      "239.255.255.255",
      "240.0.0.0",
      "255.255.255.255",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("allows public IPv4 just outside the private ranges", () => {
    for (const address of [
      "9.255.255.255",
      "11.0.0.0",
      "100.63.255.255",
      "100.128.0.0",
      "126.255.255.255",
      "128.0.0.0",
      "169.253.255.255",
      "169.255.0.0",
      "172.15.255.255",
      "172.32.0.0",
      "192.167.255.255",
      "192.169.0.0",
      "223.255.255.255",
      "8.8.8.8",
      "93.184.216.34",
    ]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("classifies IPv6 ranges and embedded-IPv4 forms", () => {
    const blocked = [
      "::",
      "::1",
      "fe80::1",
      "febf::ffff",
      "fc00::1",
      "fdff::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:a9fe:a9fe",
      "::ffff:7f00:1",
      "2002:0a00:1::", // 6to4 of 10.0.0.1
      "fe80::1%eth0", // zone id
      "::127.0.0.1", // `::`-compatible with a dotted-quad tail
      "::10.0.0.1",
      "64:ff9b::7f00:1", // NAT64 well-known of 127.0.0.1
      "64:ff9b::a00:5", // NAT64 well-known of 10.0.0.5
      "64:ff9b:1:0:7f00:1::", // RFC 8215 local-use NAT64 of 127.0.0.1
      // Mapped dotted tails — the v4 tail must land in bits 0-31, not be
      // OR'd into the parsed groups (regression: these doc-range tails
      // miscomputed and were ALLOWED).
      "::ffff:192.0.2.1", // mapped TEST-NET-1
      "::ffff:203.0.113.5", // mapped TEST-NET-3
      "::ffff:198.51.100.1", // mapped TEST-NET-2
      "::ffff:192.0.0.170", // mapped IETF protocol assignments
      "0:0:0:0:0:ffff:10.0.0.1", // uncompressed mapped form, dotted tail
      "2002:0a00:1::1.2.3.4", // 6to4 of 10.0.0.1 carrying a v4 tail too
    ];
    const allowed = [
      "::ffff:0808:0808", // mapped 8.8.8.8
      "::ffff:8.8.8.8",
      "2606:4700:4700::1111",
      "2001:db8::1",
      "fec0::1", // just outside fe80::/10
      "2002:0808:0808::", // 6to4 of public 8.8.8.8
      "64:ff9b::808:808", // NAT64 well-known of public 8.8.8.8
      "1::1.2.3.4", // `::` mid-address with a dotted-quad tail — public
      "::ffff:93.184.216.34", // mapped public address stays allowed
    ];
    for (const address of blocked) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of allowed) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("returns false for hostnames — it classifies addresses, not names", () => {
    for (const name of ["localhost", "example.com", "internal.lan", "not-an-ip"]) {
      expect(isPrivateAddress(name), name).toBe(false);
    }
  });
});

describe("assertPublicHost — fail-closed resolver answers", () => {
  it("refuses a hostname whose lookup answers a non-IP value", async () => {
    const err = await assertPublicHost("http://internal.example/x", async () => [
      "bogus-answer",
    ]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlockedHostError);
    expect((err as BlockedHostError).address).toBe("bogus-answer");
  });
});

describe("blockPrivateHosts — robots.txt probe redirects", () => {
  it("treats a probe redirect to a private literal as a failed fetch", async () => {
    const impl = (async (input: unknown) => {
      const url = String(input);
      if (url === "http://public.example/robots.txt") {
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/robots.txt" },
        });
      }
      // Should never be reached — the private hop is refused first.
      return new Response("User-agent: *\nAllow: /\n", {
        headers: { "content-type": "text/plain" },
      });
    }) as FetchImpl;
    const result = await fetchRobotsTxtResult("http://public.example/robots.txt", {
      fetch: impl,
      blockPrivateHosts: true,
      __dnsLookup: async () => ["93.184.216.34"],
    });
    expect(result.kind).toBe("failed");
  });

  it("follows a probe redirect to a public literal and parses the file", async () => {
    const impl = (async (input: unknown) => {
      const url = String(input);
      if (url === "http://public.example/robots.txt") {
        return new Response(null, {
          status: 302,
          headers: { location: "http://93.184.216.34/robots.txt" },
        });
      }
      return new Response("User-agent: *\nDisallow: /private\n", {
        headers: { "content-type": "text/plain" },
      });
    }) as FetchImpl;
    const result = await fetchRobotsTxtResult("http://public.example/robots.txt", {
      fetch: impl,
      blockPrivateHosts: true,
      __dnsLookup: async () => ["93.184.216.34"],
    });
    expect(result.kind).toBe("agent");
    if (result.kind === "agent") {
      // The agent is bound to the LANDING origin — robots.txt only governs
      // the origin it was fetched from (the parser answers true cross-origin).
      expect(result.agent.isAllowed("http://93.184.216.34/private", "*")).toBe(false);
      expect(result.agent.isAllowed("http://93.184.216.34/public", "*")).toBe(true);
    }
  });
});

describe("blockPrivateHosts — render guard", () => {
  it("refuses a private render target before the renderer fires", async () => {
    let renders = 0;
    const renderer: Renderer = {
      render: async (url) => {
        renders += 1;
        return { url, status: 200, html: "<html/>" };
      },
    };
    const impl = (async () => new Response("<html/>", { headers: HTML_HEADERS })) as FetchImpl;
    const scraper = createScraper({
      robots: false,
      fetch: impl,
      blockPrivateHosts: true,
      renderMode: "always",
      render: renderer,
    });
    const err = await scraper.fetchHtml("http://127.0.0.1/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlockedHostError);
    // In `always` mode the static fetch never runs — the renderer was the
    // only path, and it must not have been invoked either.
    expect(renders).toBe(0);
  });
});

describe("blockPrivateHosts — response.url recheck", () => {
  it("refuses a response whose reported URL is a private literal", async () => {
    // A custom impl that followed redirects internally lands on a URL the
    // per-hop loop never vetted — reported through `response.url`.
    let cancelled = false;
    const bodyStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("<html/>"));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const impl = (async () => {
      const response = new Response(bodyStream, { headers: HTML_HEADERS });
      Object.defineProperty(response, "url", { value: "http://127.0.0.1/" });
      return response;
    }) as FetchImpl;
    const err = await fetchHtmlOnce("http://8.8.8.8/", {
      blockPrivateHosts: true,
      fetch: impl,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlockedHostError);
    // The refusal must release the response's connection — the body is
    // cancelled before the error propagates.
    expect(cancelled).toBe(true);
  });
});

describe("blockPrivateHosts — map option validation", () => {
  it("rejects a non-boolean blockPrivateHosts before any probe fires", async () => {
    const calls: string[] = [];
    const impl = (async (input: unknown) => {
      calls.push(String(input));
      return new Response("User-agent: *\nAllow: /\n", {
        headers: { "content-type": "text/plain" },
      });
    }) as FetchImpl;
    // map's own robots.txt probe bypasses fetchHtmlImpl's validation — the
    // map handler must reject a truthy non-boolean itself rather than fire
    // an unguarded probe.
    const scraper = createScraper({ fetch: impl });
    const err = await scraper
      .map("http://example.com/", { blockPrivateHosts: 1 as never })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(calls).toEqual([]);
  });
});
