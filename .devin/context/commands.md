<!-- Context: project/commands | Priority: critical -->

# Commands

Stack: TypeScript 5.9, `tsc`-only build (no bundler), ESM-only, Biome, vitest, bun.
Run commands from the repo root.

| Command | Purpose |
| --- | --- |
| `bun install` | install deps (`bun.lock` is the canonical lockfile) |
| `bun run lint` | Biome lint + format check |
| `bun run lint:fix` | Biome with `--write` (safe autofix) |
| `bun run format` | Biome format only, `--write` |
| `bun run typecheck` | `tsc --noEmit` **and** `tsc --noEmit -p tsconfig.test.json` — the typecheck step (Biome does not typecheck) |
| `bun test` | bun:test — Bun's own runner (NOT vitest); the CI bun-lane suite |
| `bun run test` | vitest, single run — the `vitest` .bin shim executes it under node, so this is the SAME lane as `npm run test` |
| `bun run test:types` | `tsc --noEmit -p tsconfig.test.json` — type-level assertions only |
| `bun run test:watch` | vitest in watch mode |
| `bun run test:coverage` | vitest with coverage |
| `bun run build` | `tsc -p tsconfig.build.json` → `dist/` |
| `bun run check` | lint + typecheck + test |
| `bun run check:pack` | publint + arethetypeswrong on the packed tarball |
| `bun run clean` | remove `dist/` |
| `bunx <cmd>` | one-off binaries without installing |

Node-lane verification: the library is dual-runtime, so the same steps must
also work under node — `npm run lint|typecheck|test|build` (`npm run`/`npx`
spawn the `.bin` shims with their node shebang; `bun run`/`bunx` would run
them under Bun).

## Type-level tests are not vitest tests

`test/types.test.ts` contains `expectTypeOf`-only assertions. They are erased at
runtime — vitest reports them as passing without checking anything — and are enforced
by `bun run typecheck` / `bun run test:types` (i.e. by `tsc`, not by vitest).

Do not read the vitest count as the whole coverage picture: subtract the type-only
tests, or run `bun run test:types` when you touch `src/types.ts` or any generic
signature.

## Verify before reporting done

Run `bun run check` (and `bun run build` when dist output matters) and report real output.
