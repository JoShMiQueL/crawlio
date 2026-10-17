#!/usr/bin/env node
/**
 * `crawlio-mcp` — the MCP binary: exposes crawlio's `scrape`/`map`/`crawl`/
 * `search` tools to MCP clients (Claude Desktop, agents) over stdio.
 *
 *   { "mcpServers": { "crawlio": { "command": "crawlio-mcp" } } }
 *
 * Renderer config is env-only: CRAWLIO_ENGINE=playwright|puppeteer (plus
 * CRAWLIO_BROWSER/CRAWLIO_CHANNEL/CRAWLIO_EXECUTABLE_PATH) or
 * CRAWLIO_RENDERER=<module specifier> for a custom adapter — see the
 * README's "MCP server" section. Tool logic lives in mcp-tools.ts and the
 * protocol wiring in mcp-server.ts; this file owns only process wiring:
 * the stdio transport and renderer shutdown on exit.
 */
import { createCrawlioMcpServer } from "./mcp-server.js";

async function main(): Promise<void> {
  const { server, tools } = await createCrawlioMcpServer();
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");

  // Handlers attach BEFORE connect: a client that disconnects during the
  // handshake must still release the renderer, and transport/parse errors
  // must not be swallowed — stderr only, stdout is the JSON-RPC channel.
  server.onerror = (error) => {
    process.stderr.write(`crawlio-mcp: ${error.message}\n`);
  };
  // One lazy renderer is shared by every tool call — release it whenever
  // the server goes away: a transport close (stdin EOF, client exit) or a
  // signal. `tools.close()` is idempotent, so onclose + the signal path may
  // both fire it; a throwing renderer.close() must not crash the shutdown.
  server.onclose = () => {
    void tools.close().catch(() => undefined);
  };

  await server.connect(new StdioServerTransport());

  const onSignal = (code: number): void => {
    void tools
      .close()
      .catch(() => undefined)
      .then(() => server.close())
      .catch(() => undefined)
      .then(() => process.exit(code));
  };
  process.on("SIGINT", () => onSignal(130));
  process.on("SIGTERM", () => onSignal(143));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // stderr only — stdout is the JSON-RPC channel.
  process.stderr.write(`crawlio-mcp: ${message}\n`);
  process.exitCode = 1;
});
