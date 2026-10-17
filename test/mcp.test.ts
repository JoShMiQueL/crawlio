import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "../src/index.js";
import * as mcpSubpath from "../src/mcp-server.js";
import { createCrawlioMcpServer } from "../src/mcp-server.js";
import {
  type ClosableRenderer,
  type CrawlioTools,
  createCrawlioTools,
  parseJsonFields,
  resolveEnvRenderer,
  resolveMcpSearchProvider,
} from "../src/mcp-tools.js";
import { readFixture } from "./fixtures.js";

type FetchImpl = typeof globalThis.fetch;

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };

/**
 * A fetch mock that serves `body` for page requests but 404s robots.txt and
 * sitemap documents — the tools don't expose `robots`, so the mock turns the
 * politeness probes into their allow-all/absent fallbacks instead.
 */
function fixtureFetch(body: string, status = 200) {
  const calls: Array<{ input: unknown }> = [];
  const impl: FetchImpl = (async (input: unknown) => {
    calls.push({ input });
    const url = String(input);
    if (url.endsWith("/robots.txt") || url.endsWith(".xml")) {
      return new Response("", { status: 404 });
    }
    return new Response(body, { status, headers: HTML_HEADERS });
  }) as FetchImpl;
  return { impl, calls };
}

/** Extract the text of a successful tool result and parse it as JSON. */
function resultJson(result: { content: Array<{ type: string; text: string }> }): unknown {
  expect(result).not.toMatchObject({ isError: true });
  const text = result.content[0]?.text;
  expect(typeof text).toBe("string");
  return JSON.parse(text as string);
}

/** Extract the message of an error tool result. */
function errorText(result: { isError?: boolean; content: Array<{ text: string }> }): string {
  expect(result.isError).toBe(true);
  const text = result.content[0]?.text;
  expect(typeof text).toBe("string");
  return text as string;
}

let tmpDir: string | undefined;
const toolsToClose: CrawlioTools[] = [];
afterEach(async () => {
  for (const tools of toolsToClose.splice(0)) await tools.close();
  if (tmpDir !== undefined) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

function makeTools(deps: Parameters<typeof createCrawlioTools>[0]): CrawlioTools {
  const tools = createCrawlioTools(deps);
  toolsToClose.push(tools);
  return tools;
}

/** Write a temp .mjs adapter fixture and return its absolute-path specifier. */
function adapterFixture(name: string, source: string): string {
  tmpDir ??= mkdtempSync(join(tmpdir(), "crawlio-mcp-"));
  const file = join(tmpDir, name);
  writeFileSync(file, source);
  return file;
}

describe("parseJsonFields — the JSON-shape fields validator", () => {
  it("accepts selector strings and { selector, attr, all } objects", () => {
    expect(
      parseJsonFields({
        title: "h1",
        links: { selector: "a", attr: "href", all: true },
        note: { selector: "p", all: false },
      }),
    ).toEqual({
      title: "h1",
      links: { selector: "a", attr: "href", all: true },
      note: { selector: "p", all: false },
    });
  });

  it("rejects a non-object fields argument and empty specs", () => {
    expect(() => parseJsonFields("h1")).toThrow(ConfigError);
    expect(() => parseJsonFields([])).toThrow(ConfigError);
    expect(() => parseJsonFields({})).toThrow(ConfigError);
    expect(() => parseJsonFields({ "": "h1" })).toThrow(ConfigError);
    expect(() => parseJsonFields({ title: "" })).toThrow(ConfigError);
    expect(() => parseJsonFields({ title: 42 })).toThrow(ConfigError);
  });

  it("rejects object specs with a bad selector/attr/all", () => {
    expect(() => parseJsonFields({ t: {} })).toThrow(ConfigError);
    expect(() => parseJsonFields({ t: { selector: " " } })).toThrow(ConfigError);
    expect(() => parseJsonFields({ t: { selector: "h1", attr: 3 } })).toThrow(ConfigError);
    expect(() => parseJsonFields({ t: { selector: "h1", all: "yes" } })).toThrow(ConfigError);
    expect(() => parseJsonFields({ t: { selector: "h1", attrs: "href" } })).toThrow(ConfigError);
  });

  it("rejects `transform` — functions cannot cross JSON", () => {
    expect(() => parseJsonFields({ t: { selector: "h1", transform: "parseFloat" } })).toThrow(
      ConfigError,
    );
    expect(() => parseJsonFields({ t: { selector: "h1", transform: "x" } })).toThrow(/transform/);
  });
});

describe("resolveEnvRenderer — CRAWLIO_* env config", () => {
  it("returns undefined when no renderer env is set", async () => {
    await expect(resolveEnvRenderer({})).resolves.toBeUndefined();
  });

  it("rejects an unknown CRAWLIO_ENGINE", async () => {
    await expect(resolveEnvRenderer({ CRAWLIO_ENGINE: "webkit" })).rejects.toThrow(ConfigError);
    await expect(resolveEnvRenderer({ CRAWLIO_ENGINE: "webkit" })).rejects.toThrow(
      /CRAWLIO_ENGINE/,
    );
  });

  it("autodetects the engine for engine-scoped vars without CRAWLIO_ENGINE", async () => {
    // The CLI's `--render` without `--engine` fallback: playwright when
    // `playwright-core` is importable (it is, in this dev install), else
    // puppeteer. Construction is lazy — no browser launches.
    for (const env of [
      { CRAWLIO_BROWSER: "firefox" },
      { CRAWLIO_CHANNEL: "chrome" },
      { CRAWLIO_EXECUTABLE_PATH: "/bin/x" },
    ]) {
      const renderer = await resolveEnvRenderer(env);
      expect(typeof renderer?.render).toBe("function");
      await renderer?.close?.();
    }
  });

  it("rejects CRAWLIO_RENDERER combined with engine-scoped vars", async () => {
    await expect(
      resolveEnvRenderer({ CRAWLIO_RENDERER: "./x.mjs", CRAWLIO_ENGINE: "playwright" }),
    ).rejects.toThrow(/CRAWLIO_RENDERER/);
  });

  it("rejects CRAWLIO_BROWSER under the puppeteer engine", async () => {
    await expect(
      resolveEnvRenderer({ CRAWLIO_ENGINE: "puppeteer", CRAWLIO_BROWSER: "firefox" }),
    ).rejects.toThrow(ConfigError);
  });

  it("builds an engine renderer for CRAWLIO_ENGINE=puppeteer", async () => {
    // Construction is lazy — no browser launches until the first render().
    const renderer = await resolveEnvRenderer({ CRAWLIO_ENGINE: "puppeteer" });
    expect(typeof renderer?.render).toBe("function");
    await renderer?.close?.();
  });

  it("loads a module specifier through CRAWLIO_RENDERER", async () => {
    const specifier = adapterFixture(
      "renderer.mjs",
      'export const renderer = { async render(url) { return { url, html: "<p>hi</p>" }; } };',
    );
    const renderer = await resolveEnvRenderer({ CRAWLIO_RENDERER: specifier });
    expect(typeof renderer?.render).toBe("function");
    const page = await renderer?.render("https://example.com/");
    expect(page?.html).toBe("<p>hi</p>");
  });
});

describe("resolveMcpSearchProvider — CLI precedence", () => {
  it("keeps explicit built-in names and env autodetect order", async () => {
    await expect(resolveMcpSearchProvider("brave", {})).resolves.toBe("brave");
    await expect(resolveMcpSearchProvider("tavily", {})).resolves.toBe("tavily");
    await expect(resolveMcpSearchProvider(undefined, { SERPER_API_KEY: "k" })).resolves.toBe(
      "serper",
    );
    await expect(
      resolveMcpSearchProvider(undefined, { SERPER_API_KEY: "s", TAVILY_API_KEY: "t" }),
    ).resolves.toBe("serper");
    // An explicit name wins over env autodetect.
    await expect(resolveMcpSearchProvider("tavily", { BRAVE_API_KEY: "k" })).resolves.toBe(
      "tavily",
    );
  });

  it("errors naming all three env vars when nothing resolves", async () => {
    await expect(resolveMcpSearchProvider(undefined, {})).rejects.toThrow(
      /BRAVE_API_KEY.*SERPER_API_KEY.*TAVILY_API_KEY/,
    );
  });
});

describe("createCrawlioTools — tool handlers", () => {
  it("lists exactly the scrape/map/crawl/search tools", () => {
    const tools = makeTools({});
    expect(tools.definitions.map((d) => d.name)).toEqual(["scrape", "map", "crawl", "search"]);
    for (const def of tools.definitions) {
      expect(def.inputSchema).toMatchObject({ type: "object" });
    }
  });

  it("scrape returns the extracted fields as JSON text", async () => {
    const { impl } = fixtureFetch(readFixture("product-listing.html"));
    const tools = makeTools({ fetch: impl });
    const result = await tools.call("scrape", {
      url: "https://example.com/listing",
      fields: { title: "h1", names: { selector: ".product-name", all: true } },
    });
    const data = resultJson(result) as { title: string; names: string[] };
    expect(data.title).toContain("Trail");
    expect(data.names.length).toBeGreaterThan(1);
    expect(data.names[0]).toContain("Trail Shell");
  });

  it("scrape defaults fields to { title: 'title' }", async () => {
    const { impl } = fixtureFetch(readFixture("product-listing.html"));
    const tools = makeTools({ fetch: impl });
    const data = resultJson(await tools.call("scrape", { url: "https://example.com/" })) as {
      title: string;
    };
    expect(data.title).toContain("Trail");
  });

  it("maps argument and fields validation failures to isError results", async () => {
    const tools = makeTools({});
    expect(errorText(await tools.call("scrape", {}))).toMatch(/`url`/);
    expect(
      errorText(
        await tools.call("scrape", { url: "https://x.test/", fields: { t: { transform: 1 } } }),
      ),
    ).toMatch(/transform/);
    expect(errorText(await tools.call("map", { url: "https://x.test/", limit: -1 }))).toMatch(
      /`limit`/,
    );
    expect(errorText(await tools.call("map", { url: "https://x.test/", limit: "5" }))).toMatch(
      /`limit`/,
    );
    expect(errorText(await tools.call("crawl", { url: "https://x.test/", depth: 1 }))).toMatch(
      /Unknown argument/,
    );
    expect(errorText(await tools.call("nope", {}))).toMatch(/Unknown tool/);
    expect(errorText(await tools.call("scrape", "nope"))).toMatch(/arguments/);
    // An omitted `arguments` falls through to the tool's own validation.
    expect(errorText(await tools.call("scrape", undefined))).toMatch(/`url`/);
    expect(errorText(await tools.call("search", undefined))).toMatch(/`query`/);
  });

  it("maps a ScrapeError to isError with the message — never a stack", async () => {
    // 404 is non-retryable (the shared policy retries 408/429/5xx only), so
    // the HttpError surfaces immediately.
    const { impl } = fixtureFetch("nope", 404);
    const tools = makeTools({ fetch: impl });
    const text = errorText(await tools.call("scrape", { url: "https://example.com/" }));
    expect(text).toMatch(/404/);
    expect(text).not.toMatch(/\n\s*at /);
  });

  it("renders via the shared injected renderer when render is requested", async () => {
    // The static path serves a page whose `title` misses; the renderer
    // serves the "real" DOM. render: "always" skips the static fetch.
    const { impl, calls } = fixtureFetch("<html><body><h1>static</h1></body></html>");
    const render = vi.fn(async (url: string) => ({
      url,
      html: "<html><body><h1>rendered</h1></body></html>",
    }));
    const close = vi.fn(async () => undefined);
    const loadRenderer = vi.fn(async () => ({ render, close }));
    const tools = makeTools({ fetch: impl, loadRenderer });
    const data = resultJson(
      await tools.call("scrape", {
        url: "https://spa.test/",
        fields: { title: "h1" },
        render: "always",
      }),
    ) as { title: string };
    expect(data.title).toBe("rendered");
    expect(render).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1); // robots.txt probe only — no static page fetch
    // The renderer is loaded once and shared: a second render call reuses it.
    await tools.call("scrape", { url: "https://spa.test/2", render: "always" });
    expect(loadRenderer).toHaveBeenCalledOnce();
    await tools.close();
    expect(close).toHaveBeenCalledOnce();
    await tools.close(); // idempotent
    expect(close).toHaveBeenCalledOnce();
  });

  it("errors clearly when render is requested with no configured renderer", async () => {
    const { impl } = fixtureFetch("<html></html>");
    const tools = makeTools({ fetch: impl, env: {} });
    for (const render of ["auto", "always"]) {
      const text = errorText(await tools.call("scrape", { url: "https://x.test/", render }));
      expect(text).toMatch(/CRAWLIO_ENGINE|CRAWLIO_RENDERER/);
    }
    // And `render` still validates before renderer resolution.
    expect(
      errorText(await tools.call("scrape", { url: "https://x.test/", render: "maybe" })),
    ).toMatch(/"auto" or "always"/);
  });

  it("resolves the renderer lazily and never resolves it just to close", async () => {
    const { impl } = fixtureFetch("<html><body><h1>x</h1></body></html>");
    const loadRenderer = vi.fn(async () => undefined);
    const tools = makeTools({ fetch: impl, loadRenderer });
    await tools.call("scrape", { url: "https://x.test/" });
    // scrape consults the loader (to know whether a renderer exists) ...
    expect(loadRenderer).toHaveBeenCalledOnce();
    // ... but close() must not trigger a resolution on an idle instance.
    const idle = createCrawlioTools({ loadRenderer });
    await idle.close();
    expect(loadRenderer).toHaveBeenCalledOnce();
  });

  it("does not cache a failed renderer resolution — the next call retries", async () => {
    const { impl } = fixtureFetch("<html><body><h1>static</h1></body></html>");
    const loadRenderer = vi
      .fn<() => Promise<ClosableRenderer | undefined>>()
      .mockRejectedValueOnce(new ConfigError("engine missing"))
      .mockResolvedValue({
        render: async (url: string) => ({
          url,
          html: "<html><body><h1>rendered</h1></body></html>",
        }),
      });
    const tools = makeTools({ fetch: impl, loadRenderer });
    // First call: the bad resolution surfaces as an isError result ...
    expect(
      errorText(await tools.call("scrape", { url: "https://x.test/", render: "always" })),
    ).toMatch(/engine missing/);
    // ... but the rejection is NOT the memo — the next call retries and wins.
    const data = resultJson(
      await tools.call("scrape", {
        url: "https://x.test/",
        fields: { title: "h1" },
        render: "always",
      }),
    ) as { title: string };
    expect(data.title).toBe("rendered");
    expect(loadRenderer).toHaveBeenCalledTimes(2);
  });

  it("close() after a failed resolution does not throw or retry", async () => {
    const loadRenderer = vi
      .fn<() => Promise<ClosableRenderer | undefined>>()
      .mockRejectedValue(new ConfigError("engine missing"));
    const tools = makeTools({ loadRenderer });
    await tools.call("scrape", { url: "https://x.test/", render: "always" });
    await expect(tools.close()).resolves.toBeUndefined();
    expect(loadRenderer).toHaveBeenCalledOnce();
  });

  it("map discovers same-origin links from the seed page", async () => {
    const { impl } = fixtureFetch(readFixture("product-listing.html"));
    const tools = makeTools({ fetch: impl });
    const data = resultJson(await tools.call("map", { url: "https://example.com/", limit: 3 })) as {
      urls: Array<{ url: string }>;
      source: string;
    };
    expect(data.source).toBe("links");
    expect(data.urls.length).toBeGreaterThan(0);
    expect(data.urls.length).toBeLessThanOrEqual(3);
    expect(data.urls[0]?.url).toMatch(/^https:\/\/example\.com\//);
  });

  it("crawl returns pages in BFS order with visit counts", async () => {
    const { impl } = fixtureFetch(readFixture("product-listing.html"));
    const tools = makeTools({ fetch: impl });
    const data = resultJson(
      await tools.call("crawl", { url: "https://example.com/", maxDepth: 0 }),
    ) as { pages: Array<{ url: string; depth: number }>; visited: number };
    expect(data.visited).toBe(1);
    expect(data.pages).toHaveLength(1);
    expect(data.pages[0]).toMatchObject({ url: "https://example.com/", depth: 0 });
  });

  it("search delegates to an injected provider and enforces limit", async () => {
    const provider = {
      search: vi.fn(async () => [
        { url: "https://a.test/", title: "A" },
        { url: "https://b.test/" },
      ]),
    };
    const tools = makeTools({ provider });
    const data = resultJson(await tools.call("search", { query: "crawlio", limit: 1 })) as Array<{
      url: string;
    }>;
    expect(provider.search).toHaveBeenCalledOnce();
    expect(data).toEqual([{ url: "https://a.test/", title: "A" }]);
  });

  it("search errors without a provider or provider env vars", async () => {
    const tools = makeTools({ env: {} });
    const text = errorText(await tools.call("search", { query: "crawlio" }));
    expect(text).toMatch(/BRAVE_API_KEY/);
  });

  it("search limit 0 returns [] without resolving a provider at all", async () => {
    // `search()` resolves its provider LAST — after the `limit: 0`
    // short-circuit — so a zero-limit call must not demand an API key.
    const tools = makeTools({ env: {} });
    const data = resultJson(await tools.call("search", { query: "crawlio", limit: 0 }));
    expect(data).toEqual([]);
  });
});

describe("the `crawlio/mcp` subpath module — the embeddable surface", () => {
  it("re-exports the whole tool layer from mcp-server.js", () => {
    // src/mcp-server.js is what `./mcp` in package.json exports points at —
    // pin that every embeddable helper is reachable through it (the
    // type-only exports — CrawlioTools, McpToolDefinition, ... — are
    // compile-time surface and cannot be asserted at runtime).
    expect(mcpSubpath.createCrawlioMcpServer).toBe(createCrawlioMcpServer);
    expect(mcpSubpath.createCrawlioTools).toBe(createCrawlioTools);
    expect(mcpSubpath.resolveEnvRenderer).toBe(resolveEnvRenderer);
    expect(mcpSubpath.resolveMcpSearchProvider).toBe(resolveMcpSearchProvider);
    expect(mcpSubpath.parseJsonFields).toBe(parseJsonFields);
  });
});

describe("protocol smoke — real Server over InMemoryTransport", () => {
  it("lists tools and serves tools/call end to end", async () => {
    const { impl } = fixtureFetch(readFixture("product-listing.html"));
    const { server, tools } = await createCrawlioMcpServer({ fetch: impl });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      const list = await client.listTools();
      expect(list.tools.map((tool) => tool.name)).toEqual(["scrape", "map", "crawl", "search"]);
      const scrapeTool = list.tools.find((tool) => tool.name === "scrape");
      expect(scrapeTool?.inputSchema).toMatchObject({
        type: "object",
        required: ["url"],
      });

      const result = await client.callTool({
        name: "scrape",
        arguments: { url: "https://example.com/", fields: { title: "h1" } },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
      expect(JSON.parse(text as string)).toMatchObject({ title: expect.stringContaining("Trail") });

      const failed = await client.callTool({ name: "search", arguments: {} });
      expect(failed.isError).toBe(true);
      const failedText = (failed.content as Array<{ text: string }>)[0]?.text;
      expect(failedText).toMatch(/`query`/);
    } finally {
      await client.close();
      await server.close();
      await tools.close();
    }
  });

  it("runs tools.close() on transport close — a throwing renderer.close() does not crash", async () => {
    const rendererClose = vi.fn(async (): Promise<void> => {
      throw new Error("browser exploded");
    });
    const loadRenderer = vi.fn(
      async (): Promise<ClosableRenderer> => ({
        render: async (url: string) => ({ url, html: "<p>x</p>" }),
        close: rendererClose,
      }),
    );
    const { impl } = fixtureFetch("<html></html>");
    const { server, tools } = await createCrawlioMcpServer({ fetch: impl, loadRenderer });
    // The mcp.ts wiring: onclose releases the shared renderer and must
    // survive a throwing renderer.close() — an unhandled rejection on
    // transport close crashes the process.
    server.onclose = () => {
      void tools.close().catch(() => undefined);
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      // Resolve the renderer once so close() has something to release.
      await client.callTool({
        name: "scrape",
        arguments: { url: "https://x.test/", render: "always" },
      });
      // Closing one end of the linked pair closes the other → server.onclose.
      await client.close();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rendererClose).toHaveBeenCalledOnce();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await server.close();
    }
  });
});
