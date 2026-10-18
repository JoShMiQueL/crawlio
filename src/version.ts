/**
 * Package version of `crawlio`.
 *
 * Read from the package.json beside this module's directory — `dist/` and
 * `src/` both sit one level below the repo root. A `bun build --compile`
 * binary has no file beside the bundle, so `build:bin` stamps the version
 * in via `--define process.env.CRAWLIO_VERSION`, which replaces this env
 * read with a string literal at build time. The runtime override is
 * therefore dead code in exactly the artifact it was added for — it only
 * takes effect on non-compiled runs (src/dist under node or bun).
 *
 * `VERSION` is not display-only: it feeds every outbound User-Agent
 * (`DEFAULT_USER_AGENT` in fetch.ts) and the MCP `serverInfo`. Overriding
 * it is still safe — only the process owner can set env vars.
 *
 * `||`, not `??`: an empty `CRAWLIO_VERSION=""` (a common CI placeholder)
 * must fall back to package.json too, or `serverInfo.version` is empty
 * and the User-Agent degrades to `crawlio/`. The env read stays the
 * verbatim `process.env.CRAWLIO_VERSION` expression — `bun build
 * --compile`'s `--define` matches it textually.
 */

/**
 * The version field of the package.json beside this module's directory —
 * `dist/` and `src/` both sit one level below the repo root. Under a
 * bundler (esbuild, Workers, `bun build` WITHOUT the compile define) there
 * is no such file — and possibly no `node:fs` at all — at module load:
 * degrade to a placeholder rather than throwing, since VERSION is always
 * evaluated (it feeds DEFAULT_USER_AGENT and the MCP `serverInfo`).
 * `node:fs` is reached LAZILY through `process.getBuiltinModule` (Node
 * >=22.3, Bun): a static import would itself throw at module load, before
 * this try could catch it. A package.json without a string `version`
 * falls back too.
 */
function packageJsonVersion(): string {
  try {
    const fs = typeof process === "undefined" ? undefined : process.getBuiltinModule?.("node:fs");
    if (fs === undefined) return "0.0.0";
    const parsed = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION: string =
  (typeof process === "undefined" ? undefined : process.env.CRAWLIO_VERSION) ||
  packageJsonVersion();
