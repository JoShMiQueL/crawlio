/**
 * `crawlio-mcp` bin coverage: the flag parser (`parseMcpBinArgs`) and a
 * REAL HTTP smoke — the bin's `--transport http` wiring factored into
 * `createCrawlioMcpHttpHandler`, exercised end-to-end over a loopback
 * `node:http` server with the SDK's own client transport.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { parseMcpBinArgs } from "../src/cli-args.js";
import { ConfigError } from "../src/index.js";
import { createCrawlioMcpHttpHandler, createCrawlioTools } from "../src/mcp-server.js";
import { readFixture } from "./fixtures.js";

type FetchImpl = typeof globalThis.fetch;

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };

/** Same helper as mcp.test.ts: serve `body`, 404 the politeness probes. */
function fixtureFetch(body: string, status = 200) {
  const impl: FetchImpl = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/robots.txt") || url.endsWith(".xml")) {
      return new Response("", { status: 404 });
    }
    return new Response(body, { status, headers: HTML_HEADERS });
  }) as FetchImpl;
  return impl;
}

describe("parseMcpBinArgs — the crawlio-mcp flags", () => {
  it("defaults to stdio on loopback:3000", () => {
    expect(parseMcpBinArgs([])).toEqual({
      transport: "stdio",
      host: "127.0.0.1",
      port: 3000,
      help: false,
    });
  });

  it("parses --transport http with --port/--host", () => {
    expect(parseMcpBinArgs(["--transport", "http", "--port", "8080", "--host", "0.0.0.0"])).toEqual(
      { transport: "http", host: "0.0.0.0", port: 8080, help: false },
    );
    // http without the flags keeps the http defaults.
    expect(parseMcpBinArgs(["--transport", "http"])).toMatchObject({
      transport: "http",
      host: "127.0.0.1",
      port: 3000,
    });
  });

  it("rejects --port/--host without --transport http", () => {
    expect(() => parseMcpBinArgs(["--port", "8080"])).toThrow(ConfigError);
    expect(() => parseMcpBinArgs(["--host", "0.0.0.0"])).toThrow(ConfigError);
    expect(() => parseMcpBinArgs(["--port", "8080"])).toThrow(/--transport http/);
    expect(() =>
      parseMcpBinArgs(["--transport", "stdio", "--port", "8080", "--host", "x"]),
    ).toThrow(/`--port`, `--host`/);
  });

  it("rejects a bad transport, bad port and stray positionals", () => {
    expect(() => parseMcpBinArgs(["--transport", "sse"])).toThrow(ConfigError);
    expect(() => parseMcpBinArgs(["--transport", "sse"])).toThrow(/"stdio" or "http"/);
    // The `--port=N` spelling — parseArgs itself rejects `--port -1`
    // (a dash-prefixed value reads as a missing argument), the same
    // treatment `--limit -1` gets on the `crawlio` CLI.
    for (const port of ["abc", "-1", "1.5", "70000"]) {
      expect(() => parseMcpBinArgs(["--transport", "http", `--port=${port}`])).toThrow(ConfigError);
    }
    expect(() => parseMcpBinArgs(["extra"])).toThrow(/positional/);
  });

  it("rejects --port 0 and a blank --host", () => {
    // Port 0 would bind an ephemeral port while the log prints `host:0`.
    expect(() => parseMcpBinArgs(["--transport", "http", "--port=0"])).toThrow(ConfigError);
    expect(() => parseMcpBinArgs(["--transport", "http", "--port=0"])).toThrow(
      /between 1 and 65535/,
    );
    // A blank host is the wildcard address to server.listen — `--host ""`
    // would bind every interface, defeating the loopback default.
    for (const host of ["", "   "]) {
      expect(() => parseMcpBinArgs(["--transport", "http", `--host=${host}`])).toThrow(ConfigError);
    }
    expect(() => parseMcpBinArgs(["--transport", "http", "--host="])).toThrow(/must not be blank/);
  });

  it("--help/-h short-circuits before validation", () => {
    expect(parseMcpBinArgs(["--help"]).help).toBe(true);
    expect(parseMcpBinArgs(["-h"]).help).toBe(true);
    // Even alongside flags that would otherwise be rejected.
    expect(parseMcpBinArgs(["--help", "--port", "abc", "extra"]).help).toBe(true);
  });
});

describe("createCrawlioMcpHttpHandler — real HTTP smoke", () => {
  it("serves initialize + tools/list + tools/call over loopback HTTP", async () => {
    const impl = fixtureFetch(readFixture("product-listing.html"));
    const tools = createCrawlioTools({ fetch: impl });
    const errors: Error[] = [];
    const handler = await createCrawlioMcpHttpHandler(tools, (error) => errors.push(error));
    const httpServer = createServer((req, res) => void handler(req, res));
    try {
      await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
      const { port } = httpServer.address() as AddressInfo;
      const client = new Client({ name: "test-client", version: "0.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
      try {
        await client.connect(transport);

        const list = await client.listTools();
        expect(list.tools.map((tool) => tool.name)).toEqual(["scrape", "map", "crawl", "search"]);

        const result = await client.callTool({
          name: "scrape",
          arguments: { url: "https://example.com/", fields: { title: "h1" } },
        });
        const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
        expect(JSON.parse(text as string)).toMatchObject({
          title: expect.stringContaining("Trail"),
        });

        // A second call proves the stateless per-request transport
        // survives reuse — the SDK refuses to re-serve a used one.
        const again = await client.callTool({
          name: "map",
          arguments: { url: "https://example.com/", limit: 2 },
        });
        expect(again.isError).not.toBe(true);
      } finally {
        await client.close();
      }
      expect(errors).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        // Force-close open connections right away — serveHttp ordering:
        // close() alone would wait for keep-alive connections to drain.
        httpServer.closeAllConnections();
      });
      await tools.close();
    }
  });
});
