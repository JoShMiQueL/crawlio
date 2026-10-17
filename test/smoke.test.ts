import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_USER_AGENT, VERSION } from "../src/index.js";

describe("smoke", () => {
  it("exposes the package version", () => {
    expect(typeof VERSION).toBe("string");
  });

  it("keeps VERSION in sync with package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
    expect(DEFAULT_USER_AGENT).toBe(`crawlio/${pkg.version}`);
  });
});
