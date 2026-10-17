# Roadmap

**Status:** feature-complete for v0.1.0 — pre-publish.

## Phase 0 — Lifecycle *(in progress — publish pending)*

- [x] GitHub repo
- [x] CI — lint + typecheck + test + pack (`.github/workflows/ci.yml`)
- [x] Branch protection
- [x] Changelog
- [ ] npm publish — not yet

## Phase 1 — Dual-runtime (Node + Bun)

**Decided:** the library stays consumable from any current Node runtime.
Bun already implements the `node:*` APIs the code uses, so crawlio runs on
Bun today. **Baseline verified:** `bun test` runs the full 465-test suite
green on Bun 1.4 with zero code changes. The work is adopting Bun-native
APIs behind `typeof Bun !== "undefined"` guards (`src/runtime.ts`'s
`isBun`) where they genuinely win:

| Bun API | Replaces | Where |
| --- | --- | --- |
| `Bun.serve()` | `node:http` | MCP streamable-HTTP transport — **done** (`createCrawlioMcpFetchHandler` + `WebStandardStreamableHTTPServerTransport`) |
| `Bun.fetch` (native `proxy:`) | undici dispatcher | fetch layer — **done** (`proxyRequestInit` seam + per-proxy `Bun.FetchSession` pools) |
| `Bun.spawn` | `node:child_process` | subprocesses |
| `Bun.file` / `Bun.write` | `node:fs` | file I/O |
| `Bun.sleep` | timer-based sleeps | retry/backoff — **done** (scraper `sleep` helper) |

- ~~CI gains a Bun lane alongside the Node lanes.~~ **Done** — `check-bun`
  job (ubuntu, `bun test`) gates `ci-success`.
- ~~Bonus: `bun build --compile crawlio-mcp` → standalone single-file binary
  shipped as a release artifact.~~ **Done** — `bun run build:bin`
  (`scripts/build-bin.ts`) compiles `crawlio` + `crawlio-mcp` into
  `dist-bin/` (engine peers stay external; the version is
  `--define`-stamped from package.json); the `check-bun` lane builds both
  and boots them with `--help`/`--version`. Shipping them as release
  artifacts stays with Phase 3.

## Phase 2 — Dependency reduction

Goal: minimal/zero runtime deps. Peer deps untouched — they stay opt-in.
Ordered by effort:

| Dep | Plan | Effort |
| --- | --- | --- |
| `p-limit` / `p-retry` | Hand-roll — tests already exist | easy |
| `robots-parser` | Own parser, faithful to Google's spec (allow/disallow, wildcards, longest-match) | medium |
| `undici` | Node lane only — Bun fetch has native `proxy:` | easy/med |
| `cheerio` | Extraction seam with two backends — see caveat | hard |

**The cheerio caveat.** Bun's `HTMLRewriter` covers FieldSpec extraction
(`{selector, attr, all}`) but is Bun-only, so extraction becomes a seam with
two backends: HTMLRewriter on Bun, cheerio stays on the Node lane. Net:
zero runtime deps on Bun, one internal dep on Node. Writing a from-scratch
HTML parser is explicitly a non-goal.

## Phase 3 — Publish

- Tag → `npm publish --provenance` + release workflow.
- Gate: phases 1–2 merged, CI green.

## Non-goals

- **No browser actions, ever** — rendering is read-only.
- **No own search index** — `search` delegates to external providers.
- **Nothing hosted** — no API keys, no cloud component.
