# Project context navigation

scrape-sdk: a simple typed web-scraping SDK for static HTML — TypeScript 5.9, `tsc`-only
build (no bundler), ESM-only, Biome, vitest, pnpm. Source in `src/`, tests in `test/`.
The static-HTML core (charset, parse, typed extraction, errors) is implemented; the
fetch layer, retries and robots.txt are **not** yet — that is the next task.

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
