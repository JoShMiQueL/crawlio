import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Repository hygiene guards.
 *
 * These pin two conventions that are otherwise only "please remember":
 * test sources stay plain-text and import the public surface from `../src/index.js`.
 */
const testDir = import.meta.dirname;
const testSources = readdirSync(testDir)
  .filter((name) => name.endsWith(".ts"))
  .map((name) => ({ name, text: readFileSync(join(testDir, name), "utf8") }));

describe("test source hygiene", () => {
  it("finds the suites it is guarding", () => {
    expect(testSources.length).toBeGreaterThan(4);
  });

  it("contains no raw control characters", () => {
    // A literal NUL or similar makes editors and file-reading tools treat the file as
    // binary; escapes like "\u0000" must be used instead.
    const offenders = testSources.flatMap(({ name, text }) =>
      [...text]
        .map((char, index) => ({ char, index }))
        .filter(({ char }) => {
          const code = char.codePointAt(0) ?? 0;
          return code < 0x20 && char !== "\n" && char !== "\r" && char !== "\t";
        })
        .map(({ index }) => `${name}:${index}`),
    );
    expect(offenders).toEqual([]);
  });

  it("imports the public surface from ../src/index.js", () => {
    // Sanctioned submodule imports: src/errors.js holds the internal
    // scrubUrl() helper that is deliberately not part of the public API,
    // src/cli-args.js holds the CLI's pure helpers (the CLI is a bin entry,
    // not library surface), src/mcp-*.js are the `crawlio-mcp` binary's
    // layers (likewise a bin entry, not library surface), src/proxy.js
    // holds the internal proxyRequestInit seam — the runtime-branched
    // RequestInit extension that is deliberately not public API —
    // src/runtime.js holds `isBun`, which IS public API (index.js
    // re-exports it and the CHANGELOG documents it) — tests import the
    // source module directly so the runtime seam stays explicit;
    // src/robots-parser.js is the internal
    // RFC 9309 parser exercised directly by its spec-matrix suite,
    // src/private-hosts.js is the internal
    // private-IP classifier unit-tested at its own seam (like robots-parser),
    // src/robots.js holds the fetchRobotsTxtResult kind-triplet and the
    // ROBOTS_MAX_BODY_BYTES cap the body-limit suite asserts on,
    // src/captcha.js holds detectChallenge — the internal marker-matching
    // seam the scraper calls when a solver is configured; the live suite
    // asserts it fires (or doesn't) on a real anti-bot response, and
    // src/render/*.js are the
    // `crawlio/playwright` and `crawlio/puppeteer` subpath exports — they
    // cannot come through index.js because their peer deps must stay
    // optional.
    const allowed = new Set([
      "../src/captcha.js",
      "../src/cli-args.js",
      "../src/errors.js",
      "../src/mcp-server.js",
      "../src/mcp-tools.js",
      "../src/private-hosts.js",
      "../src/proxy.js",
      "../src/render/playwright.js",
      "../src/render/puppeteer.js",
      "../src/robots.js",
      "../src/robots-parser.js",
      "../src/runtime.js",
    ]);
    const offenders = testSources.flatMap(({ name, text }) =>
      [...text.matchAll(/from "(\.\.\/src\/[^"]+)"/g)]
        .map((match) => match[1] as string)
        .filter((specifier) => !specifier.endsWith("/index.js") && !allowed.has(specifier))
        .map((specifier) => `${name} imports ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });
});
