import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { type CaptchaChallenge, ConfigError, createScraper, flareSolverr } from "../src/index.js";

type FetchImpl = typeof globalThis.fetch;

const PROXY = "http://user:pass@1.2.3.4:8080";
const CF_CHALLENGE_HTML =
  '<html><head><script>window._cf_chl_opt = { cvId: "3" };</script></head><body>challenge</body></html>';

function cfChallenge(extra: Partial<CaptchaChallenge> = {}): CaptchaChallenge {
  return {
    url: "https://protected.example/secret",
    type: "cloudflare-interstitial",
    html: CF_CHALLENGE_HTML,
    proxyUrl: PROXY,
    userAgent: "WireUA/1.0",
    ...extra,
  };
}

/**
 * Loopback FlareSolverr: records every (path, JSON body) on POST /v1 and
 * answers through `handler`. `delayMs` holds the reply — the abort test
 * needs a solve still in flight when the caller's signal fires.
 */
async function fakeFlareSolverr(
  handler: (body: Record<string, unknown>) => Record<string, unknown>,
  delayMs = 0,
) {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      const body = JSON.parse(raw === "" ? "{}" : raw) as Record<string, unknown>;
      requests.push({ path: req.url ?? "", body });
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(handler(body)));
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

const OK = {
  status: "ok",
  message: "Challenge solved!",
  solution: {
    url: "https://protected.example/secret",
    status: 200,
    cookies: [
      { name: "cf_clearance", value: "clear-123" },
      { name: "session_id", value: "sess-9" },
    ],
    userAgent: "SolvedUA/9.9",
  },
};

describe("flareSolverr — provider contract", () => {
  it("posts request.get to {endpoint}/v1 with the challenge url and defaults", async () => {
    const server = await fakeFlareSolverr(() => OK);
    try {
      const solver = flareSolverr({ endpoint: server.url });
      const solution = await solver.solve(cfChallenge(), {});
      expect(solution).toEqual({
        cookies: { cf_clearance: "clear-123", session_id: "sess-9" },
        userAgent: "SolvedUA/9.9",
      });
      expect(server.requests).toHaveLength(1);
      const req = server.requests[0];
      expect(req?.path).toBe("/v1");
      expect(req?.body).toEqual({
        cmd: "request.get",
        url: "https://protected.example/secret",
        maxTimeout: 60_000,
        returnOnlyCookies: true,
        proxy: { url: PROXY },
      });
    } finally {
      await server.close();
    }
  });

  it("challenge.proxyUrl wins over options.proxy; options.proxy is the fallback", async () => {
    const server = await fakeFlareSolverr(() => OK);
    try {
      const solver = flareSolverr({ endpoint: server.url, proxy: "http://fallback:1" });
      await solver.solve(cfChallenge({ proxyUrl: "http://challenge:2" }), {});
      await solver.solve(cfChallenge({ proxyUrl: undefined }), {});
      expect(server.requests[0]?.body.proxy).toEqual({ url: "http://challenge:2" });
      expect(server.requests[1]?.body.proxy).toEqual({ url: "http://fallback:1" });
    } finally {
      await server.close();
    }
  });

  it("sends no proxy when neither is known — co-located solves exit the host IP", async () => {
    const server = await fakeFlareSolverr(() => OK);
    try {
      const solver = flareSolverr({ endpoint: server.url });
      await solver.solve(cfChallenge({ proxyUrl: undefined }), {});
      expect(server.requests[0]?.body).not.toHaveProperty("proxy");
    } finally {
      await server.close();
    }
  });

  it("honors maxTimeoutMs as flaresolverr's maxTimeout", async () => {
    const server = await fakeFlareSolverr(() => OK);
    try {
      const solver = flareSolverr({ endpoint: server.url, maxTimeoutMs: 5_000 });
      await solver.solve(cfChallenge(), {});
      expect(server.requests[0]?.body.maxTimeout).toBe(5_000);
    } finally {
      await server.close();
    }
  });

  it("passes session through verbatim", async () => {
    const server = await fakeFlareSolverr(() => OK);
    try {
      const solver = flareSolverr({ endpoint: server.url, session: "sess-abc" });
      await solver.solve(cfChallenge(), {});
      expect(server.requests[0]?.body.session).toBe("sess-abc");
    } finally {
      await server.close();
    }
  });

  it("status error rejects with the provider message", async () => {
    const server = await fakeFlareSolverr(() => ({
      status: "error",
      message: "Error solving the challenge. Timeout reached.",
    }));
    try {
      const solver = flareSolverr({ endpoint: server.url });
      const err = await solver.solve(cfChallenge(), {}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("Timeout reached");
    } finally {
      await server.close();
    }
  });

  it("drops cookie entries missing a string name or value", async () => {
    const server = await fakeFlareSolverr(() => ({
      status: "ok",
      message: "Challenge not detected!",
      solution: {
        cookies: [
          { name: "cf_clearance", value: "clear-1" },
          { value: "nameless" },
          { name: "valueless" },
          "not-an-object",
        ],
        userAgent: "SolvedUA/9.9",
      },
    }));
    try {
      const solver = flareSolverr({ endpoint: server.url });
      const solution = await solver.solve(cfChallenge(), {});
      expect(solution.cookies).toEqual({ cf_clearance: "clear-1" });
      expect(solution.userAgent).toBe("SolvedUA/9.9");
    } finally {
      await server.close();
    }
  });

  it("honors a caller abort mid-request", async () => {
    const server = await fakeFlareSolverr(() => OK, 200);
    try {
      const solver = flareSolverr({ endpoint: server.url });
      const controller = new AbortController();
      const pending = solver.solve(cfChallenge(), { signal: controller.signal });
      setTimeout(() => controller.abort(), 20);
      const err = await pending.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DOMException);
      expect((err as DOMException).name).toBe("AbortError");
    } finally {
      await server.close();
    }
  });

  it("rejects widget-type challenges without spending a request", async () => {
    const server = await fakeFlareSolverr(() => OK);
    try {
      const solver = flareSolverr({ endpoint: server.url });
      for (const type of ["turnstile", "recaptcha", "hcaptcha"] as const) {
        const err = await solver.solve(cfChallenge({ type }), {}).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain("cloudflare-interstitial");
      }
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("rejects a non-positive maxTimeoutMs at construction", () => {
    expect(() => flareSolverr({ maxTimeoutMs: 0 })).toThrow(ConfigError);
    expect(() => flareSolverr({ maxTimeoutMs: -1 })).toThrow(ConfigError);
  });

  it("rejects a malformed endpoint at construction", () => {
    expect(() => flareSolverr({ endpoint: "not a url" })).toThrow(ConfigError);
  });
});

describe("flareSolverr — scraper integration", () => {
  const cloudflarePage = () =>
    new Response(CF_CHALLENGE_HTML, {
      status: 403,
      headers: { "content-type": "text/html; charset=utf-8", "cf-mitigated": "challenge" },
    });
  const okHtml = (body = "<html><h1>unlocked</h1></html>") =>
    new Response(body, { status: 200, headers: { "content-type": "text/html" } });

  it("end-to-end: CF interstitial → solve → cf_clearance retry returns the page", async () => {
    const server = await fakeFlareSolverr(() => OK);
    const targetCalls: Array<{ url: string; headers: Headers }> = [];
    const targetFetch: FetchImpl = (async (input: unknown, init?: RequestInit) => {
      targetCalls.push({ url: String(input), headers: new Headers(init?.headers) });
      return targetCalls.length === 1 ? cloudflarePage() : okHtml();
    }) as FetchImpl;
    try {
      const scraper = createScraper({
        fetch: targetFetch,
        robots: false,
        retries: 0,
        solver: flareSolverr({ endpoint: server.url }),
      });
      const page = await scraper.scrape("https://protected.example/secret", { title: "h1" });
      expect(page.title).toBe("unlocked");
      // Direct request, no proxy anywhere → no proxy key on the wire.
      expect(server.requests[0]?.body).not.toHaveProperty("proxy");
      // The retry carries the clearance AND the UA it is bound to.
      expect(targetCalls).toHaveLength(2);
      expect(targetCalls[1]?.headers.get("cookie")).toContain("cf_clearance=clear-123");
      expect(targetCalls[1]?.headers.get("cookie")).toContain("session_id=sess-9");
      expect(targetCalls[1]?.headers.get("user-agent")).toBe("SolvedUA/9.9");
    } finally {
      await server.close();
    }
  });
});
