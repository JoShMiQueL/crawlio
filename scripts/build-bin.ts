/**
 * `bun build --compile` for both bins — run via `bun run build:bin` (Bun
 * required; `bun` executes this file directly, so no tsc/`build`
 * step is needed — the TS sources compile straight into the binaries).
 *
 *   dist-bin/crawlio      — the `crawlio` CLI
 *   dist-bin/crawlio-mcp  — the `crawlio-mcp` MCP server
 *
 * `dist-bin/` is gitignored — these are build artifacts, not sources.
 *
 * Two knobs the CLI one-liner cannot express cross-platform:
 *
 * - `--define process.env.CRAWLIO_VERSION` — the compiled binary has no
 *   package.json on disk beside the bundle (see version.ts), so the
 *   version is stamped in here, read from package.json itself.
 * - `--external playwright-core --external puppeteer-core` — the engine
 *   peers stay lazy `import()`s resolved at runtime; bundling them would
 *   bloat the binary and break their own internal file loading. The MCP
 *   SDK and zod DO embed — the crawlio-mcp binary must be self-contained.
 * - `--external undici` — the binaries run under Bun, where proxy routing
 *   uses `Bun.FetchSession` and the undici path is unreachable.
 */
import { mkdirSync, statSync } from "node:fs";
import pkg from "../package.json" with { type: "json" };

const outdir = "dist-bin";
mkdirSync(outdir, { recursive: true });

const builds: ReadonlyArray<readonly [entrypoint: string, name: string]> = [
  ["src/cli.ts", "crawlio"],
  ["src/mcp.ts", "crawlio-mcp"],
];

for (const [entrypoint, name] of builds) {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    compile: { outfile: `${outdir}/${name}` },
    external: ["playwright-core", "puppeteer-core", "undici"],
    define: { "process.env.CRAWLIO_VERSION": JSON.stringify(pkg.version) },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  // `result.outputs[].size` is the JS bundle — the compiled exe (the
  // bundle + the Bun runtime) is what lands on disk, so stat that.
  //
  // `compile.bytecode` was evaluated (Bun 1.4.3): the exe grew ~7.5 MiB
  // and `--version` startup was ~20 ms SLOWER — the embedded app bundle is
  // small, so precompiled bytecode buys nothing here.
  const exe = result.outputs[0]?.path ?? `${outdir}/${name}`;
  const mib = statSync(exe).size / 1024 / 1024;
  console.log(`${exe} (${mib.toFixed(1)} MiB)`);
}
