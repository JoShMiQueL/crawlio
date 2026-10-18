# Project context navigation

crawlio: a simple typed web-scraping SDK for static HTML — TypeScript 5.9, `tsc`-only
build (no bundler), ESM-only, Biome, vitest, bun toolchain. Source in `src/`, tests in `test/`.
The `src/` module map: `fetch.ts` (fetch + timeout/UA defaults),
`scraper.ts` (retry policy, robots gating, `scrape`/`scrapeAll`/`scrapeMany`/
`scrapeManySafe`/`fetchHtml`/`createScraper`), `robots.ts` + `robots-parser.ts`
(robots.txt eval + internal RFC 9309 parser), `map.ts`/`crawl.ts` (sitemap-first
URL discovery, same-origin BFS traversal), `search.ts` + `search/` (provider
adapters: `brave.ts`, `serper.ts`, `tavily.ts`, `shared.ts`), `render.ts` +
`render/` (the `Renderer` seam + `isLikelyDynamic`; `playwright.ts`/`puppeteer.ts`
are the subpath adapters, `lifecycle.ts`/`validate.ts` shared internals),
`proxy.ts` (`ProxyPool` rotation + ban-aware health), `stealth.ts` (opt-in
header/cookie mimicry), `captcha.ts` + `solvers/` (challenge detection + solver
seam; `capsolver.ts`, `flaresolverr.ts`), `mcp-tools.ts`/`mcp-server.ts`/`mcp.ts`
(tool layer, `crawlio/mcp` surface, `crawlio-mcp` bin), `cli.ts` + `cli-args.ts`
(the `crawlio` bin), `parse.ts`, `extract.ts`, `charset.ts`, `types.ts`,
`errors.ts`, `version.ts`, `index.ts` (the public surface). `retry.ts`, `limit.ts`, `signal.ts`, and `runtime.ts`
are internals (backoff, concurrency cap, AbortSignal fuse, `isBun`); `signal.ts`
is not exported.

`AGENTS.md` at the project root is auto-loaded by every agent — its hard rules
are already in context. Do not duplicate them here; route to it only for
reference.

## Quick Routes

| Task type | File | Priority |
| --- | --- | --- |
| Any code change | `conventions.md` | critical |
| Verifying / running builds, tests, lint | `commands.md` | critical |
| Code reviews | `code-quality.md` | high |
| Project hard rules (already in context) | `../../AGENTS.md` | critical — auto-loaded |
