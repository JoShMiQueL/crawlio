import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/index.js";
import type { PuppeteerRendererOptions } from "../src/render/puppeteer.js";
import { puppeteerRenderer } from "../src/render/puppeteer.js";

type PuppeteerCore = typeof import("puppeteer-core");

const RENDERED_HTML = `<!doctype html><html><body><div id="root"><h1>Rendered title</h1>
  <p>Content that only exists after JavaScript ran.</p><span class="only-rendered">from the engine</span>
  </div></body></html>`;

describe("puppeteerRenderer adapter", () => {
  /** A stub `puppeteer-core` module — no real browser is launched. */
  function fakePuppeteerModule(html = RENDERED_HTML) {
    const state = {
      launches: 0,
      contexts: 0,
      contextsClosed: 0,
      browserClosed: false,
      lastUserAgent: undefined as string | undefined,
      lastGoto: undefined as { url: string; options?: unknown } | undefined,
      launchOptions: undefined as unknown,
    };
    const page = {
      setUserAgent: async (options: { userAgent?: string }) => {
        state.lastUserAgent = options.userAgent;
      },
      goto: async (url: string, options?: unknown) => {
        state.lastGoto = { url, options };
        return { status: () => 200 };
      },
      content: async () => html,
      url: () => "https://example.com/rendered",
    };
    const browser = {
      createBrowserContext: async () => {
        state.contexts += 1;
        // Puppeteer's real `BrowserContext.close()` is NOT idempotent —
        // every call sends `Target.disposeBrowserContext`. Counting raw
        // calls here means a double-close (abort hook + `finally`) fails
        // the `contextsClosed` assertions below.
        return {
          newPage: async () => page,
          close: async () => {
            state.contextsClosed += 1;
          },
        };
      },
      close: async () => {
        state.browserClosed = true;
      },
    };
    const mod = {
      launch: async (options?: unknown) => {
        state.launches += 1;
        state.launchOptions = options;
        return browser;
      },
    } as unknown as PuppeteerCore;
    return { mod, state };
  }

  function withFakeModule(state: ReturnType<typeof fakePuppeteerModule>) {
    return {
      __loadPuppeteer: async () => state.mod,
    } as PuppeteerRendererOptions;
  }

  it("does not launch a browser at construction — lazy on first render", async () => {
    const fake = fakePuppeteerModule();
    let loads = 0;
    const renderer = puppeteerRenderer({
      __loadPuppeteer: async () => {
        loads += 1;
        return fake.mod;
      },
    } as PuppeteerRendererOptions);
    expect(loads).toBe(0);
    await renderer.close();
    expect(loads).toBe(0);
    expect(fake.state.launches).toBe(0);
  });

  it("launches once, reuses the browser, and closes each context", async () => {
    const fake = fakePuppeteerModule();
    const renderer = puppeteerRenderer(withFakeModule(fake));
    const page1 = await renderer.render("https://example.com/a", {
      timeout: 5000,
      userAgent: "test-agent",
    });
    const page2 = await renderer.render("https://example.com/b");
    expect(page1.html).toContain("from the engine");
    expect(page1.url).toBe("https://example.com/rendered");
    expect(page1.status).toBe(200);
    expect(fake.state.launches).toBe(1);
    // Ephemeral context per render call — isolation by default.
    expect(fake.state.contexts).toBe(2);
    expect(fake.state.contextsClosed).toBe(2);
    expect(page2.html).toBe(page1.html);
    await renderer.close();
    expect(fake.state.browserClosed).toBe(true);
  });

  it("applies the caller's userAgent and timeout to the navigation", async () => {
    const fake = fakePuppeteerModule();
    const renderer = puppeteerRenderer(withFakeModule(fake));
    await renderer.render("https://example.com/", {
      timeout: 7777,
      userAgent: "agent-x/9",
    });
    expect(fake.state.lastUserAgent).toBe("agent-x/9");
    expect(fake.state.lastGoto?.options).toMatchObject({
      waitUntil: "load",
      timeout: 7777,
    });
  });

  it("wraps a missing puppeteer-core into a ConfigError naming the install", async () => {
    const renderer = puppeteerRenderer({
      __loadPuppeteer: () =>
        Promise.reject(
          Object.assign(new Error("Cannot find package 'puppeteer-core'"), {
            code: "ERR_MODULE_NOT_FOUND",
          }),
        ),
    } as PuppeteerRendererOptions);
    const err = await renderer.render("https://example.com/").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toContain("pnpm add puppeteer-core");
  });

  it("rejects executablePath and channel together at construction", () => {
    expect(() => puppeteerRenderer({ executablePath: "/bin/browser", channel: "chrome" })).toThrow(
      ConfigError,
    );
  });

  it("rejects an unknown waitUntil state at construction", () => {
    expect(() => puppeteerRenderer({ waitUntil: "networkidle" as "load" })).toThrow(ConfigError);
  });

  it("rejects a channel outside puppeteer's release-channel union", () => {
    expect(() => puppeteerRenderer({ channel: "nightly" })).toThrow(ConfigError);
    // "msedge" is a Playwright channel — the error names it explicitly.
    expect(() => puppeteerRenderer({ channel: "msedge" })).toThrow(/msedge.*Playwright/);
  });

  it("passes a valid channel through to launch", async () => {
    const fake = fakePuppeteerModule();
    const renderer = puppeteerRenderer({ ...withFakeModule(fake), channel: "chrome-beta" });
    await renderer.render("https://example.com/");
    expect(fake.state.launchOptions).toMatchObject({ channel: "chrome-beta" });
    await renderer.close();
  });

  it("a caller abort surfaces as AbortError, not the engine's error", async () => {
    const fake = fakePuppeteerModule();
    const controller = new AbortController();
    const renderer = puppeteerRenderer(withFakeModule(fake));
    // Abort before render: the signal check fires before any engine work.
    controller.abort();
    const err = await renderer
      .render("https://example.com/", { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("AbortError");
    expect(fake.state.launches).toBe(0);
  });

  it("an abort mid-navigation closes the context and surfaces AbortError", async () => {
    const controller = new AbortController();
    const state = {
      contexts: 0,
      contextsClosed: 0,
    };
    const page = {
      setUserAgent: async () => undefined,
      goto: async () => {
        controller.abort();
        throw new Error("Target closed");
      },
      content: async () => "",
      url: () => "https://example.com/",
    };
    // Count every close call: real puppeteer has no idempotent close, so a
    // second call would be a second `Target.disposeBrowserContext`.
    const context = {
      newPage: async () => page,
      close: async () => {
        state.contextsClosed += 1;
      },
    };
    const browser = {
      createBrowserContext: async () => {
        state.contexts += 1;
        return context;
      },
      close: async () => undefined,
    };
    const renderer = puppeteerRenderer({
      __loadPuppeteer: async () => ({ launch: async () => browser }) as unknown as PuppeteerCore,
    } as PuppeteerRendererOptions);
    const err = await renderer
      .render("https://example.com/", { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("AbortError");
    expect(state.contextsClosed).toBe(1);
  });

  it("re-launches after close", async () => {
    const fake = fakePuppeteerModule();
    const renderer = puppeteerRenderer(withFakeModule(fake));
    await renderer.render("https://example.com/");
    await renderer.close();
    expect(fake.state.browserClosed).toBe(true);
    await renderer.render("https://example.com/");
    expect(fake.state.launches).toBe(2);
    await renderer.close();
  });
});
