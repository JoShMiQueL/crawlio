#!/usr/bin/env node
/**
 * `crawlio-mcp` — the MCP binary: exposes crawlio's `scrape`/`map`/`crawl`/
 * `search` tools to MCP clients (Claude Desktop, agents).
 *
 *   crawlio-mcp                                  stdio (default)
 *   crawlio-mcp --transport http [--port N] [--host H]
 *
 *   { "mcpServers": { "crawlio": { "command": "crawlio-mcp" } } }
 *   { "mcpServers": { "crawlio": { "type": "http", "url": "http://127.0.0.1:3000/mcp" } } }
 *
 * Renderer config is env-only: CRAWLIO_ENGINE=playwright|puppeteer (plus
 * CRAWLIO_BROWSER/CRAWLIO_CHANNEL/CRAWLIO_EXECUTABLE_PATH) or
 * CRAWLIO_RENDERER=<module specifier> for a custom adapter — see the
 * README's "MCP server" section. Tool logic lives in mcp-tools.ts, the
 * protocol wiring in mcp-server.ts and the flag parsing in cli-args.ts;
 * this file owns only process wiring: transports, the HTTP listener and
 * renderer shutdown on exit.
 */
import { createServer } from "node:http";
import { parseMcpBinArgs } from "./cli-args.js";
import {
  type CrawlioTools,
  createCrawlioMcpHttpHandler,
  createCrawlioMcpServer,
  createCrawlioTools,
} from "./mcp-server.js";
import { VERSION } from "./version.js";

const USAGE = `crawlio-mcp ${VERSION} — MCP server exposing crawlio's scrape/map/crawl/search tools

Usage:
  crawlio-mcp                              Serve over stdio (default — Claude Desktop)
  crawlio-mcp --transport http [options]   Serve over Streamable HTTP
  crawlio-mcp --help                       This help

Options:
  --transport stdio|http   Transport to serve (default: stdio).
  --host <H>               Bind address for --transport http (default:
                           127.0.0.1 — loopback only). Pass
                           --host 0.0.0.0 to expose the server to the
                           LAN/network; the default keeps it local.
  --port <N>               Port for --transport http (default: 3000).

  --port and --host require --transport http.

The HTTP endpoint is served on every path; http://<host>:<port>/mcp is
the conventional client URL.

Environment (renderer and search config — see the README "MCP server"
section):
  CRAWLIO_ENGINE, CRAWLIO_BROWSER, CRAWLIO_CHANNEL,
  CRAWLIO_EXECUTABLE_PATH, CRAWLIO_RENDERER
  BRAVE_API_KEY, SERPER_API_KEY, TAVILY_API_KEY
`;

/** Diagnostics go to stderr — in stdio mode stdout is the JSON-RPC channel. */
function logError(error: Error): void {
  process.stderr.write(`crawlio-mcp: ${error.message}\n`);
}

/**
 * Shared shutdown wiring: SIGINT/SIGTERM → release the shared renderer
 * (`tools.close()` is idempotent — the transport's onclose may already
 * have fired it; a throwing `renderer.close()` must not crash the
 * shutdown) → close the transport/http server → exit with the
 * conventional 128+signal code.
 */
function wireShutdown(tools: CrawlioTools, closeServer: () => Promise<void>): void {
  const onSignal = (code: number): void => {
    void tools
      .close()
      .catch(() => undefined)
      .then(() => closeServer())
      .catch(() => undefined)
      .then(() => process.exit(code));
  };
  process.on("SIGINT", () => onSignal(130));
  process.on("SIGTERM", () => onSignal(143));
}

/** stdio mode — one StdioServerTransport, stdout is the JSON-RPC channel. */
async function serveStdio(): Promise<void> {
  const { server, tools } = await createCrawlioMcpServer();
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");

  // Handlers attach BEFORE connect: a client that disconnects during the
  // handshake must still release the renderer, and transport/parse errors
  // must not be swallowed — stderr only, stdout is the JSON-RPC channel.
  // `server` is the high-level `McpServer`; onerror/onclose live on the
  // underlying `Server` it wraps.
  server.server.onerror = logError;
  server.server.onclose = () => {
    void tools.close().catch(() => undefined);
  };

  await server.connect(new StdioServerTransport());
  wireShutdown(tools, () => server.close());
}

/** http mode — a stateless Streamable HTTP endpoint on host:port. */
async function serveHttp(host: string, port: number): Promise<void> {
  const tools = createCrawlioTools();
  const handleRequest = await createCrawlioMcpHttpHandler(tools, logError);
  const httpServer = createServer((req, res) => {
    void handleRequest(req, res);
  });
  httpServer.on("error", logError);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolve);
  });
  // stderr even here — diagnostics never share a channel with traffic.
  process.stderr.write(`crawlio-mcp: listening on http://${host}:${port}/mcp\n`);
  wireShutdown(
    tools,
    () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        // Force-close open connections (long-lived SSE streams would
        // otherwise keep server.close() — and the process — alive).
        httpServer.closeAllConnections();
      }),
  );
}

async function main(argv: string[]): Promise<void> {
  const args = parseMcpBinArgs(argv);
  if (args.help) {
    process.stderr.write(USAGE);
    return;
  }
  if (args.transport === "http") {
    await serveHttp(args.host, args.port);
  } else {
    await serveStdio();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // stderr only — stdout is the JSON-RPC channel.
  process.stderr.write(`crawlio-mcp: ${message}\n`);
  process.exitCode = 1;
});
