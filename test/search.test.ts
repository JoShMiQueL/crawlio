import { afterEach, describe, expect, it } from "vitest";
import {
  braveSearchProvider,
  ConfigError,
  FetchError,
  HttpError,
  ParseError,
  type SearchProvider,
  type SearchResult,
  scrapeMany,
  search,
} from "../src/index.js";

type FetchImpl = typeof globalThis.fetch;

const JSON_HEADERS = { "content-type": "application/json" };
const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };
const KEY = "test-secret-key";

interface RecordedCall {
  url: string;
  headers: Headers;
}

/** A fetch mock recording (url, headers) and serving a fixed response. */
function recordingFetch(response: () => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const impl: FetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return response();
  }) as FetchImpl;
  return { impl, calls };
}

function braveBody(results: Array<Record<string, unknown>>): string {
  return JSON.stringify({ web: { results } });
}

// The env fallback must never be polluted by a developer's real key.
const savedEnvKey = process.env.BRAVE_API_KEY;
afterEach(() => {
  if (savedEnvKey === undefined) delete process.env.BRAVE_API_KEY;
  else process.env.BRAVE_API_KEY = savedEnvKey;
});

describe("search seam", () => {
  const stub = (results: SearchResult[]): SearchProvider => ({
    search: async () => results,
  });

  it("requires a provider", async () => {
    await expect(
      search("q", { provider: undefined as unknown as SearchProvider }),
    ).rejects.toBeInstanceOf(ConfigError);
    await expect(search("q", { provider: {} as SearchProvider })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it("rejects an empty or whitespace-only query", async () => {
    await expect(search("", { provider: stub([]) })).rejects.toBeInstanceOf(ConfigError);
    await expect(search("   \n\t ", { provider: stub([]) })).rejects.toBeInstanceOf(ConfigError);
  });

  it("trims the query before handing it to the provider", async () => {
    let seen = "";
    const provider: SearchProvider = {
      search: async (query) => {
        seen = query;
        return [];
      },
    };
    await search("  hello  ", { provider });
    expect(seen).toBe("hello");
  });

  it("applies limit client-side even when the provider over-returns", async () => {
    const provider = stub([
      { url: "https://a.example/" },
      { url: "https://b.example/" },
      { url: "https://c.example/" },
    ]);
    const results = await search("q", { provider, limit: 2 });
    expect(results.map((r) => r.url)).toEqual(["https://a.example/", "https://b.example/"]);
  });

  it("rejects an invalid limit", async () => {
    await expect(search("q", { provider: stub([]), limit: -1 })).rejects.toBeInstanceOf(
      ConfigError,
    );
    await expect(search("q", { provider: stub([]), limit: 1.5 })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it("short-circuits limit: 0 without calling the provider", async () => {
    let called = 0;
    const provider: SearchProvider = {
      search: async () => {
        called += 1;
        return [{ url: "https://a.example/" }];
      },
    };
    expect(await search("q", { provider, limit: 0 })).toEqual([]);
    expect(called).toBe(0);
  });

  it("validates retries and forwards it to the provider", async () => {
    await expect(search("q", { provider: stub([]), retries: -1 })).rejects.toBeInstanceOf(
      ConfigError,
    );
    await expect(search("q", { provider: stub([]), retries: 0.5 })).rejects.toBeInstanceOf(
      ConfigError,
    );
    let seen: number | undefined;
    const provider: SearchProvider = {
      search: async (_query, options) => {
        seen = options?.retries;
        return [];
      },
    };
    await search("q", { provider, retries: 2 });
    expect(seen).toBe(2);
  });

  it("drops hits without a usable url and non-string fields", async () => {
    const provider = stub([
      { url: "https://ok.example/", title: "ok", description: "fine" },
      // Untrusted provider payloads: a hit without a url cannot be used
      // downstream, and non-string title/description must not leak through.
      { url: "" } as SearchResult,
      { url: "https://ok2.example/", title: 3 as unknown as string },
      null as unknown as SearchResult,
    ]);
    const results = await search("q", { provider });
    expect(results).toEqual([
      { url: "https://ok.example/", title: "ok", description: "fine" },
      { url: "https://ok2.example/" },
    ]);
  });

  it("rejects a non-array provider result as ConfigError", async () => {
    const provider: SearchProvider = {
      search: async () => ({ url: "https://x.example/" }) as unknown as SearchResult[],
    };
    await expect(search("q", { provider })).rejects.toBeInstanceOf(ConfigError);
  });

  it("wraps a throwing provider in ConfigError but passes ScrapeError through", async () => {
    const throwing: SearchProvider = {
      search: async () => {
        throw new TypeError("provider bug");
      },
    };
    await expect(search("q", { provider: throwing })).rejects.toBeInstanceOf(ConfigError);
    const typed: SearchProvider = {
      search: async () => {
        throw new HttpError("HTTP 500", { status: 500 });
      },
    };
    await expect(search("q", { provider: typed })).rejects.toBeInstanceOf(HttpError);
  });

  it("surfaces a caller abort as FetchError, not a raw DOMException", async () => {
    const controller = new AbortController();
    controller.abort();
    let sawSignal: AbortSignal | undefined;
    const provider: SearchProvider = {
      search: async (_query, options) => {
        sawSignal = options?.signal;
        // What an honoring provider does when the caller's signal is dead.
        throw new DOMException("aborted", "AbortError");
      },
    };
    await expect(search("q", { provider, signal: controller.signal })).rejects.toBeInstanceOf(
      FetchError,
    );
    expect(sawSignal).toBe(controller.signal);
  });

  it("surfaces a custom abort reason as FetchError, never the raw reason", async () => {
    const controller = new AbortController();
    controller.abort("stop");
    const provider: SearchProvider = {
      search: async (_query, options) => {
        // What fetch does when handed a dead signal: reject with the raw
        // reason — a string here, not even an Error.
        throw options?.signal?.reason;
      },
    };
    const error = await search("q", { provider, signal: controller.signal }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(FetchError);
    expect((error as FetchError).cause).toBe("stop");
  });
});

describe("braveSearchProvider", () => {
  function providerWith(impl: FetchImpl) {
    return braveSearchProvider({ apiKey: KEY, baseUrl: "https://search.test/api", fetch: impl });
  }

  it("sends the token in the header — never the URL — with the honest UA", async () => {
    const { impl, calls } = recordingFetch(
      () =>
        new Response(braveBody([{ url: "https://a.example/" }]), {
          status: 200,
          headers: JSON_HEADERS,
        }),
    );
    await providerWith(impl).search("hello world", { limit: 3 });
    expect(calls).toHaveLength(1);
    const call = calls[0] as RecordedCall;
    expect(call.url).toBe("https://search.test/api?q=hello+world&count=3");
    expect(call.headers.get("x-subscription-token")).toBe(KEY);
    expect(call.headers.get("accept")).toBe("application/json");
    expect(call.headers.get("user-agent")).toContain("crawlio/");
    // The credential must not travel in the request line.
    expect(call.url).not.toContain(KEY);
  });

  it("omits count when no limit is given", async () => {
    const { impl, calls } = recordingFetch(
      () => new Response(braveBody([]), { status: 200, headers: JSON_HEADERS }),
    );
    await providerWith(impl).search("q");
    expect(calls[0]?.url).toBe("https://search.test/api?q=q");
  });

  it("clamps count to Brave's 1–20 bound", async () => {
    const { impl, calls } = recordingFetch(
      () => new Response(braveBody([]), { status: 200, headers: JSON_HEADERS }),
    );
    const provider = providerWith(impl);
    await provider.search("q", { limit: 100 });
    expect(calls[0]?.url).toContain("count=20");
    // The lower bound is reachable too: a direct provider call with limit 0
    // asks for the minimum page, not zero results.
    await provider.search("q", { limit: 0 });
    expect(calls[1]?.url).toContain("count=1");
  });

  it("maps web.results entries, tolerating missing title/description", async () => {
    const { impl } = recordingFetch(
      () =>
        new Response(
          braveBody([
            { url: "https://a.example/", title: "A", description: "alpha" },
            { url: "https://b.example/" },
            { title: "no url — dropped" },
          ]),
          { status: 200, headers: JSON_HEADERS },
        ),
    );
    const results = await providerWith(impl).search("q");
    expect(results).toEqual([
      { url: "https://a.example/", title: "A", description: "alpha" },
      { url: "https://b.example/" },
    ]);
  });

  it("returns an empty list when the response has no web block", async () => {
    const { impl } = recordingFetch(
      () =>
        new Response(JSON.stringify({ query: { original: "q" } }), {
          status: 200,
          headers: JSON_HEADERS,
        }),
    );
    expect(await providerWith(impl).search("q")).toEqual([]);
  });

  it("surfaces non-2xx as a typed error that never names the key", async () => {
    const { impl } = recordingFetch(
      () => new Response(`{"error":"${KEY} is invalid"}`, { status: 401 }),
    );
    const error = await providerWith(impl)
      .search("q")
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(401);
    expect((error as HttpError).message).toContain("API key");
    expect((error as HttpError).message).not.toContain(KEY);
    // The scrubbed `url` property carries the request URL — query, not key.
    expect((error as HttpError).url ?? "").not.toContain(KEY);
  });

  it("retries a 429 per the shared policy and then succeeds", async () => {
    let attempt = 0;
    const { impl, calls } = recordingFetch(() => {
      attempt += 1;
      return attempt === 1
        ? new Response("slow down", { status: 429 })
        : new Response(braveBody([{ url: "https://a.example/" }]), {
            status: 200,
            headers: JSON_HEADERS,
          });
    });
    const results = await providerWith(impl).search("q");
    expect(calls).toHaveLength(2);
    expect(results).toEqual([{ url: "https://a.example/" }]);
  });

  it("honors retries: 0 — a retryable status fails after one attempt", async () => {
    const { impl, calls } = recordingFetch(() => new Response("slow down", { status: 429 }));
    await expect(providerWith(impl).search("q", { retries: 0 })).rejects.toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(1);
  });

  it("keeps the original HttpError as cause on the rejected-key re-wrap", async () => {
    const { impl } = recordingFetch(() => new Response("denied", { status: 403 }));
    const error = await providerWith(impl)
      .search("q")
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).cause).toBeInstanceOf(HttpError);
    expect(((error as HttpError).cause as HttpError).status).toBe(403);
  });

  it("does not retry a caller abort — pre-aborted signal is a FetchError", async () => {
    const { impl, calls } = recordingFetch(() => new Response("unreached"));
    const controller = new AbortController();
    controller.abort();
    await expect(
      providerWith(impl).search("q", { signal: controller.signal }),
    ).rejects.toBeInstanceOf(FetchError);
    expect(calls).toHaveLength(0);
  });

  it("wraps a mid-backoff custom abort reason as FetchError carrying the url", async () => {
    // First attempt fails retryably (429); the caller aborts with a custom,
    // non-Error reason while p-retry sleeps between attempts. The raw reason
    // must not escape — it becomes the FetchError's `cause`.
    const { impl, calls } = recordingFetch(() => new Response("slow down", { status: 429 }));
    const controller = new AbortController();
    const pending = providerWith(impl)
      .search("q", { signal: controller.signal })
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    await new Promise((r) => setTimeout(r, 50));
    controller.abort("stop");
    const error = await pending;
    expect(error).toBeInstanceOf(FetchError);
    expect(error).not.toBeInstanceOf(DOMException);
    expect((error as FetchError).cause).toBe("stop");
    expect((error as FetchError).url ?? "").toContain("https://search.test/api");
    expect(calls).toHaveLength(1);
  });

  it("wraps a mid-backoff default abort (AbortError DOMException) as FetchError", async () => {
    const { impl } = recordingFetch(() => new Response("slow down", { status: 429 }));
    const controller = new AbortController();
    const pending = providerWith(impl)
      .search("q", { signal: controller.signal })
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(FetchError);
    expect((error as FetchError).cause).toBeInstanceOf(DOMException);
    expect((error as FetchError).url ?? "").toContain("https://search.test/api");
  });

  it("surfaces malformed JSON as ParseError", async () => {
    const { impl } = recordingFetch(
      () => new Response("this is not json <<<", { status: 200, headers: JSON_HEADERS }),
    );
    await expect(providerWith(impl).search("q")).rejects.toBeInstanceOf(ParseError);
  });

  it("falls back to BRAVE_API_KEY and an explicit key wins", async () => {
    process.env.BRAVE_API_KEY = "env-key";
    const { impl, calls } = recordingFetch(
      () => new Response(braveBody([]), { status: 200, headers: JSON_HEADERS }),
    );
    await braveSearchProvider({ baseUrl: "https://search.test/api", fetch: impl }).search("q");
    expect(calls[0]?.headers.get("x-subscription-token")).toBe("env-key");
    calls.length = 0;
    await braveSearchProvider({
      apiKey: "explicit-key",
      baseUrl: "https://search.test/api",
      fetch: impl,
    }).search("q");
    expect(calls[0]?.headers.get("x-subscription-token")).toBe("explicit-key");
  });

  it("throws ConfigError at construction when no key is available", () => {
    delete process.env.BRAVE_API_KEY;
    expect(() => braveSearchProvider()).toThrow(ConfigError);
  });

  it("throws ConfigError at construction on an invalid baseUrl", () => {
    expect(() => braveSearchProvider({ apiKey: KEY, baseUrl: "not a url" })).toThrow(ConfigError);
  });
});

describe("search → scrapeMany pipe", () => {
  it("feeds search hits into extraction over injected fetches", async () => {
    // The provider's injected fetch serves Brave-shaped JSON; the scraper's
    // serves per-URL HTML. Two separate injection slots, zero network.
    const { impl: searchFetch } = recordingFetch(
      () =>
        new Response(
          braveBody([
            { url: "https://a.example/", title: "A" },
            { url: "https://b.example/", title: "B" },
          ]),
          { status: 200, headers: JSON_HEADERS },
        ),
    );
    const provider = braveSearchProvider({
      apiKey: KEY,
      baseUrl: "https://search.test/api",
      fetch: searchFetch,
    });
    const results = await search("query", { provider });
    const pages: Record<string, string> = {
      "https://a.example/": "<html><body><h1>Alpha</h1></body></html>",
      "https://b.example/": "<html><body><h1>Beta</h1></body></html>",
    };
    const pageFetch: FetchImpl = (async (input: unknown) => {
      const body = pages[String(input)];
      return body === undefined
        ? new Response("not found", { status: 404 })
        : new Response(body, { status: 200, headers: HTML_HEADERS });
    }) as FetchImpl;
    const data = await scrapeMany(
      results.map((r) => r.url),
      { title: "h1" },
      { fetch: pageFetch, robots: false },
    );
    expect(data.map((d) => d.title)).toEqual(["Alpha", "Beta"]);
  });
});
