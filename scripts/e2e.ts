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
 * playwright-core` + `npx playwright-core install chromium`, then
 * `install --engine puppeteer` → `puppeteer-core` +
 * `npx puppeteer browsers install chrome` — that install IS the
 * puppeteer dogfood) → `CRAWLIO_E2E=1 bun test` on a copy of
 * e2e/render.test.ts, whose `crawlio` and `crawlio/playwright` /
 * `crawlio/puppeteer` imports then resolve through the exports map
 * exactly like a real consumer's → the packed bin scrapes a loopback
 * node:http page under node — the bin's real shebang runtime — proving
 * args → fetch → extract end-to-end on the node lane.
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
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
  // The other engine path through the same packed bin: `npm install
  // --save-dev puppeteer-core` + `npx puppeteer browsers install chrome`
  // (the puppeteer peer-dep install + browser download is the dogfood).
  // --with-deps stays playwright-only — `puppeteer browsers install` has
  // no system-deps step and `crawlio install` rejects the flag for it.
  await step("crawlio install --engine puppeteer", () =>
    $`node node_modules/crawlio/dist/cli.js install --engine puppeteer`.cwd(consumer),
  );

  copyFileSync("e2e/render.test.ts", join(consumer, "render.test.ts"));
  await step("bun test (consumer)", () =>
    $`bun test render.test.ts`.cwd(consumer).env({ ...process.env, CRAWLIO_E2E: "1" }),
  );

  // CLI bin e2e: the packed bin under node — its real shebang runtime —
  // scraping a loopback page. The bun test above proves the library
  // surface; this proves the shipped bin's arg parse → fetch → extract
  // on the node lane a real `npx crawlio` consumer runs.
  const page =
    "<!doctype html><html><head><title>crawlio bin e2e</title></head>" +
    "<body><h1>cli bin heading</h1></body></html>";
  const cli = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/robots.txt") {
      // `scrape` honors robots.txt by default — allow-all, not the page HTML.
      res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nAllow: /\n");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
  });
  try {
    const base = await new Promise<string>((resolve) => {
      cli.listen(0, "127.0.0.1", () => {
        const { port } = cli.address() as AddressInfo;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
    await step("consumer bin: crawlio scrape (node)", async () => {
      // `--fields` uses the parseFieldsSpec mini-syntax USAGE documents:
      // `name=selector` entries, ';'-separated.
      const fields = "title=title;heading=h1";
      const stdout =
        await $`node node_modules/crawlio/dist/cli.js scrape ${base} --fields ${fields}`
          .cwd(consumer)
          .text();
      if (!stdout.includes("crawlio bin e2e") || !stdout.includes("cli bin heading")) {
        throw new Error(`bin scrape stdout is missing the extracted fields:\n${stdout}`);
      }
      process.stdout.write(stdout);
    });
  } finally {
    await new Promise<void>((resolve) => cli.close(() => resolve()));
  }
  console.log("e2e ok");
} finally {
  rmSync(consumer, { recursive: true, force: true });
  rmSync(tgz, { force: true });
}
