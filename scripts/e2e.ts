/**
 * Packed-tarball consumer e2e — run via `bun run e2e` (Bun only, like
 * build-bin.ts).
 *
 * Proves the artifact we actually ship, not src/: `bun run build` →
 * `npm pack` → a throwaway consumer project in os.tmpdir() (the repo
 * tree stays clean — no fixture project, no .gitignore churn) that
 * `bun add`s the `crawlio-<version>.tgz` tarball plus playwright-core →
 * `bunx playwright-core install chromium` → `CRAWLIO_E2E=1 bun test`
 * on a copy of e2e/render.test.ts, whose `crawlio` and
 * `crawlio/playwright` imports then resolve through the exports map
 * exactly like a real consumer's.
 *
 * `--with-deps` (CI, Linux only) forwards to `playwright-core install`
 * so it also apt-installs chromium's system libraries.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";
import pkg from "../package.json" with { type: "json" };

const withDeps = process.argv.includes("--with-deps");
const pwVersion = pkg.devDependencies["playwright-core"];
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
  await step(`consumer install (${consumer})`, () =>
    $`bun add ${resolve(tgz)} playwright-core@${pwVersion}`.cwd(consumer),
  );
  // cli.js directly — bunx's .bin shim lookup breaks on Windows.
  await step("playwright-core install chromium", () =>
    withDeps
      ? $`bun node_modules/playwright-core/cli.js install --with-deps chromium`.cwd(consumer)
      : $`bun node_modules/playwright-core/cli.js install chromium`.cwd(consumer),
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
