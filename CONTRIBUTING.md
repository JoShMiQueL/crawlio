# Contributing to crawlio

## Setup

```sh
git clone https://github.com/JoShMiQueL/crawlio
cd crawlio
bun install
```

Toolchain: Bun 1.4.3+ (package manager, test runner, scripts). Node 26.12+
is required too — the library is dual-runtime and the Node lane is
first-class.

## Commands

| Command | Purpose |
| --- | --- |
| `bun run check` | lint + typecheck + tests — run before every PR |
| `bun test` | the suite under `bun:test` (Bun lane) |
| `npm run test` | the suite under vitest/Node (Node lane) |
| `bun run build` | `tsc` → `dist/` |
| `bun run build:bin` | `bun build --compile` → `dist-bin/*.exe` |
| `bun run check:pack` | publint + attw on the packed tarball |
| `bun --check` | Bun's native typecheck |

## Dual-runtime rule — the one that matters most

Library code (`src/`) must run on Node and Bun unchanged. `Bun.*` APIs are
allowed only behind the `isBun` seam (`src/runtime.ts`) or in
Bun-specific entrypoints — a bare `Bun.serve` in shared code breaks Node
consumers. If both lanes should behave identically, write the Node API
(Bun implements `node:*`); reach for `Bun.*` only when it buys something real.

## Conventions

- **Tests** are written against the vitest API surface (which `bun:test`
  covers) so the same suite runs on both lanes. Bun-only behavior gets
  `isBun ? it : it.skip`-style gates.
- **Comments**: terse, factual, explain *why* when non-obvious. No
  narration of what the code visibly does.
- **Dependencies**: near-zero by policy — runtime deps are `cheerio` +
  `undici` and adding one needs justification in the PR.
- **Commits**: conventional commits (`feat:`, `fix:`, `chore:`, `docs:`).
  No `Co-Authored-By` trailers.
- **Secrets**: never commit credentials; proxy/auth config comes from
  options/env only.

## PR process

1. Branch from `main` — short-lived, `feat/…`, `fix/…`, `docs/…`
2. `bun run check` green locally (both lanes where it matters)
3. PR with a summary and a test-plan checklist
4. `ci-success` must be green; squash-merge keeps `main` linear
5. Docs-only changes skip the heavy matrix via path filtering — expected,
  not a bug

## What not to build

- No browser actions (click/fill/type) — crawlio is a scraper; automation
  is out of scope by design
- No custom HTML parser — the parser is a correctness dependency, owned
  by cheerio
- No network I/O inside parser code — extraction is pure and fixture-tested
