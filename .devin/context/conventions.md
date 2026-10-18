<!-- Context: project/conventions | Priority: critical -->

# Conventions

Items marked **[decided]** are project policy for a scraping SDK. The stack below is
**[decided]** as of scaffold time — re-check `package.json` before assuming it still holds.

## Stack
- **[decided]** TypeScript `^5.9.3` (deliberately NOT TypeScript 7 — no JS compiler API yet), `tsc` only with **no bundler** (no tsdown/tsup/rollup/esbuild), ESM-only (`"type": "module"`, `module`/`moduleResolution: nodenext`), Node `>=26.12`.
- **[decided]** Package manager / toolchain: **bun** (`packageManager: bun@1.4.3`, `bun.lock` canonical). The LIBRARY stays dual-runtime — Node consumers are first-class; node lanes verify via `npm run`/`npx`.
- **[decided]** Lint + format: `@biomejs/biome` `^2.5.15`. Biome does **not** typecheck — `tsc --noEmit` is the typecheck step.
- **[decided]** Tests: `vitest` `^5.0.5`. Also dev-only tooling: `publint`, `@arethetypeswrong/cli`, `@types/node`.

## Structure
- **[decided]** `src/` — library source, compiled to `dist/` (`rootDir: ./src`, `outDir: ./dist`). The public surface is re-exported from `src/index.ts`; submodules are added per concern as they appear:
  - `types.ts` — public vocabulary: `FieldSpec`, `FieldSpecRecord`, `FieldValue` (the generic inference type), `ExtractResult`, `ScrapeOptions`/`ScraperOptions`, `MapOptions`/`CrawlOptions`, `StealthOptions`, the CAPTCHA/solver types.
  - `errors.ts` — error taxonomy (`ScrapeError` + `HttpError`/`FetchError`/`TimeoutError`/`RobotsError`/`ParseError`/`ConfigError`, `ScrapeErrorCode`) and the internal `scrubUrl()` credential scrubber.
  - `charset.ts` — charset detection/decoding, zero dependencies (Node's built-in `TextDecoder`).
  - `parse.ts` / `extract.ts` — `parseHtml` (pure cheerio wrapper) and `extract`/`extractAll` (pure typed field extraction).
  - `fetch.ts` — `fetchHtmlOnce`: timeout, honest UA default, body decode.
  - `scraper.ts` — `createScraper` + `scrape`/`scrapeAll`/`scrapeMany`/`scrapeManySafe`/`fetchHtml`: retry policy, robots gating, per-origin serialization, proxy resolution, render escalation.
  - `robots.ts` + `robots-parser.ts` — robots.txt fetch/eval and the internal RFC 9309 parser.
  - `map.ts` / `crawl.ts` — sitemap-first URL discovery and same-origin BFS traversal.
  - `search.ts` + `search/` — the `search` entry point and the provider adapters (`brave`, `serper`, `tavily`).
  - `render.ts` + `render/` — the `Renderer` seam + `isLikelyDynamic`; `render/playwright.ts` and `render/puppeteer.ts` are the `crawlio/playwright`/`crawlio/puppeteer` subpath adapters.
  - `proxy.ts` — `ProxyPool` rotation + ban-aware health; undici `ProxyAgent` dispatchers under Node, `Bun.FetchSession` under Bun.
  - `stealth.ts` — opt-in browser header profiles, cookie jar, referer chain.
  - `captcha.ts` + `solvers/` — challenge-page detection + the solver seam; built-ins `capSolver`, `flareSolverr`.
  - `retry.ts`, `limit.ts`, `signal.ts`, `runtime.ts` — internals: backoff, concurrency cap, AbortSignal fuse, `isBun`.
  - `mcp-tools.ts` + `mcp-server.ts` + `mcp.ts` — pure tool layer, the `crawlio/mcp` embedding surface, the `crawlio-mcp` bin.
  - `cli.ts` + `cli-args.ts` — the `crawlio` bin and its argument parser.
  - `version.ts` / `index.ts` — `VERSION` and the public re-exports.
- **[decided]** `test/` — vitest specs, plus `test/fixtures.ts` (fixture loader). Not in the `tsconfig.json` project, but they **are** typechecked by `tsconfig.test.json`.
- **[decided]** Root config: `biome.json` and `package.json` scripts, plus **five** tsconfigs:
  - `tsconfig.json` — base; `include: ["src"]` only.
  - `tsconfig.test.json` — extends base; `include: ["src", "test"]`, `noEmit`; run by `bun run typecheck` and `bun run test:types`. This is how the test files get typechecked.
  - `tsconfig.build.json` — extends base; excludes `dist`, `node_modules`, `src/**/*.test.ts`; emits `dist/` via `bun run build`. Tests never ship.
  - `tsconfig.scripts.json` — extends base; `include: ["scripts"]`, `noEmit`, `node` + `bun-types`; typechecks the repo scripts (`scripts/*.ts`).
  - `tsconfig.e2e.json` — extends base; `include: ["e2e"]`, `noEmit`, `bun-types` + `dom` lib + `paths` mapping `crawlio`/`crawlio/*` imports to `src/` — typechecks the e2e suite without a dist/ build.
- **[decided]** Fixtures for parser tests live alongside specs under `test/fixtures/` (recorded HTML, no network). Hand-written, never re-serialized through a parser.

## Style
- **[decided]** Formatter/linter is Biome: `bun run lint` (check) and `bun run lint:fix` (write). 2-space indent, double quotes, line width 100.
- **[decided]** Imports: ESM `NodeNext` — always relative **with the `.js` extension** (`./foo.js`), even when importing TS sources; `verbatimModuleSyntax` is on, so use `import type` for type-only imports.
- **[decided]** Naming/import conventions: files are kebab-case; exported functions are camelCase; public types are named interfaces/types with explicit annotations (no `isolatedDeclarations`, but declaration emit must stay clean).

### Decisions already made — do not re-litigate
- **[decided]** Output is ESM-only. With `moduleResolution: nodenext`, every relative import MUST carry the `.js` extension, even when importing TS sources.
- **[decided]** Stay on TypeScript 5.9. TypeScript 7 is deliberately avoided (no JS compiler API yet). Do not "upgrade" it without a stated reason.
- **[decided]** `tsc` only, no bundler — no tsdown/tsup/rollup/esbuild. Deliberate: this project is 0.x and a bundler is where 0.x build tools break first.
- **[decided]** Runtime deps are exactly two: `cheerio` (parsing) and `undici` (the Node lane's proxy `ProxyAgent` dispatchers — `fetch`'s `dispatcher:` slot takes an undici `Dispatcher`). undici is `createRequire`'d lazily inside `proxy.ts`, so it never loads under Bun (proxies there use `Bun.FetchSession`). Charset handling stays dependency-free via the built-in `TextDecoder`; do NOT add `iconv-lite`/`encoding-sniffer`/`chardet`, and do NOT add another HTTP client — plain fetches use the global `fetch`.
- **[decided]** `test/hygiene.test.ts` enforces two invariants: no raw control characters in test sources, and tests import only from the public surface (`../src/index.js`, with `../src/errors.js` as the documented exception for the internal `scrubUrl`). Extend that file instead of writing ad-hoc hygiene checks elsewhere.

## Scraping-specific rules **[decided]**
- **Respect target sites:** honor robots.txt, site terms, and rate limits. Default to conservative request rates; make them configurable.
- **Retry/backoff:** all network I/O goes through a shared retry policy with exponential backoff + jitter; no ad-hoc `setTimeout` retries scattered in call sites.
- **Typed extraction:** selectors/parsers return typed results — validate raw page data before it enters the SDK's public types (never trust scraped HTML shape).
- **No credential leakage:** credentials/proxy auth come from config/env, never hardcoded; scrub auth headers and cookies from logs, errors, and test fixtures.
- **User-agent honesty:** SDK sets an identifiable, configurable User-Agent by default — no stealth spoofing unless it's an explicit opt-in feature.
- **Deterministic parsing:** parsing/extraction logic is pure and unit-testable against recorded fixtures — no network calls inside parser code.

## Docs
- **[decided]** Canonical docs: `AGENTS.md` (agent rules, hard rules, commands) and `.devin/context/*` (this context system) are the sources of truth; `README.md` is the public-facing doc.
