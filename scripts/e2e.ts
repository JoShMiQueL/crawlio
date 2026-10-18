/**
 * Packed-tarball consumer e2e — run via `bun run e2e` (Bun only, like
 * build-bin.ts).
 *
 * Proves the artifact AND the documented first-run path, not src/:
 * `bun run build` → `npm pack` → a throwaway consumer project in
 * os.tmpdir() (the repo tree stays clean — no fixture project, no
 * .gitignore churn) that `npm install`s the `crawlio-<version>.tgz`
 * tarball → the packed bin does the engine setup itself (`node
 * node_modules/crawlio/dist/cli.js install` → `npm install --save-dev
 * playwright-core` + `npx playwright-core install chromium`) →
 * `CRAWLIO_E2E=1 bun test` on a copy of e2e/render.test.ts, whose
 * `crawlio` and `crawlio/playwright` imports then resolve through the
 * exports map exactly like a real consumer's.
 *
 * The consumer uses npm — not bun — on purpose: `npm install` writes a
 * package-lock.json, so `crawlio install`'s lockfile sniff picks npm
 * (the most common consumer PM) and emits `npx` — which works
 * identically on Windows-local and ubuntu-CI, unlike bunx's .bin shim
 * lookup (verified broken on Windows).
 *
 * `--with-deps` (CI, Linux only) forwards to `crawlio install`, which
 * passes it through to `playwright-core install` so it also apt-installs
 * chromium's system libraries.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import pkg from "../package.json" with { type: "json" };

const withDeps = process.argv.includes("--with-deps");
const tgz = `crawlio-${pkg.version}.tgz`;
const consumer = mkdtempSync(join(tmpdir(), "crawlio-e2e-"));

/** Fail-fast step runner — labels the phase so a ShellError has context. */
async function step(name: string, run: () => Promise<unknown>): Promise<void> {
  console.log(`==> ${name}`);
  try {
    await run();
  } catch (error) {
    console.error(`e2e: step failed — ${name}`);
    throw error;
  }
}

try {
  await step("bun run build", () => $`bun run build`);
  // --ignore-scripts: `prepack` (full check + rebuild) would run inside
  // npm pack otherwise — the build above already produced dist/.
  await step("npm pack", () => $`npm pack --ignore-scripts`);
  if (!existsSync(tgz)) throw new Error(`npm pack did not produce ${tgz}`);

  writeFileSync(join(consumer, "package.json"), '{ "private": true, "type": "module" }\n');
  // npm, not bun: the package-lock.json it writes makes `crawlio install`
  // detect npm — the PM branch worth dogfooding (see the header comment).
  await step(`consumer install (${consumer})`, () => $`npm install ${resolve(tgz)}`.cwd(consumer));
  // The REAL packed bin runs the first-run setup — bin entry, PM
  // detection, peer-dep install, browser download. `crawlio install`
  // inherits stdio, so its child output streams through.
  await step("crawlio install", () =>
    withDeps
      ? $`node node_modules/crawlio/dist/cli.js install --with-deps`.cwd(consumer)
      : $`node node_modules/crawlio/dist/cli.js install`.cwd(consumer),
  );

  copyFileSync("e2e/render.test.ts", join(consumer, "render.test.ts"));
  await step("bun test (consumer)", () =>
    $`bun test render.test.ts`.cwd(consumer).env({ ...process.env, CRAWLIO_E2E: "1" }),
  );
  console.log("e2e ok");
} finally {
  rmSync(consumer, { recursive: true, force: true });
  rmSync(tgz, { force: true });
}
