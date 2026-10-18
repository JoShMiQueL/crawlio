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
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ConfigError } from "./errors.js";
import { type CrawlioTools, type CrawlioToolsDeps, createCrawlioTools } from "./mcp-tools.js";
import { SEARCH_PROVIDER_NAMES } from "./search.js";
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
        // Enum-only on the MCP surface — a client's `provider` argument is
        // remote input, so the module-specifier loader (CLI-only) is not
        // offered here; see resolveMcpSearchProvider.
        provider: z.enum(SEARCH_PROVIDER_NAMES).optional().describe("A built-in provider name."),
        limit: count("Maximum results returned."),
      })
      .strict(),
  };
}

/** The lazily-imported peers {@link buildMcpServer} needs. */
interface McpPeers {
  McpServerCtor: typeof McpServer;
  z: Zod;
}

/**
 * Import the optional peers. A missing/unloadable
 * `@modelcontextprotocol/sdk` or `zod` surfaces as a {@link ConfigError}
 * naming the install — the same treatment the engine adapters give a
 * missing `playwright-core`/`puppeteer-core`.
 */
async function loadMcpPeers(): Promise<McpPeers> {
  try {
    const [serverModule, zodModule] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/mcp.js"),
      import("zod"),
    ]);
    return { McpServerCtor: serverModule.McpServer, z: zodModule.z };
  } catch (cause) {
    throw new ConfigError(
      "`crawlio-mcp` needs the optional peers `@modelcontextprotocol/sdk` and `zod` — install them (e.g. `npm install @modelcontextprotocol/sdk zod`)",
      { cause },
    );
  }
}

/**
 * Build a fresh `McpServer` bound to `tools`: one registered tool per
 * `tools.definitions` entry — description from the definition,
 * `inputSchema` from {@link toolInputSchemas}. `McpServer` validates
 * `arguments` against the zod shape first; the handlers still run their
 * own validation (the pure layer is also reachable without a protocol, so
 * it cannot rely on zod having run). Any failure surfaces as an `isError`
 * result, never a thrown exception.
 *
 * Fresh per call: a `Protocol` accepts exactly one `connect()` at a time,
 * so the stateless HTTP path builds one server per request — all of them
 * bound to the same shared `tools`.
 */
function buildMcpServer(peers: McpPeers, tools: CrawlioTools): McpServer {
  const schemas = toolInputSchemas(peers.z);
  const server = new peers.McpServerCtor({ name: "crawlio", version: VERSION });
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
  return server;
}

/**
 * Build the MCP server: the high-level `McpServer` with every tool
 * registered ({@link buildMcpServer}) plus the shared tool layer — the
 * `crawlio-mcp --transport stdio` wiring, and the stdio/in-memory
 * embedding path.
 */
export async function createCrawlioMcpServer(
  deps: CrawlioToolsDeps = {},
): Promise<CrawlioMcpServer> {
  const peers = await loadMcpPeers();
  const tools = createCrawlioTools(deps);
  return { server: buildMcpServer(peers, tools), tools };
}

/** A `node:http` request handler — what {@link createCrawlioMcpHttpHandler} returns. */
export type CrawlioMcpHttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/**
 * Build a `node:http` request handler serving MCP over the Streamable
 * HTTP transport — the `crawlio-mcp --transport http` wiring:
 *
 *   createServer((req, res) => void handler(req, res)).listen(port, host)
 *
 * STATELESS: `sessionIdGenerator: undefined` — no `Mcp-Session-Id`
 * header, no session validation. The scraper holds no per-session state,
 * and sessions would only pin the shared lazy renderer to a session
 * lifetime, so there is nothing to key a session on.
 *
 * SDK 1.32's stateless transport refuses reuse ("Stateless transport
 * cannot be reused across requests" — reusing it collides JSON-RPC
 * message ids between clients), so EACH request builds a fresh transport
 * AND a fresh `McpServer` ({@link buildMcpServer}) bound to the shared
 * `tools` — the lazy renderer is still resolved once for the whole
 * listener, not once per request. The handler is path-agnostic (the
 * transport dispatches on method and headers, not URL); `/mcp` is merely
 * the conventional client URL. `onError` receives transport/handler
 * errors — the bin pipes it to stderr.
 */
export async function createCrawlioMcpHttpHandler(
  tools: CrawlioTools,
  onError: (error: Error) => void = () => undefined,
): Promise<CrawlioMcpHttpHandler> {
  const peers = await loadMcpPeers();
  let StreamableHTTPServerTransportCtor: typeof import("@modelcontextprotocol/sdk/server/streamableHttp.js").StreamableHTTPServerTransport;
  try {
    ({ StreamableHTTPServerTransport: StreamableHTTPServerTransportCtor } = await import(
      "@modelcontextprotocol/sdk/server/streamableHttp.js"
    ));
  } catch (cause) {
    throw new ConfigError(
      "`crawlio-mcp --transport http` needs the optional peer `@modelcontextprotocol/sdk` — install it (e.g. `npm install @modelcontextprotocol/sdk zod`)",
      { cause },
    );
  }

  return async (req, res) => {
    try {
      // Construction lives inside the try too: a throwing transport or
      // `buildMcpServer` must degrade to a 500 + onError, not an
      // unhandled rejection taking the whole listener down.
      const transport = new StreamableHTTPServerTransportCtor({
        sessionIdGenerator: undefined,
      });
      const server = buildMcpServer(peers, tools);
      server.server.onerror = onError;
      // Release the per-request server+transport when the response is
      // done: `close` fires on completion (or an early connection drop),
      // and `server.close()` closes the transport it is connected to.
      res.on("close", () => {
        void server.close().catch(() => undefined);
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    }
  };
}

/** A fetch-style request handler — what {@link createCrawlioMcpFetchHandler} returns. */
export type CrawlioMcpFetchHandler = (req: Request) => Promise<Response>;

/**
 * The fetch-style sibling of {@link createCrawlioMcpHttpHandler} — the same
 * stateless Streamable HTTP endpoint, shaped `(req: Request) => Response`
 * for `Bun.serve` (and any other fetch-style server):
 *
 *   Bun.serve({ port, hostname: host, fetch: handler })
 *
 * It binds the SDK's `WebStandardStreamableHTTPServerTransport` — the web
 * standard `Request`/`Response`/`ReadableStream` core that the `node:http`
 * transport wraps. Same stateless rule: `sessionIdGenerator: undefined`,
 * and a fresh transport + `McpServer` per request (SDK 1.32's stateless
 * transport still refuses reuse), all bound to the shared `tools`.
 *
 * The fetch-land `res.on("close")`: the transport closes its own SSE
 * streams after each response, but nothing fires "the response is done" —
 * so the returned body is wrapped in a passthrough stream whose EOF and
 * `cancel` (client disconnect) release the per-request server+transport,
 * and `req.signal` covers an abort while `handleRequest` is still in
 * flight. `onError` receives transport/handler errors — the bin pipes it
 * to stderr.
 */
export async function createCrawlioMcpFetchHandler(
  tools: CrawlioTools,
  onError: (error: Error) => void = () => undefined,
): Promise<CrawlioMcpFetchHandler> {
  const peers = await loadMcpPeers();
  let WebStandardTransportCtor: typeof import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js").WebStandardStreamableHTTPServerTransport;
  try {
    ({ WebStandardStreamableHTTPServerTransport: WebStandardTransportCtor } = await import(
      "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
    ));
  } catch (cause) {
    throw new ConfigError(
      "`crawlio-mcp --transport http` needs the optional peer `@modelcontextprotocol/sdk` — install it (e.g. `npm install @modelcontextprotocol/sdk zod`)",
      { cause },
    );
  }

  return async (req) => {
    let server: McpServer | undefined;
    // Idempotent release — EOF, cancel and abort can all arrive for the
    // same request.
    const closeServer = (): void => {
      const current = server;
      server = undefined;
      if (current !== undefined) {
        void current.close().catch(() => undefined);
      }
    };
    try {
      // Construction lives inside the try too: a throwing transport or
      // `buildMcpServer` must degrade to a 500 + onError, not an
      // unhandled rejection taking the whole listener down.
      const transport = new WebStandardTransportCtor({
        sessionIdGenerator: undefined,
      });
      server = buildMcpServer(peers, tools);
      server.server.onerror = onError;
      req.signal.addEventListener("abort", closeServer, { once: true });
      await server.connect(transport);
      const response = await transport.handleRequest(req);
      const body = response.body;
      if (body === null) {
        // No stream to wrap (202 notifications, error responses) — the
        // response is complete the moment it is returned.
        closeServer();
        return response;
      }
      const reader = body.getReader();
      const passthrough = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            // cancel() can fire while the read above is pending — then
            // the stream is already torn down (desiredSize === null) and
            // close()/enqueue()/error() would all throw TypeErrors.
            if (controller.desiredSize === null) {
              closeServer();
              return;
            }
            if (done) {
              controller.close();
              closeServer();
            } else {
              controller.enqueue(value);
            }
          } catch (error) {
            if (controller.desiredSize !== null) {
              controller.error(error);
            }
            closeServer();
          }
        },
        cancel(reason) {
          void reader.cancel(reason).catch(() => undefined);
          closeServer();
        },
      });
      return new Response(passthrough, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
      closeServer();
      return new Response(null, { status: 500 });
    }
  };
}
