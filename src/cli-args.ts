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

/** Package managers `crawlio install` knows how to drive. */
export type PackageManager = "npm" | "pnpm";

/**
 * Normalize a `packageManager` manifest field (`"pnpm@12.14.0"` → `"pnpm"`).
 * Returns `undefined` for managers outside the supported set (or no field).
 */
export function packageManagerFromField(field: unknown): PackageManager | undefined {
  if (typeof field !== "string") return undefined;
  const name = field.split("@")[0];
  return name === "pnpm" || name === "npm" ? name : undefined;
}

/**
 * Detect the package manager owning `dir`'s install: the `packageManager`
 * field of `dir/package.json` first, then a `pnpm-lock.yaml` sniff, with
 * `npm` as the fallback.
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
  return "npm";
}

/** One shell command of an {@link installCommands} plan — `command` + argv. */
export interface InstallCommand {
  command: string;
  args: string[];
}

/**
 * The commands `crawlio install` runs, in order:
 *
 * - playwright: `<pm> add -D playwright-core`, then `npx playwright-core
 *   install <browser>` — `playwright-core` ships its own CLI, so no extra
 *   package is needed for the browser download.
 * - puppeteer: `<pm> add -D puppeteer-core`, then `npx puppeteer browsers
 *   install chrome` — `puppeteer-core` itself never downloads a browser; the
 *   `puppeteer` package's `@puppeteer/browsers` CLI does (npx fetches it on
 *   demand). Alternatively configure `channel`/`executablePath` and skip the
 *   download.
 */
export function installCommands(
  engine: "playwright" | "puppeteer",
  browser: string,
  pm: PackageManager,
): InstallCommand[] {
  const add: InstallCommand =
    pm === "pnpm"
      ? { command: "pnpm", args: ["add", "-D"] }
      : { command: "npm", args: ["install", "--save-dev"] };
  if (engine === "playwright") {
    return [
      { command: add.command, args: [...add.args, "playwright-core"] },
      { command: "npx", args: ["playwright-core", "install", browser] },
    ];
  }
  return [
    { command: add.command, args: [...add.args, "puppeteer-core"] },
    { command: "npx", args: ["puppeteer", "browsers", "install", "chrome"] },
  ];
}
