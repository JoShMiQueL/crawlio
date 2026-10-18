/**
 * Pure helpers for the `crawlio` CLI (`src/cli.ts`) and the `crawlio-mcp`
 * bin (`src/mcp.ts`): the `--fields` mini-syntax, numeric flag parsing,
 * flag/command routing, adapter loading, package-manager detection, the
 * `install` command plan and the `crawlio-mcp` transport flags. Everything
 * here is free of process I/O (except {@link detectPackageManager}, which
 * only reads the target directory, the `load*Adapter` importers, and
 * {@link detectEngineModule}'s peer-dep probes) so it is unit-testable
 * without spawning a browser or a package manager.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ConfigError } from "./errors.js";
import type { Renderer, RenderMode } from "./render.js";
import type { SearchProvider, SearchProviderName } from "./search.js";
import { SEARCH_PROVIDER_NAMES } from "./search.js";
import type { FieldSpec, FieldSpecRecord } from "./types.js";

/**
 * Attribute names the `.attr` shorthand in `--fields` may denote —
 * `links=a.href` parses as selector `a` + attribute `href`. A `.` tail NOT in
 * this set stays part of the selector, so `div.product@all` still means
 * "every `div.product`". The `@attr` form (`a@href`) needs no whitelist and
 * always wins.
 */
const SHORTHAND_ATTRIBUTES: ReadonlySet<string> = new Set([
  "href",
  "src",
  "action",
  "poster",
  "cite",
  "data",
  "formaction",
  "content",
  "alt",
  "title",
  "value",
  "name",
]);

/**
 * Parse the `--fields` mini-syntax into a {@link FieldSpecRecord}:
 *
 * - `name=selector` — text of the first match;
 * - `name=selector@attr` or `name=selector.attr` — an attribute value instead
 *   (the `.attr` shorthand only applies to {@link SHORTHAND_ATTRIBUTES});
 * - a trailing `@all` collects every match into an array.
 *
 * Entries are separated by `;`. A malformed entry — no `=`, an empty field
 * name, or an empty selector — is a {@link ConfigError}.
 *
 * @example
 * parseFieldsSpec("title=h1;links=a.href@all")
 * // → { title: "h1", links: { selector: "a", attr: "href", all: true } }
 */
export function parseFieldsSpec(spec: string): FieldSpecRecord {
  const fields: FieldSpecRecord = {};
  for (const raw of spec.split(";")) {
    const entry = raw.trim();
    if (entry === "") continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      throw new ConfigError(
        `Invalid --fields entry ${JSON.stringify(entry)} — expected \`name=selector\``,
      );
    }
    const name = entry.slice(0, eq).trim();
    let rest = entry.slice(eq + 1).trim();
    if (name === "") {
      throw new ConfigError(`Invalid --fields entry ${JSON.stringify(entry)} — empty field name`);
    }
    let all = false;
    if (rest.endsWith("@all")) {
      all = true;
      rest = rest.slice(0, -"@all".length).trim();
    }
    let attr: string | undefined;
    // An `@` only separates selector from attribute when it sits OUTSIDE
    // `[...]` — `a[href*="@"]` is a selector matching literal `@`, not a
    // split point. The last `]` guard keeps quoted `@`s inside brackets.
    const at = rest.lastIndexOf("@");
    if (at >= 0 && at > rest.lastIndexOf("]")) {
      attr = rest.slice(at + 1).trim();
      rest = rest.slice(0, at).trim();
      if (attr === "") {
        throw new ConfigError(`Invalid --fields entry ${JSON.stringify(entry)} — empty attribute`);
      }
    } else {
      const dot = rest.lastIndexOf(".");
      if (dot > 0) {
        const tail = rest.slice(dot + 1);
        if (SHORTHAND_ATTRIBUTES.has(tail)) {
          attr = tail;
          rest = rest.slice(0, dot);
        }
      }
    }
    if (rest === "") {
      throw new ConfigError(`Invalid --fields entry ${JSON.stringify(entry)} — empty selector`);
    }
    const field: FieldSpec =
      attr === undefined && !all
        ? rest
        : {
            selector: rest,
            ...(attr === undefined ? {} : { attr }),
            ...(all ? { all: true } : {}),
          };
    fields[name] = field;
  }
  return fields;
}

/**
 * Parse a numeric CLI flag (`--limit`, `--max-depth`, ...) into a
 * non-negative integer, or `undefined` when the flag was not passed.
 * Anything else is a {@link ConfigError}.
 */
export function parseCount(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  // Decimal digits only — `Number()` is too permissive: "" parses to 0 and
  // "0x10"/"1e3" slip through as valid numbers.
  const digits = value.trim();
  if (!/^\d+$/.test(digits) || !Number.isSafeInteger(Number(digits))) {
    throw new ConfigError(
      `\`${flag}\` must be a non-negative integer, got ${JSON.stringify(value)}`,
    );
  }
  return Number(digits);
}

/**
 * The `crawlio-mcp` bin's parsed flag surface — see
 * {@link parseMcpBinArgs}.
 */
export interface McpBinArgs {
  /** The transport to serve: stdio (the Claude-Desktop default) or HTTP. */
  transport: "stdio" | "http";
  /** Bind address for `--transport http` — loopback by default. */
  host: string;
  /** Port for `--transport http`. */
  port: number;
  /** `--help`/`-h` was passed — print usage, do not start a server. */
  help: boolean;
}

/**
 * Parse the `crawlio-mcp` argv:
 *
 *   crawlio-mcp [--transport stdio|http] [--port N] [--host H] [--help]
 *
 * Defaults: `--transport stdio`, `--host 127.0.0.1`, `--port 3000`. The
 * host default is loopback on purpose — a scraper MCP server bound to
 * `0.0.0.0` out of the box would expose the toolkit to the LAN; `--host
 * 0.0.0.0` is the explicit opt-out. `--port`/`--host` configure the HTTP
 * listener only — passed with the default stdio transport they would be
 * silently ignored, so fail loudly (the same treatment
 * {@link rejectSearchOnlyFlags} gives misplaced flags). Positional
 * arguments are rejected the same way; `--help` short-circuits before any
 * validation so `crawlio-mcp --help --port abc` still prints usage.
 */
export function parseMcpBinArgs(argv: string[]): McpBinArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
      transport: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
    },
  });
  if (values.help) {
    return { transport: "stdio", host: "127.0.0.1", port: 3000, help: true };
  }
  if (positionals.length > 0) {
    throw new ConfigError(
      `\`crawlio-mcp\` takes no positional arguments, got ${JSON.stringify(positionals[0])} — try \`crawlio-mcp --help\``,
    );
  }
  const transport = values.transport ?? "stdio";
  if (transport !== "stdio" && transport !== "http") {
    throw new ConfigError(
      `\`--transport\` must be "stdio" or "http", got ${JSON.stringify(values.transport)}`,
    );
  }
  const port = parseCount(values.port, "--port") ?? 3000;
  // 0 parses as a valid count but binds an ephemeral port while the
  // startup log still prints `host:0` — an address nobody can reach.
  if (port < 1 || port > 65535) {
    throw new ConfigError(`\`--port\` must be between 1 and 65535, got ${port}`);
  }
  const host = values.host ?? "127.0.0.1";
  // A blank host is the wildcard address to `server.listen` — `--host ""`
  // would bind every interface, silently defeating the loopback default.
  if (host.trim() === "") {
    throw new ConfigError(`\`--host\` must not be blank, got ${JSON.stringify(values.host)}`);
  }
  if (transport === "stdio") {
    const httpOnly = (
      [
        ["--port", values.port],
        ["--host", values.host],
      ] as Array<[string, string | undefined]>
    )
      .filter(([, value]) => value !== undefined)
      .map(([flag]) => `\`${flag}\``);
    if (httpOnly.length > 0) {
      throw new ConfigError(
        `${httpOnly.join(", ")} ${httpOnly.length === 1 ? "is" : "are"} only valid with \`--transport http\``,
      );
    }
  }
  return { transport, host, port, help: false };
}

/**
 * The `--provider`/`--api-key` flags mean something only on `crawlio
 * search`. Passed to `scrape`/`map`/`crawl`/`install` they would be
 * silently ignored, so fail loudly instead — the same treatment the
 * render-only flags get on `scrape`.
 */
export function rejectSearchOnlyFlags(
  values: { provider?: string; "api-key"?: string },
  command: string,
): void {
  const searchOnly = [
    ["--provider", values.provider],
    ["--api-key", values["api-key"]],
  ]
    .filter(([, value]) => value !== undefined)
    .map(([flag]) => `\`${flag}\``);
  if (searchOnly.length === 0) return;
  throw new ConfigError(
    `${searchOnly.join(", ")} ${searchOnly.length === 1 ? "is" : "are"} only valid on \`crawlio search\`, not \`crawlio ${command}\``,
  );
}

/**
 * The `--render`-scoped `parseArgs` values (raw, dashed names) — the shared
 * input of the render-flag routing helpers below.
 */
export interface RenderFlagValues {
  render?: string;
  engine?: string;
  renderer?: string;
  browser?: string;
  channel?: string;
  "executable-path"?: string;
  "wait-for"?: string;
  "wait-ms"?: string;
}

/**
 * The flags that configure a `--render` run, as `[flag, raw-value]` pairs —
 * everything that is meaningless without it. `--render` itself is not
 * listed: it is the flag the rest hang off.
 */
function renderScopedFlags(
  values: RenderFlagValues,
): Array<[flag: string, value: string | undefined]> {
  return [
    ["--engine", values.engine],
    ["--renderer", values.renderer],
    ["--browser", values.browser],
    ["--channel", values.channel],
    ["--executable-path", values["executable-path"]],
    ["--wait-for", values["wait-for"]],
    ["--wait-ms", values["wait-ms"]],
  ];
}

/**
 * The `--render` value contract: `"auto"` or `"always"`, or `undefined`
 * when the flag was not passed. Anything else is a {@link ConfigError}.
 */
export function parseRenderMode(render: string | undefined): RenderMode | undefined {
  if (render === undefined) return undefined;
  if (render !== "auto" && render !== "always") {
    throw new ConfigError(`\`--render\` must be "auto" or "always", got ${JSON.stringify(render)}`);
  }
  return render;
}

/**
 * `--engine`/`--renderer`/`--browser`/`--channel`/`--executable-path`/
 * `--wait-for`/`--wait-ms` only configure a render that `--render` turned
 * on — passed alone they would be silently ignored, so fail loudly.
 */
export function rejectRenderFlagsWithoutRender(values: RenderFlagValues): void {
  const renderOnly = renderScopedFlags(values)
    .filter(([, value]) => value !== undefined)
    .map(([flag]) => `\`${flag}\``);
  if (renderOnly.length > 0) {
    throw new ConfigError(
      `${renderOnly.join(", ")} ${renderOnly.length === 1 ? "requires" : "require"} \`--render auto|always\``,
    );
  }
}

/**
 * A `--renderer` module replaces engine resolution entirely: the engine and
 * settle flags configure the built-in adapters and would be silently
 * ignored, so each one present is a {@link ConfigError}.
 */
export function rejectRendererModuleConflicts(values: RenderFlagValues): void {
  if (values.renderer === undefined) return;
  const conflicts = renderScopedFlags(values)
    .filter(([flag, value]) => flag !== "--renderer" && value !== undefined)
    .map(([flag]) => `\`${flag}\``);
  if (conflicts.length > 0) {
    throw new ConfigError(
      `${conflicts.join(", ")} ${conflicts.length === 1 ? "does" : "do"} not apply to \`--renderer\` — the module carries its own config`,
    );
  }
}

/**
 * The `scrape` command's `--render` contract in one place: parse the mode
 * ({@link parseRenderMode}); with no mode, reject the render-scoped flags
 * that would be silently dropped ({@link rejectRenderFlagsWithoutRender});
 * with one, reject the engine/settle flags that cannot reach a `--renderer`
 * module ({@link rejectRendererModuleConflicts}).
 */
export function resolveRenderFlags(values: RenderFlagValues): RenderMode | undefined {
  const renderMode = parseRenderMode(values.render);
  if (renderMode === undefined) {
    rejectRenderFlagsWithoutRender(values);
  } else {
    rejectRendererModuleConflicts(values);
  }
  return renderMode;
}

/**
 * The render-scoped flags mean something only on `crawlio scrape` — the
 * symmetric counterpart to {@link rejectSearchOnlyFlags}: passed to
 * `map`/`crawl`/`search`/`install` they would be silently ignored, so fail
 * loudly. On `install`, `--engine`/`--browser` stay legal — there they pick
 * what to install, not how to render.
 */
export function rejectRenderOnlyFlags(values: RenderFlagValues, command: string): void {
  const renderOnly = ([["--render", values.render]] as Array<[string, string | undefined]>)
    .concat(renderScopedFlags(values))
    .filter(([, value]) => value !== undefined)
    .filter(([flag]) => !(command === "install" && (flag === "--engine" || flag === "--browser")))
    .map(([flag]) => `\`${flag}\``);
  if (renderOnly.length === 0) return;
  throw new ConfigError(
    `${renderOnly.join(", ")} ${renderOnly.length === 1 ? "is" : "are"} only valid on \`crawlio scrape\`, not \`crawlio ${command}\``,
  );
}

/**
 * The `--engine` value contract, shared by `--render` resolution and
 * `crawlio install`: exactly "playwright" or "puppeteer".
 */
export function assertEngineName(engine: string): "playwright" | "puppeteer" {
  if (engine !== "playwright" && engine !== "puppeteer") {
    throw new ConfigError(
      `\`--engine\` must be "playwright" or "puppeteer", got ${JSON.stringify(engine)}`,
    );
  }
  return engine;
}

/** Whether a peer-dep engine module is importable from this install. */
async function engineModuleAvailable(name: string): Promise<boolean> {
  try {
    await import(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Autodetect a render engine when none was named: playwright if
 * `playwright-core` is importable, else puppeteer. This is the fallback the
 * CLI applies to `--render` without `--engine`, and `crawlio-mcp` applies
 * to engine-scoped `CRAWLIO_*` vars without `CRAWLIO_ENGINE`. `label`
 * names the feature in the error (`--render`, `crawlio-mcp`).
 */
export async function detectEngineModule(label: string): Promise<"playwright" | "puppeteer"> {
  if (await engineModuleAvailable("playwright-core")) return "playwright";
  if (await engineModuleAvailable("puppeteer-core")) return "puppeteer";
  throw new ConfigError(
    `${label} needs a browser engine — run \`crawlio install\` or install \`playwright-core\` / \`puppeteer-core\``,
  );
}

/**
 * The provider API-key env vars {@link detectSearchProviderFromEnv} checks,
 * in precedence order — the same order the `--help` text documents.
 */
const PROVIDER_ENV_VARS = [
  ["BRAVE_API_KEY", "brave"],
  ["SERPER_API_KEY", "serper"],
  ["TAVILY_API_KEY", "tavily"],
] as const;

/**
 * Detect which built-in search provider to use when `--provider` was not
 * passed: the first env var of {@link PROVIDER_ENV_VARS} that is set wins
 * (`BRAVE_API_KEY` → `SERPER_API_KEY` → `TAVILY_API_KEY` — deterministic).
 * Returns `undefined` when none is set.
 */
export function detectSearchProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SearchProviderName | undefined {
  for (const [envName, name] of PROVIDER_ENV_VARS) {
    if (env[envName]?.trim()) return name;
  }
  return undefined;
}

/**
 * Import an adapter module for a CLI flag (`--provider`, `--renderer`).
 *
 * Specifier forms: a relative path (`./my-adapter.mjs` — resolved against
 * the cwd), an absolute path, a `file:` URL, or a bare package name. A bare
 * name resolves against the cwd's `node_modules` first (the user's own
 * project install wins — relevant for `npx`/global crawlio), falling back
 * to crawlio's own module context. A load failure is a {@link ConfigError}
 * naming the flag and specifier.
 */
async function importAdapterModule(
  specifier: string,
  flag: string,
): Promise<Record<string, unknown>> {
  let importTarget: string;
  if (specifier.startsWith("file:")) {
    importTarget = specifier;
  } else if (
    // `.\\`/`..\\` are the Windows spellings of the relative forms —
    // without them `.\x.mjs` would fall through to package resolution.
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith(".\\") ||
    specifier.startsWith("..\\") ||
    isAbsolute(specifier)
  ) {
    importTarget = pathToFileURL(resolve(process.cwd(), specifier)).href;
  } else {
    try {
      importTarget = pathToFileURL(
        createRequire(join(process.cwd(), "package.json")).resolve(specifier),
      ).href;
    } catch {
      importTarget = specifier;
    }
  }
  try {
    return (await import(importTarget)) as Record<string, unknown>;
  } catch (cause) {
    throw new ConfigError(
      `\`${flag}\` could not load adapter module ${JSON.stringify(specifier)}`,
      { cause },
    );
  }
}

/**
 * The object a module export is picked from: `export default` wins, else
 * the conventional named export for the kind (`searchProvider`/`provider`
 * for search, `renderer` for render).
 */
function pickAdapterExport(mod: Record<string, unknown>, namedExports: readonly string[]): unknown {
  if (Object.hasOwn(mod, "default")) return mod.default;
  for (const name of namedExports) {
    if (mod[name] !== undefined) return mod[name];
  }
  return undefined;
}

/**
 * Load a custom {@link SearchProvider} for `--provider <specifier>`. The
 * module must export an object with a `search(query, options)` method —
 * `export default` or a named `searchProvider`/`provider` export. Anything
 * else is a {@link ConfigError} naming the expected shape.
 *
 * `flag` labels the error messages — the MCP server reuses this loader for
 * provider module specifiers, where no `--provider` flag exists.
 */
export async function loadSearchProviderAdapter(
  specifier: string,
  flag = "--provider",
): Promise<SearchProvider> {
  const mod = await importAdapterModule(specifier, flag);
  const candidate = pickAdapterExport(mod, ["searchProvider", "provider"]);
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof (candidate as SearchProvider).search !== "function"
  ) {
    throw new ConfigError(
      `\`${flag}\` module ${JSON.stringify(specifier)} must export a SearchProvider with a \`search(query, options)\` method — as \`export default\` or a named \`searchProvider\`/\`provider\` export`,
    );
  }
  return candidate as SearchProvider;
}

/**
 * Load a custom {@link Renderer} for `--renderer <specifier>`. The module
 * must export an object with a `render(url, options)` method — `export
 * default` or a named `renderer` export; an optional `close()` is honored
 * on shutdown. Anything else is a {@link ConfigError} naming the expected
 * shape.
 *
 * `flag` labels the error messages — the MCP server reuses this loader for
 * `CRAWLIO_RENDERER`, where no `--renderer` flag exists.
 */
export async function loadRendererAdapter(
  specifier: string,
  flag = "--renderer",
): Promise<Renderer> {
  const mod = await importAdapterModule(specifier, flag);
  const candidate = pickAdapterExport(mod, ["renderer"]);
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof (candidate as Renderer).render !== "function"
  ) {
    throw new ConfigError(
      `\`${flag}\` module ${JSON.stringify(specifier)} must export a Renderer with a \`render(url, options)\` method — as \`export default\` or a named \`renderer\` export`,
    );
  }
  return candidate as Renderer;
}

/**
 * Resolve the `search` command's provider: an explicit `--provider` is
 * either a built-in name ({@link SEARCH_PROVIDER_NAMES}) or a module
 * specifier loaded through {@link loadSearchProviderAdapter}; with no flag,
 * {@link detectSearchProviderFromEnv} picks from the API-key env vars and
 * zero matches is a {@link ConfigError} naming all three. `--api-key`
 * applies only to built-in names — combined with a module specifier it is
 * rejected BEFORE the module is imported, so a bad flag combo never
 * executes adapter code.
 */
export async function resolveSearchProviderFlag(
  provider: string | undefined,
  apiKey?: string,
): Promise<SearchProvider | SearchProviderName> {
  if (provider !== undefined) {
    if ((SEARCH_PROVIDER_NAMES as readonly string[]).includes(provider)) {
      return provider as SearchProviderName;
    }
    if (apiKey !== undefined) {
      // A module-loaded provider is an object carrying its own config —
      // `--api-key` would be silently ignored by `search`. Checked here,
      // before `loadSearchProviderAdapter`, so the flag error never runs
      // adapter code.
      throw new ConfigError(
        "`--api-key` only applies to built-in provider names — a provider module carries its own config",
      );
    }
    return loadSearchProviderAdapter(provider);
  }
  const detected = detectSearchProviderFromEnv();
  if (detected === undefined) {
    throw new ConfigError(
      "`crawlio search` needs a provider — pass `--provider brave|serper|tavily` (or a module specifier) or set one of BRAVE_API_KEY, SERPER_API_KEY, TAVILY_API_KEY",
    );
  }
  return detected;
}

/** Package managers `crawlio install` knows how to drive. */
export type PackageManager = "npm" | "pnpm" | "bun" | "yarn";

/**
 * Normalize a `packageManager` manifest field (`"pnpm@12.14.0"` → `"pnpm"`).
 * Returns `undefined` for managers outside the supported set (or no field).
 */
export function packageManagerFromField(field: unknown): PackageManager | undefined {
  if (typeof field !== "string") return undefined;
  const name = field.split("@")[0];
  return name === "pnpm" || name === "npm" || name === "bun" || name === "yarn" ? name : undefined;
}

/**
 * Detect the package manager owning `dir`'s install: the `packageManager`
 * field of `dir/package.json` first, then a lockfile sniff —
 * `pnpm-lock.yaml` → pnpm, `bun.lock`/`bun.lockb` → bun, `yarn.lock` →
 * yarn — with `npm` as the fallback.
 */
export function detectPackageManager(dir: string): PackageManager {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      packageManager?: unknown;
    };
    const fromField = packageManagerFromField(pkg.packageManager);
    if (fromField !== undefined) return fromField;
  } catch {
    // No readable package.json — fall through to the lockfile sniff.
  }
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return "bun";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

/** One shell command of an {@link installCommands} plan — `command` + argv. */
export interface InstallCommand {
  command: string;
  args: string[];
}

/**
 * Per-manager spellings for {@link installCommands} and
 * {@link mcpInstallCommand}: `add` dev-installs a package; `addRuntime`
 * installs it as a runtime dependency; `dlx` is the idiomatic
 * npx-equivalent that runs a package's CLI without installing it — `npx`
 * for npm, `pnpm dlx` for pnpm, `bunx` for bun, `yarn dlx` for yarn.
 */
const PM_COMMANDS: Record<
  PackageManager,
  { add: InstallCommand; addRuntime: InstallCommand; dlx: InstallCommand }
> = {
  npm: {
    add: { command: "npm", args: ["install", "--save-dev"] },
    addRuntime: { command: "npm", args: ["install"] },
    dlx: { command: "npx", args: [] },
  },
  pnpm: {
    add: { command: "pnpm", args: ["add", "-D"] },
    addRuntime: { command: "pnpm", args: ["add"] },
    dlx: { command: "pnpm", args: ["dlx"] },
  },
  bun: {
    add: { command: "bun", args: ["add", "-d"] },
    addRuntime: { command: "bun", args: ["add"] },
    dlx: { command: "bunx", args: [] },
  },
  yarn: {
    add: { command: "yarn", args: ["add", "-D"] },
    addRuntime: { command: "yarn", args: ["add"] },
    dlx: { command: "yarn", args: ["dlx"] },
  },
};

/**
 * The commands `crawlio install` runs, in order (see {@link PM_COMMANDS}
 * for the per-manager `add`/`dlx` spellings):
 *
 * - playwright: `<pm> add playwright-core` as a dev dependency, then `<dlx>
 *   playwright-core install <browser>` — `playwright-core` ships its own
 *   CLI, so no extra package is needed for the browser download.
 *   `options.withDeps` inserts `--with-deps` into that step so playwright
 *   also installs the browser's OS-level libraries (Linux only — what a
 *   fresh CI image needs).
 * - puppeteer: `<pm> add puppeteer-core`, then `<dlx> puppeteer browsers
 *   install chrome` — `puppeteer-core` itself never downloads a browser;
 *   the `puppeteer` package's `@puppeteer/browsers` CLI does (dlx fetches
 *   it on demand). Alternatively configure `channel`/`executablePath` and
 *   skip the download. `--with-deps` is playwright-only — combined with
 *   this engine it is a {@link ConfigError}.
 */
export function installCommands(
  engine: "playwright" | "puppeteer",
  browser: string,
  pm: PackageManager,
  options: { withDeps?: boolean } = {},
): InstallCommand[] {
  const { add, dlx } = PM_COMMANDS[pm];
  if (engine === "playwright") {
    return [
      { command: add.command, args: [...add.args, "playwright-core"] },
      {
        command: dlx.command,
        args: [
          ...dlx.args,
          "playwright-core",
          "install",
          ...(options.withDeps ? ["--with-deps"] : []),
          browser,
        ],
      },
    ];
  }
  if (options.withDeps) {
    throw new ConfigError(
      "`--with-deps` is playwright-only — `puppeteer browsers install` has no system-deps step",
    );
  }
  return [
    { command: add.command, args: [...add.args, "puppeteer-core"] },
    { command: dlx.command, args: [...dlx.args, "puppeteer", "browsers", "install", "chrome"] },
  ];
}

/**
 * The `crawlio install --mcp` plan — a single `<pm> add
 * @modelcontextprotocol/sdk zod` step installing BOTH packages: the SDK's
 * own peer contract marks `zod` required (`peerDependenciesMeta.optional:
 * false`) and `McpServer` validates tool arguments through it. Unlike the
 * engine packages these are RUNTIME dependencies (`addRuntime`, no `-D`):
 * the server runs inside the user's own `crawlio-mcp`/`crawlio/mcp`
 * process, not just at development time.
 */
export function mcpInstallCommand(pm: PackageManager): InstallCommand {
  const { addRuntime } = PM_COMMANDS[pm];
  return {
    command: addRuntime.command,
    args: [...addRuntime.args, "@modelcontextprotocol/sdk", "zod"],
  };
}
