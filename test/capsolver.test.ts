import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CaptchaChallenge,
  type CaptchaSolver,
  ConfigError,
  capSolver,
  createScraper,
  type ProxyFetchFactory,
  type ScraperOptions,
  TimeoutError,
} from "../src/index.js";

type FetchImpl = typeof globalThis.fetch;

const KEY = "test-capsolver-key";
const PROXY = "http://user:pass@1.2.3.4:8080";
const CF_CHALLENGE_HTML =
  '<html><head><script>window._cf_chl_opt = { cvId: "3" };</script></head><body>challenge</body></html>';

// The env fallback must never be polluted by a developer's real key.
const savedKey = process.env.CAPSOLVER_API_KEY;
afterEach(() => {
  if (savedKey === undefined) delete process.env.CAPSOLVER_API_KEY;
  else process.env.CAPSOLVER_API_KEY = savedKey;
});

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
 * Loopback CapSolver: records every (path, JSON body) and answers through
 * `handler`, keyed by request ordinal so poll sequences are scriptable.
 */
async function fakeCapsolver(
  handler: (path: string, body: Record<string, unknown>, n: number) => Record<string, unknown>,
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
      const reply = handler(req.url ?? "", body, requests.length);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
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

const READY = {
  errorId: 0,
  taskId: "task-1",
  status: "ready",
  solution: { cookies: { cf_clearance: "clear-123" }, userAgent: "SolvedUA/9.9" },
};

describe("capSolver — provider contract", () => {
  it("demands an API key at construction (explicit or CAPSOLVER_API_KEY)", async () => {
    delete process.env.CAPSOLVER_API_KEY;
    expect(() => capSolver()).toThrow(ConfigError);
    // Env fallback resolves.
    process.env.CAPSOLVER_API_KEY = KEY;
    const server = await fakeCapsolver(() => READY);
    try {
      const solver = capSolver({ baseUrl: server.url });
      const solution = await solver.solve(cfChallenge(), {});
      expect(solution.cookies?.cf_clearance).toBe("clear-123");
    } finally {
      await server.close();
    }
  });

  it("sends the AntiCloudflareTask body: proxy, UA and html from the challenge", async () => {
    const server = await fakeCapsolver(() => READY);
    try {
      const solver = capSolver({ apiKey: KEY, baseUrl: server.url });
      const solution = await solver.solve(cfChallenge(), {});
      expect(solution).toEqual({
        cookies: { cf_clearance: "clear-123" },
        userAgent: "SolvedUA/9.9",
      });
      expect(server.requests).toHaveLength(1);
      const req = server.requests[0];
      expect(req?.path).toBe("/createTask");
      expect(req?.body.clientKey).toBe(KEY);
      expect(req?.body.task).toEqual({
        type: "AntiCloudflareTask",
        websiteURL: "https://protected.example/secret",
        proxy: PROXY,
        userAgent: "WireUA/1.0",
        html: CF_CHALLENGE_HTML,
      });
    } finally {
      await server.close();
    }
  });

  it("challenge.proxyUrl wins over options.proxy; options.proxy is the fallback", async () => {
    const server = await fakeCapsolver(() => READY);
    try {
      const solver = capSolver({ apiKey: KEY, baseUrl: server.url, proxy: "http://fallback:1" });
      await solver.solve(cfChallenge({ proxyUrl: "http://challenge:2" }), {});
      await solver.solve(cfChallenge({ proxyUrl: undefined }), {});
      const tasks = server.requests.map((r) => r.body.task as Record<string, unknown>);
      expect(tasks[0]?.proxy).toBe("http://challenge:2");
      expect(tasks[1]?.proxy).toBe("http://fallback:1");
    } finally {
      await server.close();
    }
  });

  it("falls back to the stealth Chrome UA when the challenge carries none", async () => {
    const server = await fakeCapsolver(() => READY);
    try {
      const solver = capSolver({ apiKey: KEY, baseUrl: server.url });
      await solver.solve(cfChallenge({ userAgent: undefined }), {});
      const task = server.requests[0]?.body.task as Record<string, unknown>;
      expect(task?.userAgent).toContain("Chrome/");
    } finally {
      await server.close();
    }
  });

  it("polls getTaskResult while processing, then maps the ready solution", async () => {
    let polls = 0;
    const server = await fakeCapsolver((path) => {
      if (path === "/createTask") return { errorId: 0, taskId: "task-9", status: "processing" };
      polls += 1;
      return polls < 3
        ? { errorId: 0, status: "processing" }
        : { errorId: 0, status: "ready", solution: READY.solution };
    });
    try {
      const solver = capSolver({ apiKey: KEY, baseUrl: server.url, pollIntervalMs: 1 });
      const solution = await solver.solve(cfChallenge(), {});
      expect(polls).toBe(3);
      expect(solution.cookies?.cf_clearance).toBe("clear-123");
      const pollReq = server.requests[1];
      expect(pollReq?.path).toBe("/getTaskResult");
      expect(pollReq?.body).toEqual({ clientKey: KEY, taskId: "task-9" });
    } finally {
      await server.close();
    }
  });

  it("maps errorId/errorCode to an Error naming both", async () => {
    const server = await fakeCapsolver(() => ({
      errorId: 1,
      errorCode: "ERROR_KEY_DOES_NOT_EXIST",
      errorDescription: "the key is bad",
    }));
    try {
      const solver = capSolver({ apiKey: "bad-key", baseUrl: server.url });
      const err = await solver.solve(cfChallenge(), {}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("ERROR_KEY_DOES_NOT_EXIST");
      expect((err as Error).message).toContain("the key is bad");
    } finally {
      await server.close();
    }
  });

  it("a failed task status rejects with its error code", async () => {
    const server = await fakeCapsolver((path) =>
      path === "/createTask"
        ? { errorId: 0, taskId: "t", status: "processing" }
        : {
            errorId: 0,
            status: "failed",
            errorCode: "ERROR_CAPTCHA_UNSOLVABLE",
            errorDescription: "gave up",
          },
    );
    try {
      const solver = capSolver({ apiKey: KEY, baseUrl: server.url, pollIntervalMs: 1 });
      const err = await solver.solve(cfChallenge(), {}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("ERROR_CAPTCHA_UNSOLVABLE");
    } finally {
      await server.close();
    }
  });

  it("times out while still processing", async () => {
    const server = await fakeCapsolver((path) =>
      path === "/createTask"
        ? { errorId: 0, taskId: "t", status: "processing" }
        : { errorId: 0, status: "processing" },
    );
    try {
      const solver = capSolver({
        apiKey: KEY,
        baseUrl: server.url,
        pollIntervalMs: 5,
        timeoutMs: 40,
      });
      const err = await solver.solve(cfChallenge(), {}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TimeoutError);
    } finally {
      await server.close();
    }
  });

  it("honors a caller abort mid-poll", async () => {
    const server = await fakeCapsolver((path) =>
      path === "/createTask"
        ? { errorId: 0, taskId: "t", status: "processing" }
        : { errorId: 0, status: "processing" },
    );
    try {
      const solver = capSolver({ apiKey: KEY, baseUrl: server.url, pollIntervalMs: 5 });
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
    const server = await fakeCapsolver(() => READY);
    try {
      const solver = capSolver({ apiKey: KEY, baseUrl: server.url });
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

  it("rejects without a proxy — the clearance would bind the wrong IP", async () => {
    const server = await fakeCapsolver(() => READY);
    try {
      const solver = capSolver({ apiKey: KEY, baseUrl: server.url });
      const err = await solver
        .solve(cfChallenge({ proxyUrl: undefined }), {})
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("proxy");
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});

describe("capSolver — scraper integration", () => {
  const cloudflarePage = () =>
    new Response(CF_CHALLENGE_HTML, {
      status: 403,
      headers: { "content-type": "text/html; charset=utf-8", "cf-mitigated": "challenge" },
    });
  const okHtml = (body = "<html><h1>unlocked</h1></html>") =>
    new Response(body, { status: 200, headers: { "content-type": "text/html" } });

  it("end-to-end: CF interstitial → solve → cf_clearance retry returns the page", async () => {
    const server = await fakeCapsolver(() => READY);
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
        solver: capSolver({
          apiKey: KEY,
          baseUrl: server.url,
          proxy: PROXY,
          pollIntervalMs: 1,
        }),
      });
      const page = await scraper.scrape("https://protected.example/secret", { title: "h1" });
      expect(page.title).toBe("unlocked");
      // The challenge carried no proxyUrl (direct request) → options.proxy served.
      const task = server.requests[0]?.body.task as Record<string, unknown>;
      expect(task?.proxy).toBe(PROXY);
      // The retry carries the clearance AND the UA it is bound to.
      expect(targetCalls).toHaveLength(2);
      expect(targetCalls[1]?.headers.get("cookie")).toContain("cf_clearance=clear-123");
      expect(targetCalls[1]?.headers.get("user-agent")).toBe("SolvedUA/9.9");
    } finally {
      await server.close();
    }
  });

  it("threads the egress proxy and wire UA into the challenge via the pool", async () => {
    const P1 = "http://proxy-one.example:8080";
    const factoryCalls: Array<{ proxyUrl: string; url: string }> = [];
    let served = 0;
    const factory: ProxyFetchFactory = (proxyUrl) =>
      (async (input: Parameters<FetchImpl>[0]) => {
        factoryCalls.push({ proxyUrl, url: String(input) });
        served += 1;
        return served === 1 ? cloudflarePage() : okHtml();
      }) as FetchImpl;
    const seen: CaptchaChallenge[] = [];
    const solver: CaptchaSolver = {
      solve: async (challenge) => {
        seen.push(challenge);
        return { cookies: { cf_clearance: "solved" } };
      },
    };
    // `__proxyPool` is the internal test seam — see InternalScraperOptions.
    const scraper = createScraper({
      __proxyPool: { fetchFactory: factory },
      proxies: [P1],
      robots: false,
      retries: 0,
      solver,
    } as ScraperOptions);
    const result = await scraper.fetchHtml("https://a.example/1");
    expect(result.status).toBe(200);
    expect(seen[0]?.proxyUrl).toBe(P1);
    expect(seen[0]?.userAgent).toContain("crawlio/");
    // The retry rides the same bound egress the clearance was solved for.
    expect(factoryCalls[1]?.proxyUrl).toBe(P1);
  });
});
