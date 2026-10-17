#!/usr/bin/env node
/**
 * The `crawlio` CLI — thin argument parsing over the library API, zero extra
 * dependencies (`node:util`'s `parseArgs`). Pure helpers live in
 * `cli-args.ts` so they stay unit-testable; this file owns only I/O.
 *
 *   crawlio scrape <url> [--fields 'title=h1;links=a.href@all'] [--render auto|always] [--json]
 *   crawlio map <url> [--limit N]
 *   crawlio crawl <url> [--max-depth N] [--max-pages N]
 *   crawlio search <query> [--limit N] [--json]
 *   crawlio install [--engine playwright|puppeteer] [--browser chromium|firefox|webkit] [--dry-run]
 */
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import {
  detectPackageManager,
  type InstallCommand,
  installCommands,
  parseCount,
  parseFieldsSpec,
} from "./cli-args.js";
import type { Renderer, RenderMode } from "./index.js";
import {
  braveSearchProvider,
  ConfigError,
  crawl,
  createScraper,
  map,
  ScrapeError,
  search,
  VERSION,
} from "./index.js";

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
  --json                 Compact single-line JSON (default: pretty-printed).

  --engine/--browser/--channel/--executable-path/--wait-for/--wait-ms all
  require --render.

map options:
  --limit N              Maximum URLs returned.

crawl options:
  --max-depth N          Link distance from the seed (default 2).
  --max-pages N          Hard cap on pages fetched (default 50).

search options:
  --limit N              Maximum results returned.
  Uses the Brave Search API — the key comes from the BRAVE_API_KEY
  environment variable.

install options:
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

/** Whether a peer-dep engine module is importable from this install. */
async function moduleAvailable(name: string): Promise<boolean> {
  try {
    await import(name);
    return true;
  } catch {
    return false;
  }
}

interface ClosableRenderer extends Renderer {
  close?(): Promise<void>;
}

/**
 * Resolve which engine `--render` should use: an explicit `--engine` wins,
 * otherwise playwright if `playwright-core` is installed, else puppeteer.
 */
async function resolveEngine(engine: string | undefined): Promise<"playwright" | "puppeteer"> {
  if (engine !== undefined) {
    if (engine !== "playwright" && engine !== "puppeteer") {
      throw new ConfigError(
        `\`--engine\` must be "playwright" or "puppeteer", got ${JSON.stringify(engine)}`,
      );
    }
    return engine;
  }
  if (await moduleAvailable("playwright-core")) return "playwright";
  if (await moduleAvailable("puppeteer-core")) return "puppeteer";
  throw new ConfigError(
    "`--render` needs a browser engine — run `crawlio install` or install `playwright-core` / `puppeteer-core`",
  );
}

/** The `--render`-scoped flags, grouped for {@link loadRenderer}. */
interface RenderFlags {
  engine?: string;
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
      "max-depth": { type: "string" },
      "max-pages": { type: "string" },
      json: { type: "boolean", default: false },
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
      const fields =
        values.fields === undefined ? { title: "title" } : parseFieldsSpec(values.fields);
      let renderMode: RenderMode | undefined;
      if (values.render !== undefined) {
        if (values.render !== "auto" && values.render !== "always") {
          throw new ConfigError(
            `\`--render\` must be "auto" or "always", got ${JSON.stringify(values.render)}`,
          );
        }
        renderMode = values.render;
      }
      if (renderMode === undefined) {
        // Engine/settle flags are meaningless without `--render` — fail
        // loudly instead of silently dropping them.
        const renderOnly = [
          ["--engine", values.engine],
          ["--browser", values.browser],
          ["--channel", values.channel],
          ["--executable-path", values["executable-path"]],
          ["--wait-for", values["wait-for"]],
          ["--wait-ms", values["wait-ms"]],
        ]
          .filter(([, value]) => value !== undefined)
          .map(([flag]) => `\`${flag}\``);
        if (renderOnly.length > 0) {
          throw new ConfigError(
            `${renderOnly.join(", ")} ${renderOnly.length === 1 ? "requires" : "require"} \`--render auto|always\``,
          );
        }
      }
      const waitMs = parseCount(values["wait-ms"], "--wait-ms");
      const renderer =
        renderMode === undefined
          ? undefined
          : await loadRenderer({
              engine: values.engine,
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
      const result = await map(url, { limit: parseCount(values.limit, "--limit") });
      printJson(result, values.json);
      return 0;
    }
    case "crawl": {
      if (url === undefined) throw new ConfigError("`crawl` needs a URL");
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
      // The CLI wires the reference provider; its env-key resolution is
      // what makes `crawlio search` a zero-config command.
      const results = await search(url, {
        provider: braveSearchProvider(),
        limit: parseCount(values.limit, "--limit"),
      });
      printJson(results, values.json);
      return 0;
    }
    case "install": {
      const engine = values.engine ?? "playwright";
      if (engine !== "playwright" && engine !== "puppeteer") {
        throw new ConfigError(
          `\`--engine\` must be "playwright" or "puppeteer", got ${JSON.stringify(engine)}`,
        );
      }
      const browser = values.browser ?? "chromium";
      if (engine === "playwright" && !["chromium", "firefox", "webkit"].includes(browser)) {
        throw new ConfigError(
          `\`--browser\` must be "chromium", "firefox" or "webkit", got ${JSON.stringify(browser)}`,
        );
      }
      const pm = detectPackageManager(process.cwd());
      const commands = installCommands(engine, browser, pm);
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
      if (engine === "puppeteer" && !values["dry-run"]) {
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
