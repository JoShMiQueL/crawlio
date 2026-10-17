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
- **vitest ^5.0.5** for tests. **pnpm** for everything.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm lint` | Biome lint + format check |
| `pnpm lint:fix` | Biome with `--write` (safe autofix) |
| `pnpm typecheck` | `tsc --noEmit` + `tsc --noEmit -p tsconfig.test.json` |
| `pnpm test` | vitest, single run |
| `pnpm test:types` | `tsc --noEmit -p tsconfig.test.json` (type-only assertions in `test/types.test.ts`) |
| `pnpm build` | `tsc -p tsconfig.build.json` → `dist/` |
| `pnpm check` | lint + typecheck + test (run this before reporting done) |
| `pnpm check:pack` | publint + arethetypeswrong on the packed tarball |

## Project structure

- `src/` — library source. Compiled to `dist/` by `tsc` (`rootDir: ./src`). Public surface re-exported from `src/index.ts`.
- `test/` — vitest specs + `test/fixtures.ts` (loader). Not in the `tsconfig.json` project, but typechecked by `tsconfig.test.json`. `test/fixtures/` holds recorded HTML; `test/types.test.ts` holds compile-time-only (`expectTypeOf`) assertions enforced by `pnpm typecheck`, not by `pnpm test`.
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

v1 ships a static-HTML core behind a `render` seam; a headless engine plugs in
later via optional injection (peer-dep/dynamic import) — never bundled.