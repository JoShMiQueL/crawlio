<!-- Context: project/commands | Priority: critical -->

# Commands

Stack: TypeScript 5.9, `tsc`-only build (no bundler), ESM-only, Biome, vitest, pnpm.
Run commands from the repo root.

| Command | Purpose |
| --- | --- |
| `pnpm lint` | Biome lint + format check |
| `pnpm lint:fix` | Biome with `--write` (safe autofix) |
| `pnpm format` | Biome format only, `--write` |
| `pnpm typecheck` | `tsc --noEmit` **and** `tsc --noEmit -p tsconfig.test.json` — the typecheck step (Biome does not typecheck) |
| `pnpm test` | vitest, single run |
| `pnpm test:types` | `tsc --noEmit -p tsconfig.test.json` — type-level assertions only |
| `pnpm test:watch` | vitest in watch mode |
| `pnpm test:coverage` | vitest with coverage |
| `pnpm build` | `tsc -p tsconfig.build.json` → `dist/` |
| `pnpm check` | lint + typecheck + test |
| `pnpm check:pack` | publint + arethetypeswrong on the packed tarball |
| `pnpm clean` | remove `dist/` |

## Type-level tests are not vitest tests

`test/types.test.ts` contains `expectTypeOf`-only assertions. They are erased at
runtime — vitest reports them as passing without checking anything — and are enforced
by `pnpm typecheck` / `pnpm test:types` (i.e. by `tsc`, not by vitest).

Do not read the vitest count as the whole coverage picture: subtract the type-only
tests, or run `pnpm test:types` when you touch `src/types.ts` or any generic
signature.

## Verify before reporting done

Run `pnpm check` (and `pnpm build` when dist output matters) and report real output.
