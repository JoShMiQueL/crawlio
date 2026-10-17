import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectSearchProviderFromEnv,
  loadRendererAdapter,
  loadSearchProviderAdapter,
  resolveSearchProviderFlag,
} from "../src/cli-args.js";
import { ConfigError, type SearchProvider } from "../src/index.js";

/** Provider env vars must never leak a developer's real key into tests. */
const ENV_KEYS = ["BRAVE_API_KEY", "SERPER_API_KEY", "TAVILY_API_KEY"] as const;
const savedEnv = ENV_KEYS.map((name) => [name, process.env[name]] as const);

let tmpDir: string | undefined;
afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (tmpDir !== undefined) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

/** Write a temp .mjs fixture and return its absolute-path specifier. */
function fixture(name: string, source: string): string {
  tmpDir ??= mkdtempSync(join(tmpdir(), "crawlio-adapter-"));
  const file = join(tmpDir, name);
  writeFileSync(file, source);
  return file;
}

describe("detectSearchProviderFromEnv — deterministic env order", () => {
  it("maps each API-key env var to its provider name", () => {
    expect(detectSearchProviderFromEnv({ BRAVE_API_KEY: "k" })).toBe("brave");
    expect(detectSearchProviderFromEnv({ SERPER_API_KEY: "k" })).toBe("serper");
    expect(detectSearchProviderFromEnv({ TAVILY_API_KEY: "k" })).toBe("tavily");
  });

  it("resolves BRAVE → SERPER → TAVILY precedence when several are set", () => {
    expect(detectSearchProviderFromEnv({ SERPER_API_KEY: "s", TAVILY_API_KEY: "t" })).toBe(
      "serper",
    );
    expect(
      detectSearchProviderFromEnv({
        BRAVE_API_KEY: "b",
        SERPER_API_KEY: "s",
        TAVILY_API_KEY: "t",
      }),
    ).toBe("brave");
  });

  it("returns undefined when none is set — blank strings do not count", () => {
    expect(detectSearchProviderFromEnv({})).toBeUndefined();
    expect(detectSearchProviderFromEnv({ BRAVE_API_KEY: "   " })).toBeUndefined();
  });
});

describe("resolveSearchProviderFlag — --provider vs env detection", () => {
  it("passes built-in names through untouched", async () => {
    for (const name of ["brave", "serper", "tavily"] as const) {
      expect(await resolveSearchProviderFlag(name)).toBe(name);
    }
  });

  it("auto-detects from env when --provider is absent", async () => {
    process.env.SERPER_API_KEY = "env-key";
    expect(await resolveSearchProviderFlag(undefined)).toBe("serper");
  });

  it("is a ConfigError naming all three env vars when nothing resolves", async () => {
    for (const name of ENV_KEYS) delete process.env[name];
    const error = await resolveSearchProviderFlag(undefined).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as ConfigError).message;
    expect(message).toContain("--provider");
    expect(message).toContain("BRAVE_API_KEY");
    expect(message).toContain("SERPER_API_KEY");
    expect(message).toContain("TAVILY_API_KEY");
  });

  it("rejects --api-key with a module specifier BEFORE importing it", async () => {
    // The specifier does not exist — an attempted import would fail with
    // "could not load adapter module". Getting the --api-key error instead
    // proves the flag check ran first and no adapter code executed.
    const error = await resolveSearchProviderFlag("./nonexistent/provider.mjs", "some-key").then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain("--api-key");
    expect((error as ConfigError).message).not.toContain("could not load");
  });

  it("still loads a module specifier when --api-key is absent", async () => {
    const spec = fixture(
      "provider-nokey.mjs",
      `export default { search: async () => [{ url: "https://ok.example/" }] };`,
    );
    const provider = await resolveSearchProviderFlag(spec);
    expect(typeof provider).not.toBe("string");
    expect(await (provider as SearchProvider).search("q")).toEqual([
      { url: "https://ok.example/" },
    ]);
  });
});

describe("loadSearchProviderAdapter — --provider module specifiers", () => {
  it("loads a default-exported provider and hands it real calls", async () => {
    const spec = fixture(
      "provider-default.mjs",
      `export default {
         async search(query, options) {
           return [{ url: "https://hit.example/", title: query, description: String(options?.limit) }];
         },
       };`,
    );
    const provider = await loadSearchProviderAdapter(spec);
    const results = await provider.search("hello", { limit: 7 });
    expect(results).toEqual([{ url: "https://hit.example/", title: "hello", description: "7" }]);
  });

  it("loads a named `searchProvider` or `provider` export", async () => {
    const namedSpec = fixture(
      "provider-named.mjs",
      `export const searchProvider = { search: async () => [{ url: "https://n.example/" }] };`,
    );
    const provider = await loadSearchProviderAdapter(namedSpec);
    expect(await provider.search("q")).toEqual([{ url: "https://n.example/" }]);

    const aliasSpec = fixture(
      "provider-alias.mjs",
      `export const provider = { search: async () => [{ url: "https://a.example/" }] };`,
    );
    expect(await (await loadSearchProviderAdapter(aliasSpec)).search("q")).toEqual([
      { url: "https://a.example/" },
    ]);
  });

  it("accepts file: URL specifiers", async () => {
    const spec = pathToFileURL(
      fixture("provider-fileurl.mjs", `export default { search: async () => [] };`),
    ).href;
    expect(await (await loadSearchProviderAdapter(spec)).search("q")).toEqual([]);
  });

  it("rejects a wrong-shaped module, naming the expected exports", async () => {
    for (const source of [
      `export default { notSearch: true };`,
      `export const searchProvider = { search: "not a function" };`,
      `export const unrelated = 1;`,
    ]) {
      const spec = fixture(`bad-${Math.random().toString(36).slice(2)}.mjs`, source);
      const error = await loadSearchProviderAdapter(spec).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain("search(query, options)");
      expect((error as ConfigError).message).toContain("searchProvider");
    }
  });

  it("lets a wrong-shaped default win over a valid named export — deterministic", async () => {
    const spec = fixture(
      "provider-shadow.mjs",
      `export default { bogus: true };
       export const searchProvider = { search: async () => [] };`,
    );
    await expect(loadSearchProviderAdapter(spec)).rejects.toBeInstanceOf(ConfigError);
  });

  it("reports a missing module as ConfigError, not a raw import error", async () => {
    await expect(
      loadSearchProviderAdapter("/nonexistent/path/provider.mjs"),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("loadRendererAdapter — --renderer module specifiers", () => {
  it("loads a default-exported { render } object and calls it", async () => {
    const spec = fixture(
      "renderer-default.mjs",
      `export default {
         async render(url, options) {
           return { url, html: "<h1>r</h1>", status: 200, ua: options?.userAgent };
         },
       };`,
    );
    const renderer = await loadRendererAdapter(spec);
    const page = await renderer.render("https://x.example/", { userAgent: "UA" });
    expect(page.url).toBe("https://x.example/");
    expect(page.html).toContain("<h1>r</h1>");
  });

  it("loads a named `renderer` export including optional close()", async () => {
    const spec = fixture(
      "renderer-named.mjs",
      `export const renderer = {
         render: async (url) => ({ url, html: "" }),
         close: async () => { globalThis.__closed = true; },
       };`,
    );
    const renderer = await loadRendererAdapter(spec);
    await (renderer as typeof renderer & { close?: () => Promise<void> }).close?.();
    expect((globalThis as Record<string, unknown>).__closed).toBe(true);
    delete (globalThis as Record<string, unknown>).__closed;
  });

  it("rejects a wrong-shaped module, naming the expected shape", async () => {
    const spec = fixture("renderer-bad.mjs", `export default { render: "not a function" };`);
    const error = await loadRendererAdapter(spec).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain("render(url, options)");
    expect((error as ConfigError).message).toContain("renderer");
  });

  it("reports a missing module as ConfigError", async () => {
    await expect(loadRendererAdapter("./does/not/exist.mjs")).rejects.toBeInstanceOf(ConfigError);
  });
});
