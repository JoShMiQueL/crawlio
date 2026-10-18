# crawlio — agent instructions

## What this is

`crawlio` — a deliberately simple, typed web scraping SDK for **static HTML**:
HTTP fetch + HTML parsing + CSS-selector field extraction, with types inferred from
the extraction spec. Pre-1.0 and unpublished.

**Product definition.** A typed, self-hosted Node.js SDK for web data extraction —
scrape/crawl/map/search over HTTP, with a pluggable renderer for JS-heavy pages.
A library, not a hosted service. Non-goals, in order of importance:

- **crawlio NEVER performs browser actions.** No click/fill/type/navigation flows —
  rendering is read-only. Browser automation is a separate sibling project.
- **No own search index** — `search` delegates to external providers.
- **No managed-challenge guarantees at the HTTP layer** — the captcha solver is a
  seam, not a promise.
- **Nothing hosted** — no API keys, no cloud component.

## Stack

- **TypeScript ^5.9.3** — deliberately *not* TypeScript 7 (too new, ships no JS compiler API).
- **`tsc` only — no bundler.** No tsdown/tsup/rollup/esbuild. ESM-only output (`"type": "module"`, NodeNext).
- **Biome ^2.5.15** for lint + format. Biome does not typecheck — `tsc --noEmit` is the typecheck step.
- **vitest ^5.0.5** for tests. **bun** for everything (PM, scripts, CI) — the library itself stays dual-runtime: Node consumers are first-class, so every check must also pass under node.

## Commands

| Command | Purpose |
| --- | --- |
| `bun install` | install deps (`bun.lock` is the canonical lockfile) |
| `bun run lint` | Biome lint + format check |
| `bun run lint:fix` | Biome with `--write` (safe autofix) |
| `bun run typecheck` | `tsc --noEmit` + `tsc --noEmit -p tsconfig.test.json` |
| `bun test` | bun:test — Bun's own runner (NOT vitest); the CI bun-lane suite |
| `bun run test` | vitest, single run — the `vitest` .bin shim executes it under node, so this is the SAME lane as `npm run test` |
| `bun run test:types` | `tsc --noEmit -p tsconfig.test.json` (type-only assertions in `test/types.test.ts`) |
| `bun run build` | `tsc -p tsconfig.build.json` → `dist/` |
| `bun run check` | lint + typecheck + test (run this before reporting done) |
| `bun run check:pack` | publint + arethetypeswrong on the packed tarball |
| `bunx <cmd>` | one-off binaries (`bunx attw --pack .`, …) — do not install |

Verifying the **node lane** locally: run the same steps through npm/npx —
`npm run lint`, `npm run typecheck`, `npx vitest run`. `npm run`/`npx`
spawn the `node_modules/.bin` shims with their `node` shebang, which is
exactly what CI's node lanes rely on (`bun run`/`bunx` would execute them
under Bun instead).

## Project structure

- `src/` — library source. Compiled to `dist/` by `tsc` (`rootDir: ./src`). Public surface re-exported from `src/index.ts`.
- `test/` — vitest specs + `test/fixtures.ts` (loader). Not in the `tsconfig.json` project, but typechecked by `tsconfig.test.json`. `test/fixtures/` holds recorded HTML; `test/types.test.ts` holds compile-time-only (`expectTypeOf`) assertions enforced by `bun run typecheck`, not by `bun test`. `test/e2e-render.test.ts` is the real-browser e2e — self-skips unless `CRAWLIO_E2E=1` (the `e2e-browsers` CI job installs chromium and sets it).
- `tsconfig.json` (base, `src` only) / `tsconfig.test.json` (`src` + `test`, `noEmit`) / `tsconfig.build.json` (build-only; excludes `dist`, `node_modules`, `src/**/*.test.ts`).

## Hard rules for agents

- **Respect target sites:** honor robots.txt (on by default — `robots: false` opts out), site terms, and rate limits. Default to conservative request rates; make them configurable.
- **Retry/backoff:** all network I/O goes through one shared retry policy with exponential backoff + jitter — no ad-hoc `setTimeout` retries at call sites.
- **Typed extraction:** selectors/parsers return typed results; validate raw page data before it enters the SDK's public types. Never trust scraped HTML shape.
- **No credential leakage:** credentials/proxy auth come from config/env, never hardcoded; scrub auth headers and cookies from logs, errors, and fixtures.
- **User-agent honesty:** identifiable, configurable User-Agent by default — no stealth spoofing unless explicitly opt-in.
- **Deterministic parsing:** parsing/extraction is pure and unit-testable against recorded fixtures. **No network calls inside parser code.**

## Orchestration

This project uses a Devin multi-agent system in `.devin/`:
- You describe the task; the `orchestrate` skill auto-triggers (model-invoked) and delegates to `.devin/agents/` subagents.
- Subagents: `contextscout` (context), `coder` (implement), `reviewer` (review, read-only), `qa` (verify, read-only), `researcher` (web).
- Hard gates via `.devin/hooks.v1.json`: direct root-agent edits are blocked (delegate to `coder`), and turns can't end with unverified code changes (qa+reviewer required). Hooks also include `SessionStart`/`PostCompaction` (context re-injection) and `SubagentStop` (subagent output-contract validation).
- `.devin/rules/` holds trigger-scoped rules: `scraping-safety` (model_decision), `testing` (glob-scoped), `context-system` (always_on).
- Hard rules above apply to every subagent.

## Roadmap

v1 ships a static-HTML core behind `render`/`SearchProvider` seams — `search`
is done, delegating to external providers (`braveSearchProvider` is the
reference), and so is the MCP server (`crawlio-mcp`, stdio, optional
`@modelcontextprotocol/sdk` peer). A headless engine plugs in via optional
injection (peer-dep/dynamic import) — never bundled.