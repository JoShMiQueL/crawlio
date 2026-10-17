import { afterEach, describe, expect, it } from "vitest";
import {
  braveSearchProvider,
  ConfigError,
  crawl,
  FetchError,
  fetchHtml,
  fetchHtmlOnce,
  HttpError,
  map,
  ParseError,
  SEARCH_PROVIDER_NAMES,
  type SearchProvider,
  type SearchProviderName,
  type SearchResult,
  scrape,
  scrapeMany,
  search,
  serperSearchProvider,
  tavilySearchProvider,
} from "../src/index.js";

type FetchImpl = typeof globalThis.fetch;

const JSON_HEADERS = { "content-type": "application/json" };
const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };
const KEY = "test-secret-key";

interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

/** A fetch mock recording (url, method, headers, body) and serving a fixed response. */
function recordingFetch(response: () => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const impl: FetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return response();
  }) as FetchImpl;
  return { impl, calls };
}

function braveBody(results: Array<Record<string, unknown>>): string {
  return JSON.stringify({ web: { results } });
}

function serperBody(results: Array<Record<string, unknown>>): string {
  return JSON.stringify({ organic: results });
}

function tavilyBody(results: Array<Record<string, unknown>>): string {
  return JSON.stringify({ results });
}

// The env fallbacks must never be polluted by a developer's real key.
const ENV_KEYS = ["BRAVE_API_KEY", "SERPER_API_KEY", "TAVILY_API_KEY"] as const;
const savedEnvKeys = ENV_KEYS.map((name) => [name, process.env[name]] as const);
afterEach(() => {
  for (const [name, value] of savedEnvKeys) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
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

  it("reports the empty query even when the provider would demand a key", async () => {
    // Provider resolution (and its API-key ConfigError) comes AFTER input
    // validation — a caller bug must name itself, not the missing key.
    delete process.env.BRAVE_API_KEY;
    const error = await search("", { provider: "brave" }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain("non-empty");
    expect((error as ConfigError).message).not.toContain("API key");
  });

  it("reports a bad limit/retries before resolving the provider", async () => {
    delete process.env.BRAVE_API_KEY;
    for (const options of [{ limit: -1 }, { retries: -1 }]) {
      const error = await search("q", { provider: "brave", ...options }).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).not.toContain("API key");
    }
  });

  it("short-circuits limit: 0 without resolving the provider — no key needed", async () => {
    delete process.env.BRAVE_API_KEY;
    expect(await search("q", { provider: "brave", limit: 0 })).toEqual([]);
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

describe("serperSearchProvider", () => {
  function providerWith(impl: FetchImpl) {
    return serperSearchProvider({
      apiKey: KEY,
      baseUrl: "https://search.test/serper",
      fetch: impl,
    });
  }

  it("POSTs the query as JSON with the key in X-API-KEY — never the URL or body", async () => {
    const { impl, calls } = recordingFetch(
      () =>
        new Response(serperBody([{ link: "https://a.example/" }]), {
          status: 200,
          headers: JSON_HEADERS,
        }),
    );
    await providerWith(impl).search("hello world", { limit: 3 });
    expect(calls).toHaveLength(1);
    const call = calls[0] as RecordedCall;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://search.test/serper");
    expect(call.headers.get("x-api-key")).toBe(KEY);
    expect(call.headers.get("content-type")).toBe("application/json");
    expect(call.headers.get("accept")).toBe("application/json");
    expect(call.headers.get("user-agent")).toContain("crawlio/");
    expect(JSON.parse(call.body ?? "null")).toEqual({ q: "hello world", num: 3 });
    // The credential must travel in neither the request line nor the payload.
    expect(call.url).not.toContain(KEY);
    expect(call.body ?? "").not.toContain(KEY);
  });

  it("omits num when no limit is given and clamps it to Serper's 1–100 bound", async () => {
    const { impl, calls } = recordingFetch(
      () => new Response(serperBody([]), { status: 200, headers: JSON_HEADERS }),
    );
    const provider = providerWith(impl);
    await provider.search("q");
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({ q: "q" });
    await provider.search("q", { limit: 500 });
    expect(JSON.parse(calls[1]?.body ?? "null")).toEqual({ q: "q", num: 100 });
    await provider.search("q", { limit: 0 });
    expect(JSON.parse(calls[2]?.body ?? "null")).toEqual({ q: "q", num: 1 });
  });

  it("maps organic entries (link/snippet), tolerating missing fields", async () => {
    const { impl } = recordingFetch(
      () =>
        new Response(
          serperBody([
            { link: "https://a.example/", title: "A", snippet: "alpha" },
            { link: "https://b.example/" },
            { title: "no link — dropped" },
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

  it("returns an empty list when the response has no organic block", async () => {
    const { impl } = recordingFetch(
      () =>
        new Response(JSON.stringify({ answerBox: { answer: "42" } }), {
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
    expect((error as HttpError).url ?? "").not.toContain(KEY);
  });

  it("retries a 429 per the shared policy and then succeeds", async () => {
    let attempt = 0;
    const { impl, calls } = recordingFetch(() => {
      attempt += 1;
      return attempt === 1
        ? new Response("slow down", { status: 429 })
        : new Response(serperBody([{ link: "https://a.example/" }]), {
            status: 200,
            headers: JSON_HEADERS,
          });
    });
    const results = await providerWith(impl).search("q");
    expect(calls).toHaveLength(2);
    expect(results).toEqual([{ url: "https://a.example/" }]);
  });

  it("surfaces malformed JSON as ParseError", async () => {
    const { impl } = recordingFetch(
      () => new Response("this is not json <<<", { status: 200, headers: JSON_HEADERS }),
    );
    await expect(providerWith(impl).search("q")).rejects.toBeInstanceOf(ParseError);
  });

  it("falls back to SERPER_API_KEY and an explicit key wins", async () => {
    process.env.SERPER_API_KEY = "env-key";
    const { impl, calls } = recordingFetch(
      () => new Response(serperBody([]), { status: 200, headers: JSON_HEADERS }),
    );
    await serperSearchProvider({ baseUrl: "https://search.test/serper", fetch: impl }).search("q");
    expect(calls[0]?.headers.get("x-api-key")).toBe("env-key");
    calls.length = 0;
    await serperSearchProvider({
      apiKey: "explicit-key",
      baseUrl: "https://search.test/serper",
      fetch: impl,
    }).search("q");
    expect(calls[0]?.headers.get("x-api-key")).toBe("explicit-key");
  });

  it("throws ConfigError at construction when no key is available", () => {
    delete process.env.SERPER_API_KEY;
    expect(() => serperSearchProvider()).toThrow(ConfigError);
  });

  it("throws ConfigError at construction on an invalid baseUrl", () => {
    expect(() => serperSearchProvider({ apiKey: KEY, baseUrl: "not a url" })).toThrow(ConfigError);
  });
});

describe("tavilySearchProvider", () => {
  function providerWith(impl: FetchImpl) {
    return tavilySearchProvider({
      apiKey: KEY,
      baseUrl: "https://search.test/tavily",
      fetch: impl,
    });
  }

  it("POSTs the query as JSON with a Bearer key — never the URL or body", async () => {
    const { impl, calls } = recordingFetch(
      () =>
        new Response(tavilyBody([{ url: "https://a.example/" }]), {
          status: 200,
          headers: JSON_HEADERS,
        }),
    );
    await providerWith(impl).search("hello world", { limit: 3 });
    expect(calls).toHaveLength(1);
    const call = calls[0] as RecordedCall;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://search.test/tavily");
    expect(call.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(call.headers.get("content-type")).toBe("application/json");
    expect(call.headers.get("user-agent")).toContain("crawlio/");
    // Deliberately `query`/`max_results` — NO `api_key` field in the payload.
    expect(JSON.parse(call.body ?? "null")).toEqual({ query: "hello world", max_results: 3 });
    expect(call.url).not.toContain(KEY);
    expect(call.body ?? "").not.toContain(KEY);
  });

  it("omits max_results when no limit is given and clamps to Tavily's 1–20 bound", async () => {
    const { impl, calls } = recordingFetch(
      () => new Response(tavilyBody([]), { status: 200, headers: JSON_HEADERS }),
    );
    const provider = providerWith(impl);
    await provider.search("q");
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({ query: "q" });
    await provider.search("q", { limit: 500 });
    expect(JSON.parse(calls[1]?.body ?? "null")).toEqual({ query: "q", max_results: 20 });
    await provider.search("q", { limit: 0 });
    expect(JSON.parse(calls[2]?.body ?? "null")).toEqual({ query: "q", max_results: 1 });
  });

  it("maps results entries (url/content), tolerating missing fields", async () => {
    const { impl } = recordingFetch(
      () =>
        new Response(
          tavilyBody([
            { url: "https://a.example/", title: "A", content: "alpha" },
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

  it("returns an empty list when the response has no results block", async () => {
    const { impl } = recordingFetch(
      () =>
        new Response(JSON.stringify({ answer: "42" }), {
          status: 200,
          headers: JSON_HEADERS,
        }),
    );
    expect(await providerWith(impl).search("q")).toEqual([]);
  });

  it("surfaces non-2xx as a typed error that never names the key", async () => {
    const { impl } = recordingFetch(
      () => new Response(`{"error":"${KEY} is invalid"}`, { status: 403 }),
    );
    const error = await providerWith(impl)
      .search("q")
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(403);
    expect((error as HttpError).message).toContain("API key");
    expect((error as HttpError).message).not.toContain(KEY);
    expect((error as HttpError).url ?? "").not.toContain(KEY);
  });

  it("honors retries: 0 — a retryable status fails after one attempt", async () => {
    const { impl, calls } = recordingFetch(() => new Response("slow down", { status: 429 }));
    await expect(providerWith(impl).search("q", { retries: 0 })).rejects.toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(1);
  });

  it("surfaces malformed JSON as ParseError", async () => {
    const { impl } = recordingFetch(
      () => new Response("this is not json <<<", { status: 200, headers: JSON_HEADERS }),
    );
    await expect(providerWith(impl).search("q")).rejects.toBeInstanceOf(ParseError);
  });

  it("falls back to TAVILY_API_KEY and an explicit key wins", async () => {
    process.env.TAVILY_API_KEY = "env-key";
    const { impl, calls } = recordingFetch(
      () => new Response(tavilyBody([]), { status: 200, headers: JSON_HEADERS }),
    );
    await tavilySearchProvider({ baseUrl: "https://search.test/tavily", fetch: impl }).search("q");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer env-key");
    calls.length = 0;
    await tavilySearchProvider({
      apiKey: "explicit-key",
      baseUrl: "https://search.test/tavily",
      fetch: impl,
    }).search("q");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer explicit-key");
  });

  it("throws ConfigError at construction when no key is available", () => {
    delete process.env.TAVILY_API_KEY;
    expect(() => tavilySearchProvider()).toThrow(ConfigError);
  });

  it("throws ConfigError at construction on an invalid baseUrl", () => {
    expect(() => tavilySearchProvider({ apiKey: KEY, baseUrl: "not a url" })).toThrow(ConfigError);
  });
});

describe("search() provider-name resolution", () => {
  /** Swap in a recording fetch as globalThis.fetch for one assertion. */
  async function withGlobalFetch<T>(impl: FetchImpl, run: () => Promise<T>): Promise<T> {
    const saved = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      return await run();
    } finally {
      globalThis.fetch = saved;
    }
  }

  it("resolves 'serper' through the registry and forwards apiKey", async () => {
    const { impl, calls } = recordingFetch(
      () =>
        new Response(serperBody([{ link: "https://a.example/", title: "A" }]), {
          status: 200,
          headers: JSON_HEADERS,
        }),
    );
    const results = await withGlobalFetch(impl, () =>
      search("q", { provider: "serper", apiKey: KEY }),
    );
    expect(results).toEqual([{ url: "https://a.example/", title: "A" }]);
    expect(calls[0]?.url).toContain("google.serper.dev");
    expect(calls[0]?.headers.get("x-api-key")).toBe(KEY);
  });

  it("resolves 'tavily' with the env-var key when apiKey is absent", async () => {
    process.env.TAVILY_API_KEY = "env-key";
    const { impl, calls } = recordingFetch(
      () => new Response(tavilyBody([]), { status: 200, headers: JSON_HEADERS }),
    );
    await withGlobalFetch(impl, () => search("q", { provider: "tavily" }));
    expect(calls[0]?.url).toContain("api.tavily.com");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer env-key");
  });

  it("resolves 'brave' — the string shorthand is equivalent to the adapter", async () => {
    const { impl, calls } = recordingFetch(
      () => new Response(braveBody([]), { status: 200, headers: JSON_HEADERS }),
    );
    await withGlobalFetch(impl, () => search("q", { provider: "brave", apiKey: KEY }));
    expect(calls[0]?.url).toContain("api.search.brave.com");
    expect(calls[0]?.headers.get("x-subscription-token")).toBe(KEY);
  });

  it("ignores apiKey when provider is an object", async () => {
    let called = 0;
    const provider: SearchProvider = {
      search: async () => {
        called += 1;
        return [{ url: "https://a.example/" }];
      },
    };
    const results = await search("q", { provider, apiKey: "ignored" });
    expect(results).toEqual([{ url: "https://a.example/" }]);
    expect(called).toBe(1);
  });

  it("rejects an unknown provider name listing the valid names", async () => {
    const error = await search("q", { provider: "nope" as SearchProviderName }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain('"brave"');
    expect((error as ConfigError).message).toContain('"serper"');
    expect((error as ConfigError).message).toContain('"tavily"');
  });

  it("treats Object.prototype member names as unknown providers, not factories", async () => {
    // A bare index into the registry would hand back `toString`/
    // `constructor` (blowing up far from the cause) and throw a raw
    // TypeError for "__proto__" — outside the ScrapeError taxonomy. Each
    // must get the same ConfigError as any other unknown name.
    for (const name of ["toString", "constructor", "__proto__"]) {
      const error = await search("q", { provider: name as SearchProviderName }).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain("Unknown search provider");
      expect((error as ConfigError).message).toContain('"brave"');
    }
  });

  it("every SEARCH_PROVIDER_NAMES entry resolves through search()", async () => {
    // The exported list IS the registry's key set — a drift between them
    // would make `provider: "<name>"` lie.
    const { impl } = recordingFetch(
      () => new Response(JSON.stringify({}), { status: 200, headers: JSON_HEADERS }),
    );
    await withGlobalFetch(impl, async () => {
      for (const name of SEARCH_PROVIDER_NAMES) {
        expect(await search("q", { provider: name, apiKey: KEY })).toEqual([]);
      }
    });
  });
});

describe("method/body — provider-only fetch options", () => {
  const page = () =>
    new Response("<html><body><h1>A</h1></body></html>", {
      status: 200,
      headers: HTML_HEADERS,
    });

  it("rejects `method`/`body` on the page-scrape path instead of silently GETting", async () => {
    const { impl, calls } = recordingFetch(page);
    await expect(
      scrape("https://a.example/", { title: "h1" }, { fetch: impl, robots: false, method: "POST" }),
    ).rejects.toBeInstanceOf(ConfigError);
    await expect(
      scrape("https://a.example/", { title: "h1" }, { fetch: impl, robots: false, body: "{}" }),
    ).rejects.toBeInstanceOf(ConfigError);
    await expect(
      fetchHtml("https://a.example/", { fetch: impl, robots: false, method: "POST" }),
    ).rejects.toBeInstanceOf(ConfigError);
    // Fail BEFORE the wire — a rejected call must not have fetched.
    expect(calls).toHaveLength(0);
  });

  it("rejects `method`/`body` on `map` and `crawl` too", async () => {
    const { impl, calls } = recordingFetch(page);
    await expect(
      map("https://a.example/", { fetch: impl, robots: false, method: "POST" }),
    ).rejects.toBeInstanceOf(ConfigError);
    // crawl records fetch-level failures per page rather than rejecting —
    // the ConfigError still surfaces there instead of a silent GET.
    const result = await crawl("https://a.example/", {
      fetch: impl,
      robots: false,
      body: "{}",
    });
    expect(result.pages[0]?.error).toBeInstanceOf(ConfigError);
    expect(calls).toHaveLength(0);
  });

  it("rejects `body` on a body-less method before the wire", async () => {
    const { impl, calls } = recordingFetch(page);
    // No method at all means the default GET — still no body allowed.
    await expect(
      fetchHtmlOnce("https://a.example/", { fetch: impl, body: "{}" }),
    ).rejects.toBeInstanceOf(ConfigError);
    // Fetch normalizes method names to uppercase, so "get" IS GET.
    for (const method of ["GET", "HEAD", "get"]) {
      await expect(
        fetchHtmlOnce("https://a.example/", { fetch: impl, method, body: "{}" }),
      ).rejects.toBeInstanceOf(ConfigError);
    }
    expect(calls).toHaveLength(0);
  });

  it("still POSTs through fetchHtmlOnce — the seam the providers use", async () => {
    const { impl, calls } = recordingFetch(page);
    await fetchHtmlOnce("https://a.example/", { fetch: impl, method: "POST", body: "{}" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toBe("{}");
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
