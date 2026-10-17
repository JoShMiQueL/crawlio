/**
 * Protocol wiring for `crawlio-mcp`: binds the pure tool layer
 * ({@link createCrawlioTools}) onto the SDK's high-level `McpServer`.
 *
 * `@modelcontextprotocol/sdk` is an OPTIONAL peer dependency — it is
 * `import()`ed lazily here and nowhere else, so `import crawlio` (and the
 * `mcp-tools.js` helpers) never load it. `zod` rides along in the same
 * lazy import: the SDK's own peer contract marks it required
 * (`peerDependenciesMeta.optional: false`) and `McpServer.registerTool`
 * validates `arguments` through zod schemas. This module is the
 * `crawlio/mcp` subpath export — the programmatic surface the
 * `crawlio-mcp` binary is built on; importing it works without the peers
 * installed, and a missing install only fails inside
 * {@link createCrawlioMcpServer}.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ConfigError } from "./errors.js";
import { type CrawlioTools, type CrawlioToolsDeps, createCrawlioTools } from "./mcp-tools.js";
import { VERSION } from "./version.js";

// The `crawlio/mcp` subpath is this module — re-export the tool layer so
// embedders get the full surface (tools + resolvers + types) from the one
// entrypoint, without touching `mcp-tools.js` internals.
export type {
  ClosableRenderer,
  CrawlioTools,
  CrawlioToolsDeps,
  McpToolDefinition,
  McpToolResult,
} from "./mcp-tools.js";
export {
  createCrawlioTools,
  parseJsonFields,
  resolveEnvRenderer,
  resolveMcpSearchProvider,
} from "./mcp-tools.js";

/** The pieces {@link createCrawlioMcpServer} wires together. */
export interface CrawlioMcpServer {
  /**
   * The high-level `McpServer` — `connect()` it to a transport (stdio in
   * the binary, `InMemoryTransport` in tests). Low-level hooks
   * (`onerror`/`onclose`, `setRequestHandler`) live on the underlying
   * `Server` at `server.server`.
   */
  server: McpServer;
  /**
   * The tool layer — call {@link CrawlioTools.close} on shutdown to release
   * the shared renderer.
   */
  tools: CrawlioTools;
}

type Zod = typeof import("zod").z;

/**
 * The tools' argument schemas as STRICT zod objects — `registerTool`
 * accepts `AnySchema`, and the SDK uses them both for `arguments`
 * validation and `tools/list` JSON-Schema generation. One schema per
 * `TOOL_DEFINITIONS` entry, matching the declared field names, types and
 * `required` exactly; the in-memory protocol test asserts this table
 * cannot drift from `definitions`.
 *
 * Why `.strict()`: a raw shape would be wrapped in `z.object(...)`, which
 * STRIPS unknown keys — a typo'd argument (`feilds` for `fields`) would
 * silently vanish and the tool would run on defaults, producing silently
 * wrong output. A strict object makes validation reject unknown keys,
 * matching `TOOL_DEFINITIONS`' declared `additionalProperties: false` and
 * the handlers' own unknown-argument rejection. `.strict()` exists on the
 * `ZodObject` of both zod v3 and v4 — the peer range allows both.
 */
function toolInputSchemas(z: Zod): Record<string, AnySchema> {
  const url = (description: string) => z.string().describe(description);
  const count = (description: string) => z.number().int().min(0).optional().describe(description);
  return {
    scrape: z
      .object({
        url: url("The page URL (http/https)."),
        fields: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Field spec: name → selector string or { selector, attr?, all? }."),
        render: z.enum(["auto", "always"]).optional(),
      })
      .strict(),
    map: z
      .object({
        url: url("The seed URL (http/https)."),
        limit: count("Maximum URLs returned."),
      })
      .strict(),
    crawl: z
      .object({
        url: url("The seed URL (http/https)."),
        maxDepth: count("Link distance from the seed (default 2)."),
        maxPages: count("Hard cap on pages fetched (default 50)."),
      })
      .strict(),
    search: z
      .object({
        query: z.string().describe("The search query."),
        provider: z.string().optional().describe("Built-in name or adapter module specifier."),
        limit: count("Maximum results returned."),
      })
      .strict(),
  };
}

/**
 * Build the MCP server: the high-level `McpServer`, registering one tool
 * per `tools.definitions` entry — description from the definition,
 * `inputSchema` from {@link toolInputSchemas}. `McpServer` validates
 * `arguments` against the zod shape first; the handlers still run their
 * own validation (the pure layer is also reachable without a protocol, so
 * it cannot rely on zod having run). Any failure surfaces as an `isError`
 * result, never a thrown exception.
 *
 * A missing/unloadable `@modelcontextprotocol/sdk` or `zod` surfaces as a
 * {@link ConfigError} naming the install — the same treatment the engine
 * adapters give a missing `playwright-core`/`puppeteer-core`.
 */
export async function createCrawlioMcpServer(
  deps: CrawlioToolsDeps = {},
): Promise<CrawlioMcpServer> {
  let McpServerCtor: typeof McpServer;
  let z: Zod;
  try {
    const [serverModule, zodModule] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/mcp.js"),
      import("zod"),
    ]);
    McpServerCtor = serverModule.McpServer;
    z = zodModule.z;
  } catch (cause) {
    throw new ConfigError(
      "`crawlio-mcp` needs the optional peers `@modelcontextprotocol/sdk` and `zod` — install them with `pnpm add @modelcontextprotocol/sdk zod`",
      { cause },
    );
  }

  const tools = createCrawlioTools(deps);
  const schemas = toolInputSchemas(z);
  const server = new McpServerCtor({ name: "crawlio", version: VERSION });
  for (const def of tools.definitions) {
    const inputSchema = schemas[def.name];
    if (inputSchema === undefined) {
      throw new Error(
        `No input schema for tool ${JSON.stringify(def.name)} — toolInputSchemas drifted from TOOL_DEFINITIONS`,
      );
    }
    server.registerTool(
      def.name,
      { description: def.description, inputSchema },
      (args: unknown): Promise<CallToolResult> => tools.call(def.name, args),
    );
  }
  return { server, tools };
}
