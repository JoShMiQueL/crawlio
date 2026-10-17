/**
 * Protocol wiring for `crawlio-mcp`: binds the pure tool layer
 * ({@link createCrawlioTools}) onto an MCP `Server`.
 *
 * `@modelcontextprotocol/sdk` is an OPTIONAL peer dependency — it is
 * `import()`ed lazily here and nowhere else, so `import crawlio` (and the
 * `mcp-tools.js` helpers) never load it. This module is internal: the
 * server's only public surface is the `crawlio-mcp` binary, there is no
 * MCP subpath export.
 */
import type { Server } from "@modelcontextprotocol/sdk/server";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ConfigError } from "./errors.js";
import { type CrawlioTools, type CrawlioToolsDeps, createCrawlioTools } from "./mcp-tools.js";
import { VERSION } from "./version.js";

/** The pieces {@link createCrawlioMcpServer} wires together. */
export interface CrawlioMcpServer {
  /**
   * The protocol `Server` — `connect()` it to a transport (stdio in the
   * binary, `InMemoryTransport` in tests).
   */
  server: Server;
  /**
   * The tool layer — call {@link CrawlioTools.close} on shutdown to release
   * the shared renderer.
   */
  tools: CrawlioTools;
}

/**
 * Build the MCP server: a low-level `Server` (not `McpServer` — that API
 * validates inputs through zod schemas, which this package deliberately does
 * not depend on; tools advertise plain JSON Schemas and validate `arguments`
 * themselves). Handlers for `tools/list` and `tools/call` delegate to
 * {@link CrawlioTools}.
 *
 * A missing/unloadable `@modelcontextprotocol/sdk` surfaces as a
 * {@link ConfigError} naming the install — the same treatment the engine
 * adapters give a missing `playwright-core`/`puppeteer-core`.
 */
export async function createCrawlioMcpServer(
  deps: CrawlioToolsDeps = {},
): Promise<CrawlioMcpServer> {
  let ServerCtor: typeof Server;
  let schemas: typeof import("@modelcontextprotocol/sdk/types.js");
  try {
    const [serverModule, typesModule] = await Promise.all([
      import("@modelcontextprotocol/sdk/server"),
      import("@modelcontextprotocol/sdk/types.js"),
    ]);
    ServerCtor = serverModule.Server;
    schemas = typesModule;
  } catch (cause) {
    throw new ConfigError(
      "`crawlio-mcp` needs the optional peer `@modelcontextprotocol/sdk` — install it with `pnpm add @modelcontextprotocol/sdk`",
      { cause },
    );
  }

  const tools = createCrawlioTools(deps);
  const server = new ServerCtor(
    { name: "crawlio", version: VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(schemas.ListToolsRequestSchema, () => ({
    tools: [...tools.definitions],
  }));
  server.setRequestHandler(
    schemas.CallToolRequestSchema,
    (request): Promise<CallToolResult> => tools.call(request.params.name, request.params.arguments),
  );
  return { server, tools };
}
