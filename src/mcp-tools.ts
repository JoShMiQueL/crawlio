/**
 * The `crawlio-mcp` tool layer — pure logic over the library API. Deliberately
 * free of process I/O and of the `@modelcontextprotocol/sdk` import (a lazy
 * peer of the binary, loaded only by `mcp-server.ts`): every injectable lives
 * in {@link CrawlioToolsDeps} so tests drive the handlers without a transport,
 * and importing this module never touches the MCP SDK.
 */
import {
  detectEngineModule,
  detectSearchProviderFromEnv,
  loadRendererAdapter,
} from "./cli-args.js";
import { ConfigError, ScrapeError } from "./errors.js";
import type { Renderer, RenderMode } from "./render.js";
import { createScraper } from "./scraper.js";
import type { SearchProvider, SearchProviderName } from "./search.js";
import { SEARCH_PROVIDER_NAMES, search } from "./search.js";
import type { FieldSpecRecord } from "./types.js";

/** A renderer with the optional shutdown the adapters expose. */
export interface ClosableRenderer extends Renderer {
  close?(): Promise<void>;
}

/**
 * A `tools/list` descriptor — the JSON Schema `inputSchema` is what MCP
 * clients (and their models) see; the handlers re-validate `arguments`
 * themselves since the protocol carries plain JSON.
 */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * A `tools/call` result — the text-content subset of `CallToolResult`. The
 * index signature matches the protocol type, which is a loose record.
 */
export interface McpToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** Everything {@link createCrawlioTools} can be given — the test seams. */
export interface CrawlioToolsDeps {
  /**
   * Fetch implementation for the static HTTP path, injected straight into
   * `createScraper` — tests serve fixtures through it.
   */
  fetch?: typeof globalThis.fetch;
  /**
   * Renderer source for `scrape`'s `render` parameter, resolved lazily on
   * first need and memoized for the life of the tools instance. The default
   * reads the `CRAWLIO_*` env vars via {@link resolveEnvRenderer}. An
   * optional `close()` on the returned renderer runs on
   * {@link CrawlioTools.close}.
   */
  loadRenderer?: () => Promise<ClosableRenderer | undefined>;
  /**
   * Search-provider override for the `search` tool — skips name/module/env
   * resolution entirely (a fixture provider in tests).
   */
  provider?: SearchProvider;
  /**
   * Environment consulted by the default resolvers — provider autodetect
   * (`BRAVE_API_KEY`/`SERPER_API_KEY`/`TAVILY_API_KEY`) and renderer config
   * (`CRAWLIO_ENGINE`/`CRAWLIO_RENDERER`/...). Defaults to `process.env`.
   */
  env?: NodeJS.ProcessEnv;
}

/** The tool surface {@link createCrawlioTools} exposes. */
export interface CrawlioTools {
  /** Tool descriptors for `tools/list`, in registration order. */
  readonly definitions: readonly McpToolDefinition[];
  /**
   * Dispatch one `tools/call`: validates the JSON arguments, runs the
   * library call, and returns the result JSON-stringified as text content.
   * ANY failure — bad arguments, a `ScrapeError` from the pipeline, an
   * unknown tool name — comes back as an `isError` result carrying the
   * error's message, never a thrown exception or a raw stack.
   */
  call(name: string, args: unknown): Promise<McpToolResult>;
  /**
   * Close the shared renderer if one was loaded — safe to call more than
   * once and before any `scrape` call (a never-loaded renderer is not
   * resolved just to close it).
   */
  close(): Promise<void>;
}

/** Read an env var, treating an absent or blank value as unset. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

/**
 * Read an opt-in env flag: `1`/`true`/`yes`/`on` (any case) enable it,
 * everything else — including absent, blank, or `0`/`false` — leaves it
 * off. A security flag needs an unambiguous affirmative, never mere
 * presence.
 */
function envFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = envValue(env, name);
  return value !== undefined && ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

/**
 * Resolve the `crawlio-mcp` renderer from the environment — the binary's
 * equivalent of the CLI's `--render` engine flags:
 *
 * - `CRAWLIO_RENDERER=<module specifier>` — the custom-adapter escape hatch
 *   ({@link loadRendererAdapter}); mutually exclusive with every
 *   `CRAWLIO_ENGINE`-scoped variable, which a module cannot honor.
 * - `CRAWLIO_ENGINE=playwright|puppeteer` — a built-in adapter with the same
 *   strong `networkidle`/`networkidle0` settle default the CLI uses;
 *   `CRAWLIO_BROWSER` (playwright only), `CRAWLIO_CHANNEL` and
 *   `CRAWLIO_EXECUTABLE_PATH` pick the browser the engine launches. Those
 *   engine-scoped vars WITHOUT `CRAWLIO_ENGINE` autodetect the engine —
 *   the same fallback the CLI applies to `--render` without `--engine`.
 * - None set → `undefined`, and `scrape`'s `render` parameter has nothing
 *   to consult.
 */
export async function resolveEnvRenderer(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClosableRenderer | undefined> {
  const rendererModule = envValue(env, "CRAWLIO_RENDERER");
  const engine = envValue(env, "CRAWLIO_ENGINE");
  const browser = envValue(env, "CRAWLIO_BROWSER");
  const channel = envValue(env, "CRAWLIO_CHANNEL");
  const executablePath = envValue(env, "CRAWLIO_EXECUTABLE_PATH");

  if (rendererModule !== undefined) {
    const conflicts = [
      engine !== undefined ? "CRAWLIO_ENGINE" : undefined,
      browser !== undefined ? "CRAWLIO_BROWSER" : undefined,
      channel !== undefined ? "CRAWLIO_CHANNEL" : undefined,
      executablePath !== undefined ? "CRAWLIO_EXECUTABLE_PATH" : undefined,
    ].filter((name): name is string => name !== undefined);
    if (conflicts.length > 0) {
      throw new ConfigError(
        `${conflicts.join(", ")} ${conflicts.length === 1 ? "does" : "do"} not apply to CRAWLIO_RENDERER — the module carries its own config`,
      );
    }
    return loadRendererAdapter(rendererModule, "CRAWLIO_RENDERER");
  }

  let resolved: "playwright" | "puppeteer";
  if (engine === undefined) {
    if (browser === undefined && channel === undefined && executablePath === undefined) {
      return undefined;
    }
    // Engine-scoped vars without CRAWLIO_ENGINE mean a renderer is wanted —
    // autodetect the engine like the CLI's `--render` without `--engine`
    // (playwright when installed, else puppeteer) rather than demanding an
    // explicit name.
    resolved = await detectEngineModule("`crawlio-mcp`");
  } else {
    if (engine !== "playwright" && engine !== "puppeteer") {
      throw new ConfigError(
        `CRAWLIO_ENGINE must be "playwright" or "puppeteer", got ${JSON.stringify(engine)}`,
      );
    }
    resolved = engine;
  }

  if (resolved === "playwright") {
    const { playwrightRenderer } = await import("./render/playwright.js");
    return playwrightRenderer({
      waitUntil: "networkidle",
      // The adapter validates `browser` against its engine names — the cast
      // is checked, not blind (same rule as the CLI's `--browser`).
      ...(browser === undefined ? {} : { browser: browser as "chromium" }),
      ...(channel === undefined ? {} : { channel }),
      ...(executablePath === undefined ? {} : { executablePath }),
    });
  }
  if (browser !== undefined) {
    throw new ConfigError(
      "CRAWLIO_BROWSER selects a Playwright engine — puppeteer is Chrome-only; pick a release with CRAWLIO_CHANNEL or a binary with CRAWLIO_EXECUTABLE_PATH",
    );
  }
  const { puppeteerRenderer } = await import("./render/puppeteer.js");
  return puppeteerRenderer({
    waitUntil: "networkidle0",
    // Same default as the CLI: puppeteer-core resolves NO browser on its
    // own, so default to the "chrome" channel (a system Chrome or a
    // `puppeteer browsers install chrome` download).
    channel: channel ?? (executablePath === undefined ? "chrome" : undefined),
    ...(executablePath === undefined ? {} : { executablePath }),
  });
}

/**
 * Resolve the `search` tool's provider. Unlike the CLI's `--provider`
 * ({@link resolveSearchProviderFlag}), an explicit `provider` here is
 * ENUM-ONLY — it must be a built-in name ({@link SEARCH_PROVIDER_NAMES}).
 * Module specifiers are deliberately not accepted on this surface: an MCP
 * client's `provider` argument is remote input, and `import()`ing a
 * caller-chosen specifier would be code execution on the server (the zod
 * schema in mcp-server.ts rejects non-enum values even earlier). With no
 * argument, {@link detectSearchProviderFromEnv} autodetects from the
 * API-key env vars (`BRAVE_API_KEY` → `SERPER_API_KEY` → `TAVILY_API_KEY`)
 * and zero matches is a {@link ConfigError} naming all three. Credentials
 * stay env-only — there is deliberately no `apiKey` argument.
 */
export async function resolveMcpSearchProvider(
  provider: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SearchProvider | SearchProviderName> {
  if (provider !== undefined) {
    if ((SEARCH_PROVIDER_NAMES as readonly string[]).includes(provider)) {
      return provider as SearchProviderName;
    }
    const names = SEARCH_PROVIDER_NAMES.map((name) => `"${name}"`).join(", ");
    throw new ConfigError(
      `\`provider\` must be a built-in name — expected one of ${names}, got ${JSON.stringify(provider)}`,
    );
  }
  const detected = detectSearchProviderFromEnv(env);
  if (detected === undefined) {
    throw new ConfigError(
      'The `search` tool needs a provider — pass `provider` ("brave", "serper" or "tavily") or set one of BRAVE_API_KEY, SERPER_API_KEY, TAVILY_API_KEY',
    );
  }
  return detected;
}

/**
 * JSON keys a field-spec object may carry — the JSON-expressible subset of
 * `FieldSpec` (`transform` is a function and can never cross the protocol).
 */
const JSON_FIELD_KEYS: ReadonlySet<string> = new Set(["selector", "attr", "all", "resolve"]);

/**
 * Validate the `scrape` tool's `fields` argument — a JSON object matching
 * {@link FieldSpecRecord}: each entry a non-empty selector string or a
 * `{ selector, attr?, all?, resolve? }` object. This is NOT the CLI's
 * `parseFieldsSpec` (that parses the `name=selector@attr@all` mini-syntax);
 * here the shape is already JSON and just needs checking.
 *
 * A `transform` key is a {@link ConfigError} naming why: functions cannot
 * cross JSON. Unknown keys fail loudly the same way — a typo like `attrs`
 * must not extract the wrong thing silently.
 */
export function parseJsonFields(value: unknown): FieldSpecRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(
      '`fields` must be an object — e.g. { "title": "h1", "links": { "selector": "a", "attr": "href", "all": true } }',
    );
  }
  const fields: FieldSpecRecord = {};
  for (const [name, spec] of Object.entries(value)) {
    const shown = JSON.stringify(name);
    if (name === "") {
      throw new ConfigError("`fields` entries need a non-empty field name");
    }
    if (typeof spec === "string") {
      if (spec.trim() === "") {
        throw new ConfigError(`Invalid \`fields\` entry ${shown} — empty selector`);
      }
      fields[name] = spec;
      continue;
    }
    if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
      throw new ConfigError(
        `Invalid \`fields\` entry ${shown} — expected a selector string or a { selector, attr?, all? } object`,
      );
    }
    const record = spec as Record<string, unknown>;
    if ("transform" in record) {
      throw new ConfigError(
        `Invalid \`fields\` entry ${shown} — \`transform\` is a function and cannot cross JSON; extract the raw value and transform it downstream`,
      );
    }
    for (const key of Object.keys(record)) {
      if (!JSON_FIELD_KEYS.has(key)) {
        throw new ConfigError(
          `Invalid \`fields\` entry ${shown} — unknown key ${JSON.stringify(key)} (expected selector, attr, all, resolve)`,
        );
      }
    }
    const selector = record.selector;
    if (typeof selector !== "string" || selector.trim() === "") {
      throw new ConfigError(
        `Invalid \`fields\` entry ${shown} — \`selector\` must be a non-empty string`,
      );
    }
    if (record.attr !== undefined && (typeof record.attr !== "string" || record.attr === "")) {
      throw new ConfigError(
        `Invalid \`fields\` entry ${shown} — \`attr\` must be a non-empty string`,
      );
    }
    if (record.all !== undefined && typeof record.all !== "boolean") {
      throw new ConfigError(`Invalid \`fields\` entry ${shown} — \`all\` must be a boolean`);
    }
    if (record.resolve !== undefined && typeof record.resolve !== "boolean") {
      throw new ConfigError(`Invalid \`fields\` entry ${shown} — \`resolve\` must be a boolean`);
    }
    fields[name] = {
      selector,
      ...(record.attr === undefined ? {} : { attr: record.attr }),
      ...(record.all === undefined ? {} : { all: record.all }),
      ...(record.resolve === undefined ? {} : { resolve: record.resolve }),
    };
  }
  if (Object.keys(fields).length === 0) {
    throw new ConfigError("`fields` must declare at least one field");
  }
  return fields;
}

/** `tools/call` arguments arrive as plain JSON — narrow to a record first. */
function argsRecord(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new ConfigError("tool `arguments` must be an object");
  }
  return args as Record<string, unknown>;
}

/**
 * Fail loudly on keys the tool does not declare — the same rule the CLI
 * applies to misplaced flags: a typo'd argument must not be silently dropped.
 */
function rejectUnknownKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new ConfigError(
      `Unknown ${unknown.length === 1 ? "argument" : "arguments"} ${unknown
        .map((key) => `\`${key}\``)
        .join(", ")} — expected ${allowed.map((key) => `\`${key}\``).join(", ")}`,
    );
  }
}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`\`${name}\` must be a non-empty string`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`\`${name}\` must be a non-empty string`);
  }
  return value;
}

function optionalCount(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ConfigError(
      `\`${name}\` must be a non-negative integer, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** The `scrape` tool's `render` parameter: `"auto"` or `"always"`, nothing else. */
function parseRenderParam(value: unknown): RenderMode | undefined {
  if (value === undefined) return undefined;
  if (value !== "auto" && value !== "always") {
    throw new ConfigError(`\`render\` must be "auto" or "always", got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * JSON.stringify replacer that turns Error objects into readable records —
 * `crawl` pages carry `error`s that would otherwise serialize as `{}`.
 */
function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof ScrapeError) {
    return { name: value.name, code: value.code, message: value.message };
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  return value;
}

const SCRAPE_DESCRIPTION =
  "Fetch a page and extract typed fields via CSS selectors. `fields` maps a name to a selector " +
  'string ("title": "h1") or an object { "selector": "a", "attr": "href", "all": true } — ' +
  'default { "title": "title" }. `render` consults the configured renderer ' +
  '(CRAWLIO_ENGINE/CRAWLIO_RENDERER env): "auto" renders pages that look like JS shells, ' +
  '"always" renders unconditionally.';

const TOOL_DEFINITIONS: readonly McpToolDefinition[] = [
  {
    name: "scrape",
    description: SCRAPE_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The page URL (http/https)." },
        fields: {
          type: "object",
          description: "Field spec: name → selector string or { selector, attr?, all? }.",
        },
        render: { type: "string", enum: ["auto", "always"] },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "map",
    description:
      "Discover the URLs of a site — declared sitemaps first, the seed page's same-origin links as fallback.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The seed URL (http/https)." },
        limit: { type: "integer", minimum: 0, description: "Maximum URLs returned." },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "crawl",
    description:
      "Crawl same-origin pages breadth-first from a seed URL — polite by default (robots.txt, serial requests).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The seed URL (http/https)." },
        maxDepth: {
          type: "integer",
          minimum: 0,
          description: "Link distance from the seed (default 2).",
        },
        maxPages: {
          type: "integer",
          minimum: 0,
          description: "Hard cap on pages fetched (default 50).",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "search",
    description:
      'Search the web through a provider. `provider` is a built-in name ("brave", "serper", ' +
      '"tavily" — the API key comes from the matching env var); omit it ' +
      "to autodetect from BRAVE_API_KEY / SERPER_API_KEY / TAVILY_API_KEY, in that order.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        // Enum, not free text — a module specifier would mean remote code
        // loading, which is a CLI-only privilege (see the zod schema).
        provider: {
          type: "string",
          enum: [...SEARCH_PROVIDER_NAMES],
          description: "A built-in provider name.",
        },
        limit: { type: "integer", minimum: 0, description: "Maximum results returned." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

const TOOL_NAMES = TOOL_DEFINITIONS.map((tool) => tool.name);

/**
 * Build crawlio's MCP tool surface over an injectable {@link CrawlioToolsDeps}.
 * One shared scraper (so its politeness state — the robots cache, per-origin
 * serialization — flows across calls) and one lazily-resolved shared
 * renderer, released by {@link CrawlioTools.close}.
 */
export function createCrawlioTools(deps: CrawlioToolsDeps = {}): CrawlioTools {
  const env = deps.env ?? process.env;
  const scraper = createScraper({
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    // The opt-in SSRF guard, env-configured like the renderer: MCP clients
    // hand the server arbitrary URLs — the textbook SSRF shape — so
    // `CRAWLIO_BLOCK_PRIVATE_HOSTS=1` on the crawlio-mcp process refuses
    // private/reserved targets. Off without the flag (localhost targets are
    // legitimate for self-hosted users).
    ...(envFlag(env, "CRAWLIO_BLOCK_PRIVATE_HOSTS") ? { blockPrivateHosts: true } : {}),
  });
  // Resolved once, on first need — never eagerly at server start (a browser
  // engine is expensive even to import) and shared by every tool call. A
  // FAILED resolution is not cached — the memo clears on rejection so a
  // later call retries (the env or peer dep may have been fixed), the same
  // contract `lazyBrowser` gives engine launches.
  let rendererPromise: Promise<ClosableRenderer | undefined> | undefined;
  const loadRenderer = (): Promise<ClosableRenderer | undefined> => {
    if (rendererPromise !== undefined) return rendererPromise;
    const mine = (
      deps.loadRenderer === undefined ? resolveEnvRenderer(env) : deps.loadRenderer()
    ).catch((error: unknown) => {
      // Clear only when this attempt is still the tracked one — a
      // concurrent retry may already have taken the slot.
      if (rendererPromise === mine) rendererPromise = undefined;
      throw error;
    });
    rendererPromise = mine;
    return mine;
  };

  const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    scrape: async (args) => {
      rejectUnknownKeys(args, ["url", "fields", "render"]);
      const url = requireString(args, "url");
      const fields = args.fields === undefined ? { title: "title" } : parseJsonFields(args.fields);
      const renderMode = parseRenderParam(args.render);
      const renderer = await loadRenderer();
      if (renderer === undefined && renderMode !== undefined) {
        throw new ConfigError(
          "`render` needs a configured renderer — set CRAWLIO_ENGINE=playwright|puppeteer or CRAWLIO_RENDERER=<module> on the `crawlio-mcp` process",
        );
      }
      return scraper.scrape(url, fields, {
        ...(renderer === undefined ? {} : { render: renderer }),
        ...(renderMode === undefined ? {} : { renderMode }),
      });
    },
    map: (args) => {
      rejectUnknownKeys(args, ["url", "limit"]);
      return scraper.map(requireString(args, "url"), { limit: optionalCount(args, "limit") });
    },
    crawl: (args) => {
      rejectUnknownKeys(args, ["url", "maxDepth", "maxPages"]);
      return scraper.crawl(requireString(args, "url"), {
        maxDepth: optionalCount(args, "maxDepth"),
        maxPages: optionalCount(args, "maxPages"),
      });
    },
    search: async (args) => {
      rejectUnknownKeys(args, ["query", "provider", "limit"]);
      const query = requireString(args, "query");
      // Defer env/module resolution into the provider call itself: `search`
      // resolves its provider LAST — after input validation and the
      // `limit: 0` short-circuit — so resolving eagerly here would demand an
      // API key (or load an adapter module) that a zero-limit call never
      // needs.
      const provider: SearchProvider | SearchProviderName = deps.provider ?? {
        search: (q, options) =>
          resolveMcpSearchProvider(optionalString(args, "provider"), env).then((resolved) =>
            search(q, { ...options, provider: resolved }),
          ),
      };
      return search(query, { provider, limit: optionalCount(args, "limit") });
    },
  };

  let closed = false;
  return {
    definitions: TOOL_DEFINITIONS,
    async call(name, args) {
      try {
        const handler = Object.hasOwn(handlers, name) ? handlers[name] : undefined;
        if (handler === undefined) {
          throw new ConfigError(
            `Unknown tool ${JSON.stringify(name)} — expected one of ${TOOL_NAMES.map(
              (n) => `\`${n}\``,
            ).join(", ")}`,
          );
        }
        const data = await handler(argsRecord(args ?? {}));
        return { content: [{ type: "text", text: JSON.stringify(data, errorReplacer) }] };
      } catch (error) {
        // MCP tool errors are RESULTS (isError), not protocol errors — and
        // the content is the error's message, never a raw stack.
        const message = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      // Peek, don't resolve — a renderer that was never needed must not be
      // loaded just to be closed. A rejected resolution has nothing to
      // close: swallow it so close() never surfaces a stale load error on
      // transport shutdown.
      const renderer =
        rendererPromise === undefined ? undefined : await rendererPromise.catch(() => undefined);
      await renderer?.close?.();
    },
  };
}
