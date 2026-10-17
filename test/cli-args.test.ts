import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectPackageManager,
  installCommands,
  packageManagerFromField,
  parseCount,
  parseFieldsSpec,
} from "../src/cli-args.js";
import { ConfigError } from "../src/index.js";

describe("parseFieldsSpec — the --fields mini-syntax", () => {
  it("parses a bare name=selector entry", () => {
    expect(parseFieldsSpec("title=h1")).toEqual({ title: "h1" });
  });

  it("parses the example spec: title=h1;links=a.href@all", () => {
    expect(parseFieldsSpec("title=h1;links=a.href@all")).toEqual({
      title: "h1",
      links: { selector: "a", attr: "href", all: true },
    });
  });

  it("parses the @attr form without a whitelist check", () => {
    expect(parseFieldsSpec("author=meta[name=author]@content")).toEqual({
      author: { selector: "meta[name=author]", attr: "content" },
    });
    // An arbitrary attribute the shorthand whitelist doesn't know still works via @.
    expect(parseFieldsSpec("x=div@data-track")).toEqual({
      x: { selector: "div", attr: "data-track" },
    });
  });

  it("keeps non-attribute .tails inside the selector", () => {
    // "product" is not a known attribute — div.product is a class selector.
    expect(parseFieldsSpec("items=div.product@all")).toEqual({
      items: { selector: "div.product", all: true },
    });
  });

  it("keeps a quoted @ inside attribute brackets", () => {
    expect(parseFieldsSpec('x=a[href*="@"]')).toEqual({ x: 'a[href*="@"]' });
    expect(parseFieldsSpec('x=a[href*="@"]@all')).toEqual({
      x: { selector: 'a[href*="@"]', all: true },
    });
    // An @ AFTER the last ] is still the attr separator.
    expect(parseFieldsSpec('x=a[href*="@"]@target')).toEqual({
      x: { selector: 'a[href*="@"]', attr: "target" },
    });
  });

  it("@all without an attribute means an array of text", () => {
    expect(parseFieldsSpec("titles=h2@all")).toEqual({
      titles: { selector: "h2", all: true },
    });
  });

  it("tolerates whitespace and trailing separators", () => {
    expect(parseFieldsSpec("  title = h1 ; ")).toEqual({ title: "h1" });
  });

  it("rejects malformed entries with ConfigError", () => {
    expect(() => parseFieldsSpec("h1")).toThrow(ConfigError);
    expect(() => parseFieldsSpec("=h1")).toThrow(ConfigError);
    expect(() => parseFieldsSpec("name=")).toThrow(ConfigError);
    expect(() => parseFieldsSpec("name=@all")).toThrow(ConfigError);
    expect(() => parseFieldsSpec("name=a@")).toThrow(ConfigError);
  });
});

describe("parseCount", () => {
  it("returns undefined for an absent flag and parses non-negative integers", () => {
    expect(parseCount(undefined, "--limit")).toBeUndefined();
    expect(parseCount("0", "--limit")).toBe(0);
    expect(parseCount("42", "--limit")).toBe(42);
  });

  it("rejects non-integers and negatives", () => {
    expect(() => parseCount("abc", "--limit")).toThrow(ConfigError);
    expect(() => parseCount("1.5", "--limit")).toThrow(ConfigError);
    expect(() => parseCount("-2", "--limit")).toThrow(ConfigError);
  });

  it("accepts only plain decimal digits — no empty, hex, or exponent forms", () => {
    // Number("") → 0, and "0x10"/"1e3" parse — all must be ConfigErrors.
    expect(() => parseCount("", "--limit")).toThrow(ConfigError);
    expect(() => parseCount("   ", "--limit")).toThrow(ConfigError);
    expect(() => parseCount("0x10", "--limit")).toThrow(ConfigError);
    expect(() => parseCount("1e3", "--limit")).toThrow(ConfigError);
    expect(() => parseCount("+5", "--limit")).toThrow(ConfigError);
    // Surrounding whitespace is tolerated.
    expect(parseCount(" 42 ", "--limit")).toBe(42);
  });
});

describe("package-manager detection", () => {
  it("normalizes the packageManager field", () => {
    expect(packageManagerFromField("pnpm@12.14.0")).toBe("pnpm");
    expect(packageManagerFromField("npm@10.9.0")).toBe("npm");
    expect(packageManagerFromField("bun@1.2.0")).toBe("bun");
    expect(packageManagerFromField("yarn@4.1.0")).toBe("yarn");
    expect(packageManagerFromField("deno@2.0.0")).toBeUndefined();
    expect(packageManagerFromField(undefined)).toBeUndefined();
  });

  it("detects via manifest field, lockfile sniff, then npm fallback", () => {
    const dir = mkdtempSync(join(tmpdir(), "crawlio-cli-"));
    try {
      // No package.json at all → npm fallback.
      expect(detectPackageManager(dir)).toBe("npm");
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
      writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9");
      expect(detectPackageManager(dir)).toBe("pnpm");
      // A packageManager field wins over the lockfile.
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "x", packageManager: "npm@10.0.0" }),
      );
      expect(detectPackageManager(dir)).toBe("npm");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sniffs lockfiles in pnpm → bun → yarn order", () => {
    const dir = mkdtempSync(join(tmpdir(), "crawlio-cli-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
      writeFileSync(join(dir, "yarn.lock"), "");
      expect(detectPackageManager(dir)).toBe("yarn");
      // Either bun lockfile form counts — and bun wins over yarn.lock.
      writeFileSync(join(dir, "bun.lockb"), "");
      expect(detectPackageManager(dir)).toBe("bun");
      rmSync(join(dir, "bun.lockb"));
      writeFileSync(join(dir, "bun.lock"), "");
      expect(detectPackageManager(dir)).toBe("bun");
      // pnpm-lock.yaml outranks everything.
      writeFileSync(join(dir, "pnpm-lock.yaml"), "");
      expect(detectPackageManager(dir)).toBe("pnpm");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("installCommands — the crawlio install plan", () => {
  it("playwright: add playwright-core then playwright-core install <browser>", () => {
    expect(installCommands("playwright", "firefox", "pnpm")).toEqual([
      { command: "pnpm", args: ["add", "-D", "playwright-core"] },
      { command: "pnpm", args: ["dlx", "playwright-core", "install", "firefox"] },
    ]);
  });

  it("puppeteer: add puppeteer-core then puppeteer browsers install chrome", () => {
    expect(installCommands("puppeteer", "chromium", "npm")).toEqual([
      { command: "npm", args: ["install", "--save-dev", "puppeteer-core"] },
      { command: "npx", args: ["puppeteer", "browsers", "install", "chrome"] },
    ]);
  });

  it("bun: `bun add -d` + `bunx` as the npx-equivalent", () => {
    expect(installCommands("puppeteer", "chromium", "bun")).toEqual([
      { command: "bun", args: ["add", "-d", "puppeteer-core"] },
      { command: "bunx", args: ["puppeteer", "browsers", "install", "chrome"] },
    ]);
  });

  it("yarn: `yarn add -D` + `yarn dlx` as the npx-equivalent", () => {
    expect(installCommands("playwright", "chromium", "yarn")).toEqual([
      { command: "yarn", args: ["add", "-D", "playwright-core"] },
      { command: "yarn", args: ["dlx", "playwright-core", "install", "chromium"] },
    ]);
  });
});
