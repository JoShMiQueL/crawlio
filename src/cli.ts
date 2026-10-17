#!/usr/bin/env node
/**
 * The `crawlio` CLI — thin argument parsing over the library API, zero extra
 * dependencies (`node:util`'s `parseArgs`). Pure helpers live in
 * `cli-args.ts` so they stay unit-testable; this file owns only I/O.
 *
 *   crawlio scrape <url> [--fields 'title=h1;links=a.href@all'] [--render auto|always] [--json]
 *   crawlio map <url> [--limit N]
 *   crawlio crawl <url> [--max-depth N] [--max-pages N]
 *   crawlio search <query> [--provider brave|serper|tavily|module] [--api-key <key>] [--limit N] [--json]
 *   crawlio install [--mcp] [--engine playwright|puppeteer] [--browser chromium|firefox|webkit] [--dry-run]
 */
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import {
  assertEngineName,
  detectEngineModule,
  detectPackageManager,
  type InstallCommand,
  installCommands,
  loadRendererAdapter,
  mcpInstallCommand,
  parseCount,
  parseFieldsSpec,
  rejectRenderOnlyFlags,
  rejectSearchOnlyFlags,
  resolveRenderFlags,
  resolveSearchProviderFlag,
} from "./cli-args.js";
import type { Renderer } from "./index.js";
import { ConfigError, crawl, createScraper, map, ScrapeError, search, VERSION } from "./index.js";

const USAGE = `crawlio ${VERSION} — typed web scraping for static HTML (+ JS via a render engine)

Usage:
  crawlio scrape <url> [options]   Fetch a page and extract fields
  crawlio map <url> [options]      Discover the URLs of a site
  crawlio crawl <url> [options]    Crawl same-origin pages breadth-first
  crawlio search <query> [options] Search the web via a provider
  crawlio install [options]        Install a render engine (peer dep + browser)
  crawlio --help                   This help
  crawlio --version                Print the version

scrape options:
  --fields 'title=h1;links=a.href@all'
        Field spec, ';'-separated entries:
          name=selector        text of the first match
          name=selector@attr   attribute value (or selector.attr shorthand for
                               common attributes: href, src, content, ...)
          ...@all              collect every match into an array
        Default: title=title
  --render auto|always   Consult a render engine: "auto" renders only when the
                         static page looks like a JS shell; "always" renders
                         unconditionally.
  --engine playwright|puppeteer   Engine for --render (default: playwright if
                         installed, else puppeteer).
  --browser chromium|firefox|webkit   Playwright browser for --render
                         (default chromium). Rejected under --engine
                         puppeteer — use --channel/--executable-path.
  --channel <name>       Branded channel the engine resolves: "chrome",
                         "msedge", ... for playwright; "chrome",
                         "chrome-beta", ... for puppeteer (default "chrome").
  --executable-path <p>  Explicit browser binary — mutually exclusive with
                         --channel.
  --wait-for <selector>  waitForSelector after navigation settles — the
                         deterministic way to wait for SPA content.
  --wait-ms <N>          Fixed settle milliseconds after navigation/wait-for —
                         the cruder escape hatch; prefer --wait-for.
  --renderer <module>    Custom-adapter escape hatch for --render (the
                         built-in --engine playwright|puppeteer path covers
                         the common cases): a module specifier (./x.mjs,
                         /abs/path, package name) exporting a { render }
                         object — as "export default" or a named "renderer"
                         export; an optional close() runs on shutdown.
                         Mutually exclusive with --engine, the engine flags
                         and --wait-for/--wait-ms.
  --json                 Compact single-line JSON (default: pretty-printed).

  --engine/--renderer/--browser/--channel/--executable-path/--wait-for/
  --wait-ms all require --render.

map options:
  --limit N              Maximum URLs returned.

crawl options:
  --max-depth N          Link distance from the seed (default 2).
  --max-pages N          Hard cap on pages fetched (default 50).

search options:
  --provider brave|serper|tavily|module
                         Search provider: one of the built-in names reads
                         its key from the matching env var (see --api-key).
                         Default: auto-detect from the API-key env vars —
                         BRAVE_API_KEY → SERPER_API_KEY → TAVILY_API_KEY, in
                         that order; zero set is an error naming all three.
                         A module specifier (./x.mjs, /abs/path, package
                         name) exporting a { search } object — as "export
                         default" or a named "searchProvider"/"provider"
                         export — also works for a custom provider; see
                         "Custom providers and renderers" in the README.
  --api-key <key>        Provider API key — overrides the provider's env var
                         (BRAVE_API_KEY / SERPER_API_KEY / TAVILY_API_KEY).
                         Built-in names only; a provider module carries its
                         own config.
  --limit N              Maximum results returned.

install options:
  --mcp                  Runtime-install @modelcontextprotocol/sdk + zod —
                         the crawlio-mcp / crawlio/mcp peer deps. Alone it is
                         the whole plan; combined with --engine/--browser it
                         is appended to the engine install.
  --engine playwright|puppeteer   Engine to install (default playwright).
  --browser chromium|firefox|webkit   Playwright browser (default chromium).
  --dry-run              Print the commands without running them.
`;

/** JSON.stringify replacer that turns Error objects into readable records. */
function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof ScrapeError) {
    return { name: value.name, code: value.code, message: value.message };
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  return value;
}

function printJson(data: unknown, compact: boolean): void {
  process.stdout.write(`${JSON.stringify(data, compact ? undefined : null, compact ? 0 : 2)}\n`);
}

interface ClosableRenderer extends Renderer {
  close?(): Promise<void>;
}

/**
 * Resolve which engine `--render` should use: an explicit `--engine` wins,
 * otherwise autodetect ({@link detectEngineModule}) — playwright if
 * `playwright-core` is installed, else puppeteer.
 */
async function resolveEngine(engine: string | undefined): Promise<"playwright" | "puppeteer"> {
  if (engine !== undefined) {
    return assertEngineName(engine);
  }
  return detectEngineModule("`--render`");
}

/** The `--render`-scoped flags, grouped for {@link loadRenderer}. */
interface RenderFlags {
  engine?: string;
  renderer?: string;
  browser?: string;
  channel?: string;
  executablePath?: string;
  waitForSelector?: string;
  waitForTimeout?: number;
}

/**
 * Build a renderer for `--render`. The CLI defaults to the strongest
 * navigation-settle state (the user asked for JS execution — give the app a
 * chance to run); `--wait-for`/`--wait-ms` tune it further, and
 * `--browser`/`--channel`/`--executable-path` pick the browser the engine
 * launches.
 */
async function loadRenderer(flags: RenderFlags): Promise<ClosableRenderer> {
  if (flags.renderer !== undefined) {
    // `resolveRenderFlags` already rejected the engine/settle flags a
    // module renderer cannot honor — it replaces engine resolution
    // entirely, so none of the flag plumbing below applies.
    return loadRendererAdapter(flags.renderer);
  }
  const resolved = await resolveEngine(flags.engine);
  const settle = {
    ...(flags.waitForSelector === undefined ? {} : { waitForSelector: flags.waitForSelector }),
    ...(flags.waitForTimeout === undefined ? {} : { waitForTimeout: flags.waitForTimeout }),
  };
  if (resolved === "playwright") {
    const { playwrightRenderer } = await import("./render/playwright.js");
    return playwrightRenderer({
      waitUntil: "networkidle",
      // The adapter validates `browser` against its engine names — the cast
      // is checked, not blind.
      ...(flags.browser === undefined ? {} : { browser: flags.browser as "chromium" }),
      ...(flags.channel === undefined ? {} : { channel: flags.channel }),
      ...(flags.executablePath === undefined ? {} : { executablePath: flags.executablePath }),
      ...settle,
    });
  }
  if (flags.browser !== undefined) {
    throw new ConfigError(
      "`--browser` selects a Playwright engine — puppeteer is Chrome-only; pick a release with `--channel` or a binary with `--executable-path`",
    );
  }
  const { puppeteerRenderer } = await import("./render/puppeteer.js");
  return puppeteerRenderer({
    waitUntil: "networkidle0",
    // puppeteer-core resolves NO browser on its own ("An `executablePath` or
    // `channel` must be specified"). Default to the "chrome" channel, which
    // matches a system Chrome AND a `puppeteer browsers install chrome`
    // download — what `crawlio install --engine puppeteer` fetches.
    channel: flags.channel ?? (flags.executablePath === undefined ? "chrome" : undefined),
    ...(flags.executablePath === undefined ? {} : { executablePath: flags.executablePath }),
    ...settle,
  });
}

/** Run one install step with inherited stdio. */
function runCommand({ command, args }: InstallCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const line = `${command} ${args.join(" ")}`;
    // On Windows, npm/pnpm/npx are .cmd shims, and since Node 18.20.2 a .cmd
    // can only spawn through a shell. `line` carries the args inline (they
    // are our own fixed tokens — no quoting needed), which is exactly the
    // shape that avoids DEP0190's unescaped-args warning.
    const child =
      process.platform === "win32"
        ? spawn(line, { stdio: "inherit", shell: true })
        : spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`\`${line}\` exited with code ${code}`));
    });
  });
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
      fields: { type: "string" },
      render: { type: "string" },
      engine: { type: "string" },
      browser: { type: "string" },
      channel: { type: "string" },
      "executable-path": { type: "string" },
      "wait-for": { type: "string" },
      "wait-ms": { type: "string" },
      limit: { type: "string" },
      provider: { type: "string" },
      renderer: { type: "string" },
      "api-key": { type: "string" },
      "max-depth": { type: "string" },
      "max-pages": { type: "string" },
      json: { type: "boolean", default: false },
      mcp: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });

  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const command = positionals[0];
  if (values.help || command === undefined) {
    process.stdout.write(USAGE);
    return 0;
  }
  const url = positionals[1];

  switch (command) {
    case "scrape": {
      if (url === undefined) throw new ConfigError("`scrape` needs a URL");
      rejectSearchOnlyFlags(values, "scrape");
      const fields =
        values.fields === undefined ? { title: "title" } : parseFieldsSpec(values.fields);
      // Validates `--render` plus every flag hanging off it: a bad mode
      // value, render-scoped flags without `--render`, and engine/settle
      // flags a `--renderer` module cannot honor are all ConfigErrors.
      const renderMode = resolveRenderFlags(values);
      const waitMs = parseCount(values["wait-ms"], "--wait-ms");
      const renderer =
        renderMode === undefined
          ? undefined
          : await loadRenderer({
              engine: values.engine,
              renderer: values.renderer,
              browser: values.browser,
              channel: values.channel,
              executablePath: values["executable-path"],
              waitForSelector: values["wait-for"],
              waitForTimeout: waitMs,
            });
      const scraper = createScraper({
        ...(renderer === undefined ? {} : { render: renderer, renderMode }),
      });
      try {
        const data = await scraper.scrape(url, fields);
        printJson(data, values.json);
      } finally {
        await renderer?.close?.();
      }
      return 0;
    }
    case "map": {
      if (url === undefined) throw new ConfigError("`map` needs a URL");
      rejectSearchOnlyFlags(values, "map");
      rejectRenderOnlyFlags(values, "map");
      const result = await map(url, { limit: parseCount(values.limit, "--limit") });
      printJson(result, values.json);
      return 0;
    }
    case "crawl": {
      if (url === undefined) throw new ConfigError("`crawl` needs a URL");
      rejectSearchOnlyFlags(values, "crawl");
      rejectRenderOnlyFlags(values, "crawl");
      const result = await crawl(url, {
        maxDepth: parseCount(values["max-depth"], "--max-depth"),
        maxPages: parseCount(values["max-pages"], "--max-pages"),
      });
      // Error instances need a replacer to serialize meaningfully.
      process.stdout.write(`${JSON.stringify(result, errorReplacer, values.json ? 0 : 2)}\n`);
      return 0;
    }
    case "search": {
      if (url === undefined) throw new ConfigError("`search` needs a query");
      rejectRenderOnlyFlags(values, "search");
      // Resolution order: explicit `--provider` (built-in name or module
      // specifier) → env auto-detect (BRAVE→SERPER→TAVILY) → ConfigError.
      // `--api-key` with a module specifier is rejected inside, BEFORE the
      // adapter module is imported.
      const provider = await resolveSearchProviderFlag(values.provider, values["api-key"]);
      // A name resolves through the library's provider registry; its
      // env-key default (plus the `--api-key` override) is what makes
      // `crawlio search` a near-zero-config command.
      const results = await search(url, {
        provider,
        ...(values["api-key"] === undefined ? {} : { apiKey: values["api-key"] }),
        limit: parseCount(values.limit, "--limit"),
      });
      printJson(results, values.json);
      return 0;
    }
    case "install": {
      rejectSearchOnlyFlags(values, "install");
      rejectRenderOnlyFlags(values, "install");
      // `--mcp` alone installs just the MCP SDK peer; combined with
      // --engine/--browser it is appended to the engine plan. No flags at
      // all keeps the default engine install.
      const wantsEngine =
        !values.mcp || values.engine !== undefined || values.browser !== undefined;
      const engine = assertEngineName(values.engine ?? "playwright");
      const browser = values.browser ?? "chromium";
      if (
        wantsEngine &&
        engine === "playwright" &&
        !["chromium", "firefox", "webkit"].includes(browser)
      ) {
        throw new ConfigError(
          `\`--browser\` must be "chromium", "firefox" or "webkit", got ${JSON.stringify(browser)}`,
        );
      }
      const pm = detectPackageManager(process.cwd());
      const commands = [
        ...(wantsEngine ? installCommands(engine, browser, pm) : []),
        ...(values.mcp ? [mcpInstallCommand(pm)] : []),
      ];
      process.stdout.write(`Detected package manager: ${pm}\n`);
      for (const cmd of commands) {
        const line = `${cmd.command} ${cmd.args.join(" ")}`;
        if (values["dry-run"]) {
          process.stdout.write(`+ ${line}\n`);
        } else {
          process.stdout.write(`$ ${line}\n`);
          await runCommand(cmd);
        }
      }
      if (wantsEngine && engine === "puppeteer" && !values["dry-run"]) {
        process.stdout.write(
          "Note: `puppeteer-core` resolves a system Chrome via `channel`/`executablePath` — the download above registers `chrome` for `@puppeteer/browsers`.\n",
        );
      }
      return 0;
    }
    default:
      throw new ConfigError(`Unknown command ${JSON.stringify(command)} — try \`crawlio --help\``);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`crawlio: ${message}\n`);
    process.exitCode = 1;
  },
);
