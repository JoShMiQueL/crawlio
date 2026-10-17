import { readFileSync } from "node:fs";

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
 * and the User-Agent degrades to `crawlio/`.
 */
export const VERSION: string =
  process.env.CRAWLIO_VERSION ||
  (
    JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    }
  ).version;
