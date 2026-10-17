# Project context navigation

crawlio: a simple typed web-scraping SDK for static HTML — TypeScript 5.9, `tsc`-only
build (no bundler), ESM-only, Biome, vitest, pnpm. Source in `src/`, tests in `test/`.
The `src/` module map is complete for the static-HTML core: `fetch.ts` (Node
`fetch` + timeout/UA defaults), `scraper.ts` (retry policy, robots.txt,
`scrape`/`scrapeAll`/`scrapeMany`/`createScraper`), `robots.ts`, `stealth.ts`
(opt-in header/cookie mimicry), `captcha.ts` (challenge detection + solver
seam), `parse.ts`, `extract.ts`, `charset.ts`, `types.ts`, `errors.ts`,
`version.ts`. `signal.ts` is an internal AbortSignal helper, not exported.

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
