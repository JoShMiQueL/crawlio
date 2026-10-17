/**
 * Pure helpers for the `crawlio` CLI (`src/cli.ts`): the `--fields`
 * mini-syntax, numeric flag parsing, package-manager detection and the
 * `install` command plan. Everything here is free of process I/O (except
 * {@link detectPackageManager}, which only reads the target directory) so it
 * is unit-testable without spawning a browser or a package manager.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "./errors.js";
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
 * Per-manager spellings for {@link installCommands}: `add` dev-installs a
 * package; `dlx` is the idiomatic npx-equivalent that runs a package's CLI
 * without installing it — `npx` for npm, `pnpm dlx` for pnpm, `bunx` for
 * bun, `yarn dlx` for yarn.
 */
const PM_COMMANDS: Record<PackageManager, { add: InstallCommand; dlx: InstallCommand }> = {
  npm: {
    add: { command: "npm", args: ["install", "--save-dev"] },
    dlx: { command: "npx", args: [] },
  },
  pnpm: {
    add: { command: "pnpm", args: ["add", "-D"] },
    dlx: { command: "pnpm", args: ["dlx"] },
  },
  bun: {
    add: { command: "bun", args: ["add", "-d"] },
    dlx: { command: "bunx", args: [] },
  },
  yarn: {
    add: { command: "yarn", args: ["add", "-D"] },
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
 * - puppeteer: `<pm> add puppeteer-core`, then `<dlx> puppeteer browsers
 *   install chrome` — `puppeteer-core` itself never downloads a browser;
 *   the `puppeteer` package's `@puppeteer/browsers` CLI does (dlx fetches
 *   it on demand). Alternatively configure `channel`/`executablePath` and
 *   skip the download.
 */
export function installCommands(
  engine: "playwright" | "puppeteer",
  browser: string,
  pm: PackageManager,
): InstallCommand[] {
  const { add, dlx } = PM_COMMANDS[pm];
  if (engine === "playwright") {
    return [
      { command: add.command, args: [...add.args, "playwright-core"] },
      { command: dlx.command, args: [...dlx.args, "playwright-core", "install", browser] },
    ];
  }
  return [
    { command: add.command, args: [...add.args, "puppeteer-core"] },
    { command: dlx.command, args: [...dlx.args, "puppeteer", "browsers", "install", "chrome"] },
  ];
}
