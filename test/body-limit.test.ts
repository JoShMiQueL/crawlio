/**
 * `maxBodyBytes` coverage — the response-size cap. Fast-fail on a declared
 * `Content-Length` over the cap (body never read), mid-stream abort on a
 * lengthless body, exact-boundary acceptance, per-request vs instance
 * defaults, and the fixed 512 KiB robots.txt cap — all through injected
 * fetch impls, per test conventions.
 */
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  createScraper,
  DEFAULT_MAX_BODY_BYTES,
  fetchHtmlOnce,
  fetchRobotsTxt,
  ResponseTooLargeError,
} from "../src/index.js";
import { fetchRobotsTxtResult, ROBOTS_MAX_BODY_BYTES } from "../src/robots.js";

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };
type FetchImpl = typeof globalThis.fetch;

/** A Response whose body is a stream that records pulls and cancellations. */
function trackedStreamResponse(
  chunks: Uint8Array[],
  init: { status?: number; headers?: Record<string, string> } = {},
): { response: Response; stats: { pulls: number; cancelled: boolean } } {
  const stats = { pulls: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      stats.pulls += 1;
      const chunk = chunks.shift();
      if (chunk === undefined) {
        controller.close();
      } else {
        controller.enqueue(chunk);
      }
    },
    cancel() {
      stats.cancelled = true;
    },
  });
  return { response: new Response(stream, init), stats };
}

const body = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("maxBodyBytes — Content-Length fast fail", () => {
  it("rejects a declared over-cap body without reading a byte", async () => {
    const { response, stats } = trackedStreamResponse([body("x".repeat(64))], {
      headers: { ...HTML_HEADERS, "content-length": "65" },
    });
    const impl = (async () => response) as FetchImpl;
    const err = await fetchHtmlOnce("http://example.com/", {
      fetch: impl,
      maxBodyBytes: 64,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponseTooLargeError);
    const tooLarge = err as ResponseTooLargeError;
    expect(tooLarge.code).toBe("response-too-large");
    expect(tooLarge.retryable).toBe(false);
    expect(tooLarge.bytes).toBe(65);
    expect(tooLarge.limit).toBe(64);
    // The body was never read: `pulls` holds only the construction-time
    // prefetch a ReadableStream does to fill its queue — a read would pull
    // again (and a streamed read of this 64-byte body would NOT have tripped
    // the 64-byte cap, so the declared-length error already proves it).
    // It WAS cancelled, releasing the connection.
    expect(stats.pulls).toBeLessThanOrEqual(1);
    expect(stats.cancelled).toBe(true);
  });

  it("uses the 10 MiB default cap when no option is given", async () => {
    const { response } = trackedStreamResponse([], {
      headers: { ...HTML_HEADERS, "content-length": String(DEFAULT_MAX_BODY_BYTES + 1) },
    });
    const impl = (async () => response) as FetchImpl;
    const err = await fetchHtmlOnce("http://example.com/", { fetch: impl }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ResponseTooLargeError);
    expect((err as ResponseTooLargeError).limit).toBe(DEFAULT_MAX_BODY_BYTES);
  });

  it("accepts a body at exactly the cap", async () => {
    const exact = "x".repeat(64);
    const { response } = trackedStreamResponse([body(exact)], {
      headers: { ...HTML_HEADERS, "content-length": "64" },
    });
    const impl = (async () => response) as FetchImpl;
    const result = await fetchHtmlOnce("http://example.com/", { fetch: impl, maxBodyBytes: 64 });
    expect(result.html).toBe(exact);
  });
});

describe("maxBodyBytes — streamed bodies without a declared length", () => {
  it("aborts mid-stream once the cap is exceeded", async () => {
    // An INFINITE 32-byte-chunk stream, cap 64 — the third chunk trips the
    // abort. (A closing stream would make cancel() a spec no-op, so the
    // stream must stay open for the cancellation itself to be observable.)
    const stats = { pulls: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        stats.pulls += 1;
        controller.enqueue(body("c".repeat(32)));
      },
      cancel() {
        stats.cancelled = true;
      },
    });
    const impl = (async () => new Response(stream, { headers: HTML_HEADERS })) as FetchImpl;
    const err = await fetchHtmlOnce("http://example.com/", {
      fetch: impl,
      maxBodyBytes: 64,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponseTooLargeError);
    expect((err as ResponseTooLargeError).bytes).toBe(96);
    expect(stats.cancelled).toBe(true);
  });

  it("accepts a streamed body at exactly the cap", async () => {
    const { response } = trackedStreamResponse([body("a".repeat(32)), body("b".repeat(32))], {
      headers: HTML_HEADERS,
    });
    const impl = (async () => response) as FetchImpl;
    const result = await fetchHtmlOnce("http://example.com/", { fetch: impl, maxBodyBytes: 64 });
    expect(result.html).toBe(`${"a".repeat(32)}${"b".repeat(32)}`);
  });
});

describe("maxBodyBytes — option plumbing and validation", () => {
  it("applies the scraper-level default and a per-call override", async () => {
    const big = "x".repeat(128);
    const impl = (async () => new Response(big, { headers: HTML_HEADERS })) as FetchImpl;
    const scraper = createScraper({ robots: false, fetch: impl, maxBodyBytes: 64 });
    const err = await scraper.fetchHtml("http://example.com/").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponseTooLargeError);
    // Per-call raise wins over the instance default.
    const result = await scraper.fetchHtml("http://example.com/", { maxBodyBytes: 256 });
    expect(result.html).toBe(big);
  });

  it("rejects a non-positive maxBodyBytes as a ConfigError", async () => {
    const impl = (async () => new Response("<h1>ok</h1>", { headers: HTML_HEADERS })) as FetchImpl;
    for (const bad of [0, -1, Number.NaN, "1MB" as unknown as number]) {
      const err = await fetchHtmlOnce("http://example.com/", {
        fetch: impl,
        maxBodyBytes: bad,
      }).catch((e: unknown) => e);
      expect(err, String(bad)).toBeInstanceOf(ConfigError);
    }
    const scraperErr = await createScraper({ robots: false, fetch: impl })
      .fetchHtml("http://example.com/", { maxBodyBytes: 0 })
      .catch((e: unknown) => e);
    expect(scraperErr).toBeInstanceOf(ConfigError);
  });

  it("treats Infinity as 'cap disabled'", async () => {
    const big = "x".repeat(DEFAULT_MAX_BODY_BYTES + 1024);
    const impl = (async () =>
      new Response(big, {
        headers: { ...HTML_HEADERS, "content-length": String(big.length) },
      })) as FetchImpl;
    const result = await fetchHtmlOnce("http://example.com/", {
      fetch: impl,
      maxBodyBytes: Infinity,
    });
    expect(result.html.length).toBe(big.length);
  });
});

describe("robots.txt — fixed 512 KiB cap", () => {
  const VALID_ROBOTS = "User-agent: *\nDisallow: /private\n";

  it("parses a robots.txt under the cap", async () => {
    const impl = (async () =>
      new Response(VALID_ROBOTS, { headers: { "content-type": "text/plain" } })) as FetchImpl;
    const agent = await fetchRobotsTxt("http://example.com/robots.txt", { fetch: impl });
    expect(agent?.isAllowed("http://example.com/public", "*")).toBe(true);
    expect(agent?.isAllowed("http://example.com/private", "*")).toBe(false);
  });

  it("treats an over-cap robots.txt as a failed fetch (allow-all, uncached)", async () => {
    const oversized = `${"#".repeat(ROBOTS_MAX_BODY_BYTES - 16)}\n${VALID_ROBOTS}`;
    expect(oversized.length).toBeGreaterThan(ROBOTS_MAX_BODY_BYTES);
    const impl = (async () =>
      new Response(oversized, { headers: { "content-type": "text/plain" } })) as FetchImpl;
    const result = await fetchRobotsTxtResult("http://example.com/robots.txt", { fetch: impl });
    expect(result.kind).toBe("failed");
    // The public helper collapses the kind to "allow" — never blocks.
    const agent = await fetchRobotsTxt("http://example.com/robots.txt", { fetch: impl });
    expect(agent).toBeNull();
  });
});
