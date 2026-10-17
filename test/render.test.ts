import { describe, expect, it, vi } from "vitest";
import type { RenderCallOptions, Renderer } from "../src/index.js";
import { ConfigError, createScraper, FetchError, RobotsError, ScrapeError } from "../src/index.js";
import type { PlaywrightRendererOptions } from "../src/render/playwright.js";
import { playwrightRenderer } from "../src/render/playwright.js";

type FetchImpl = typeof globalThis.fetch;
type PlaywrightCore = typeof import("playwright-core");

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };

/** A JavaScript app shell: empty #root + a script — isLikelyDynamic says true. */
const SHELL_HTML = `<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>`;

/** A populated static page: real body text, no shell markers. */
const POPULATED_HTML = `<!doctype html><html><body><h1>About us</h1>
  <p>Plain static content with well over fifty characters of real text, so
  the near-empty-body signal does not fire either.</p></body></html>`;

const RENDERED_HTML = `<!doctype html><html><body><div id="root"><h1>Rendered title</h1>
  <p>Content that only exists after JavaScript ran.</p><span class="only-rendered">from the engine</span>
  </div></body></html>`;

/** A fetch mock that always serves `body` with the given status. */
function staticFetch(body: string, status = 200, headers: Record<string, string> = HTML_HEADERS) {
  const calls: string[] = [];
  const impl: FetchImpl = (async (input: unknown) => {
    calls.push(String(input));
    return new Response(body, { status, headers });
  }) as FetchImpl;
  return { impl, calls };
}

/** A fake {@link Renderer} serving canned HTML; `calls` records invocations. */
function fakeRenderer(html: string, options?: { status?: number; fail?: () => Error }) {
  const calls: Array<{ url: string; options?: RenderCallOptions }> = [];
  const renderer: Renderer = {
    render: async (url, callOptions) => {
      calls.push({ url, options: callOptions });
      if (options?.fail !== undefined) throw options.fail();
      return { url, html, ...(options?.status === undefined ? {} : { status: options.status }) };
    },
  };
  return { renderer, calls };
}

describe("render seam — auto mode", () => {
  it("renders when the static page is a JS shell", async () => {
    const fetchMock = staticFetch(SHELL_HTML);
    const fake = fakeRenderer(RENDERED_HTML);
    const scraper = createScraper({
      fetch: fetchMock.impl,
      robots: false,
      render: fake.renderer,
    });
    const result = await scraper.fetchHtml("https://example.com/");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toBe("https://example.com/");
    expect(result.html).toContain("from the engine");
    expect(result.rendered).toBe(true);
  });

  it("does NOT render when the static page is populated", async () => {
    const fetchMock = staticFetch(POPULATED_HTML);
    const fake = fakeRenderer(RENDERED_HTML);
    const scraper = createScraper({
      fetch: fetchMock.impl,
      robots: false,
      render: fake.renderer,
    });
    const result = await scraper.fetchHtml("https://example.com/");
    expect(fake.calls).toHaveLength(0);
    expect(result.html).toContain("About us");
    expect(result.rendered).toBeUndefined();
  });

  it("renders when a fields spec extracts to all-undefined, even without shell signals", async () => {
    const fetchMock = staticFetch(POPULATED_HTML);
    const fake = fakeRenderer(RENDERED_HTML);
    const scraper = createScraper({
      fetch: fetchMock.impl,
      robots: false,
      render: fake.renderer,
    });
    const data = await scraper.scrape("https://example.com/", {
      injected: ".only-rendered",
      missing: ".nope",
    });
    expect(fake.calls).toHaveLength(1);
    // The fields were extracted from the RENDERED document.
    expect(data.injected).toBe("from the engine");
    expect(data.missing).toBeUndefined();
  });

  it("does NOT render when the fields extract fine from the static page", async () => {
    const fetchMock = staticFetch(POPULATED_HTML);
    const fake = fakeRenderer(RENDERED_HTML);
    const scraper = createScraper({
      fetch: fetchMock.impl,
      robots: false,
      render: fake.renderer,
    });
    const data = await scraper.scrape("https://example.com/", { title: "h1" });
    expect(fake.calls).toHaveLength(0);
    expect(data.title).toBe("About us");
  });

  it("renders when a scrapeAll spec matches no containers on the static page", async () => {
    const fetchMock = staticFetch(POPULATED_HTML);
    const fake = fakeRenderer(
      `<html><body><div class="item"><span class="name">first</span></div>
       <div class="item"><span class="name">second</span></div></body></html>`,
    );
    const scraper = createScraper({
      fetch: fetchMock.impl,
      robots: false,
      render: fake.renderer,
    });
    const items = await scraper.scrapeAll("https://example.com/", ".item", { name: ".name" });
    expect(fake.calls).toHaveLength(1);
    expect(items).toHaveLength(2);
    expect(items[0]?.name).toBe("first");
  });

  it("falls back to the static result when the render fails", async () => {
    const fetchMock = staticFetch(SHELL_HTML);
    const fake = fakeRenderer("", { fail: () => new Error("browser exploded") });
    const scraper = createScraper({
      fetch: fetchMock.impl,
      robots: false,
      render: fake.renderer,
    });
    const result = await scraper.fetchHtml("https://example.com/");
    expect(result.html).toBe(SHELL_HTML);
    expect(result.rendered).toBeUndefined();
    expect(fake.calls).toHaveLength(1);
  });

  it("hands the renderer the call's timeout, signal and wire User-Agent", async () => {
    const fetchMock = staticFetch(SHELL_HTML);
    const fake = fakeRenderer(RENDERED_HTML);
    const scraper = createScraper({
      fetch: fetchMock.impl,
      robots: false,
      render: fake.renderer,
      userAgent: "my-agent/1.0",
      timeout: 4242,
    });
    await scraper.fetchHtml("https://example.com/");
    expect(fake.calls[0]?.options?.timeout).toBe(4242);
    expect(fake.calls[0]?.options?.userAgent).toBe("my-agent/1.0");
    expect(fake.calls[0]?.options?.signal).toBeUndefined();
  });

  it("a per-call renderer wins over the instance renderer", async () => {
    const fetchMock = staticFetch(SHELL_HTML);
    const instance = fakeRenderer("<html><body>instance</body></html>");
    const perCall = fakeRenderer(RENDERED_HTML);
    const scraper = createScraper({
      fetch: fetchMock.impl,
      robots: false,
      render: instance.renderer,
    });
    const result = await scraper.fetchHtml("https://example.com/", {
      render: perCall.renderer,
    });
    expect(perCall.calls).toHaveLength(1);
    expect(instance.calls).toHaveLength(0);
    expect(result.html).toContain("from the engine");
  });

  it("does not retry a failed render — `retries` paces the static path only", async () => {
    const fetchMock = staticFetch(SHELL_HTML);
    const fake = fakeRenderer("", { fail: () => new Error("browser exploded") });
    const scraper = createScraper({
      fetch: fetchMock.impl,
      robots: false,
      render: fake.renderer,
      retries: 3,
    });
    const result = await scraper.fetchHtml("https://example.com/");
    // One navigation per render call — p-retry never wraps the engine, so the
    // failure still degrades gracefully to the static result.
    expect(fake.calls).toHaveLength(1);
    expect(fetchMock.calls).toHaveLength(1);
    expect(result.html).toBe(SHELL_HTML);
  });

  it("requestDelay paces the auto-escalation render off the static fetch", async () => {
    let staticAt = 0;
    const impl: FetchImpl = (async () => {
      staticAt = Date.now();
      return new Response(SHELL_HTML, { status: 200, headers: HTML_HEADERS });
    }) as FetchImpl;
    let renderAt = 0;
    const renderer: Renderer = {
      render: async (url) => {
        renderAt = Date.now();
        return { url, html: RENDERED_HTML };
      },
    };
    const random = vi.spyOn(Math, "random").mockReturnValue(0); // → always min
    try {
      const scraper = createScraper({
        fetch: impl,
        robots: false,
        render: renderer,
        requestDelay: { min: 40, max: 500 },
      });
      const result = await scraper.fetchHtml("https://example.com/");
      expect(result.rendered).toBe(true);
    } finally {
      random.mockRestore();
    }
    const gap = renderAt - staticAt;
    // rng=0 ⇒ sampled delay == min (40ms): ≥ ~70% proves the second
    // same-origin request was paced; far-under-max proves the draw rather
    // than the range edge was used — same convention as the delay tests in
    // stealth.test.ts.
    expect(gap).toBeGreaterThanOrEqual(28);
    expect(gap).toBeLessThan(200);
  });

  it("a caller abort during the auto-mode render propagates instead of falling back", async () => {
    const fetchMock = staticFetch(SHELL_HTML);
    const controller = new AbortController();
    const renderer: Renderer = {
      render: async () => {
        // The engine honors the caller's signal mid-navigation.
        controller.abort();
        throw new DOMException("The operation was aborted.", "AbortError");
      },
    };
    const scraper = createScraper({ fetch: fetchMock.impl, robots: false, render: renderer });
    const err = await scraper
      .fetchHtml("https://example.com/", { signal: controller.signal })
      .catch((e: unknown) => e);
    // Not the static fallback — the abort surfaces as the call's error.
    expect(err).toBeInstanceOf(FetchError);
  });
});

describe("render seam — always mode", () => {
  it("skips the static fetch entirely", async () => {
    const fetchMock = staticFetch(POPULATED_HTML);
    const fake = fakeRenderer(RENDERED_HTML);
    const scraper = createScraper({
      fetch: fetchMock.impl,
      robots: false,
      render: fake.renderer,
      renderMode: "always",
    });
    const result = await scraper.fetchHtml("https://example.com/");
    expect(fetchMock.calls).toHaveLength(0);
    expect(fake.calls).toHaveLength(1);
    expect(result.html).toContain("from the engine");
    expect(result.rendered).toBe(true);
  });

  it("propagates a render failure as the call's error", async () => {
    const fetchMock = staticFetch(POPULATED_HTML);
    const fake = fakeRenderer("", { fail: () => new Error("browser exploded") });
    const scraper = createScraper({
      fetch: fetchMock.impl,
      robots: false,
      render: fake.renderer,
      renderMode: "always",
    });
    const err = await scraper.fetchHtml("https://example.com/").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScrapeError);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).cause).toBeInstanceOf(Error);
  });

  it("throws ConfigError when renderMode is 'always' but no renderer is configured", async () => {
    const fetchMock = staticFetch(POPULATED_HTML);
    const scraper = createScraper({ fetch: fetchMock.impl, robots: false });
    const err = await scraper
      .fetchHtml("https://example.com/", { renderMode: "always" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("throws ConfigError for an invalid renderMode", async () => {
    const fetchMock = staticFetch(POPULATED_HTML);
    const scraper = createScraper({ fetch: fetchMock.impl, robots: false });
    const err = await scraper
      .fetchHtml("https://example.com/", {
        renderMode: "sometimes" as "auto",
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
  });
});

describe("render seam — robots gating", () => {
  it("robots.txt still gates the URL before the renderer fires", async () => {
    const calls: string[] = [];
    const impl: FetchImpl = (async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nDisallow: /private", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response(SHELL_HTML, { status: 200, headers: HTML_HEADERS });
    }) as FetchImpl;
    const fake = fakeRenderer(RENDERED_HTML);
    const scraper = createScraper({
      fetch: impl,
      render: fake.renderer,
      renderMode: "always",
    });
    const err = await scraper
      .fetchHtml("https://example.com/private/page")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RobotsError);
    expect(fake.calls).toHaveLength(0);
    // Only robots.txt went out — neither path fetched the page.
    expect(calls).toEqual(["https://example.com/robots.txt"]);
  });
});

describe("playwrightRenderer adapter", () => {
  /** A stub `playwright-core` module — no real browser is launched. */
  function fakePlaywrightModule(html = RENDERED_HTML) {
    const state = {
      launches: 0,
      contexts: 0,
      contextsClosed: 0,
      browserClosed: false,
      lastContextOptions: undefined as unknown,
      lastGoto: undefined as { url: string; options?: unknown } | undefined,
      lastWaitForSelector: undefined as { selector: string; options?: unknown } | undefined,
      events: [] as string[],
      launchOptions: undefined as unknown,
    };
    const page = {
      goto: async (url: string, options?: unknown) => {
        state.events.push("goto");
        state.lastGoto = { url, options };
        return { status: () => 200 };
      },
      waitForSelector: async (selector: string, options?: unknown) => {
        state.events.push(`waitForSelector:${selector}`);
        state.lastWaitForSelector = { selector, options };
      },
      waitForTimeout: async (ms: number) => {
        state.events.push(`waitForTimeout:${ms}`);
      },
      content: async () => {
        state.events.push("content");
        return html;
      },
      url: () => "https://example.com/rendered",
    };
    const context = {
      newPage: async () => page,
      close: async () => {
        state.contextsClosed += 1;
      },
    };
    const browser = {
      newContext: async (options?: unknown) => {
        state.contexts += 1;
        state.lastContextOptions = options;
        return context;
      },
      close: async () => {
        state.browserClosed = true;
      },
    };
    const launch = async (options?: unknown) => {
      state.launches += 1;
      state.launchOptions = options;
      return browser;
    };
    const mod = {
      chromium: { launch },
      firefox: { launch },
      webkit: { launch },
    } as unknown as PlaywrightCore;
    return { mod, state };
  }

  function withFakeModule(state: ReturnType<typeof fakePlaywrightModule>) {
    return {
      __loadPlaywright: async () => state.mod,
    } as PlaywrightRendererOptions;
  }

  it("does not launch a browser at construction — lazy on first render", async () => {
    const fake = fakePlaywrightModule();
    let loads = 0;
    const renderer = playwrightRenderer({
      __loadPlaywright: async () => {
        loads += 1;
        return fake.mod;
      },
    } as PlaywrightRendererOptions);
    expect(loads).toBe(0);
    await renderer.close();
    expect(loads).toBe(0);
    expect(fake.state.launches).toBe(0);
  });

  it("launches once, reuses the browser, and closes each context", async () => {
    const fake = fakePlaywrightModule();
    const renderer = playwrightRenderer(withFakeModule(fake));
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
    expect(fake.state.lastContextOptions).toEqual({});
    expect(page2.html).toBe(page1.html);
    await renderer.close();
    expect(fake.state.browserClosed).toBe(true);
  });

  it("applies the caller's userAgent and timeout to the navigation", async () => {
    const fake = fakePlaywrightModule();
    const renderer = playwrightRenderer(withFakeModule(fake));
    await renderer.render("https://example.com/", {
      timeout: 7777,
      userAgent: "agent-x/9",
    });
    expect(fake.state.lastContextOptions).toEqual({ userAgent: "agent-x/9" });
    expect(fake.state.lastGoto?.options).toMatchObject({
      waitUntil: "load",
      timeout: 7777,
    });
  });

  it("wraps a missing playwright-core into a ConfigError naming the install", async () => {
    const renderer = playwrightRenderer({
      __loadPlaywright: () =>
        Promise.reject(
          Object.assign(new Error("Cannot find package 'playwright-core'"), {
            code: "ERR_MODULE_NOT_FOUND",
          }),
        ),
    } as PlaywrightRendererOptions);
    const err = await renderer.render("https://example.com/").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).message).toContain("pnpm add playwright-core");
  });

  it("rejects executablePath and channel together at construction", () => {
    expect(() => playwrightRenderer({ executablePath: "/bin/browser", channel: "chrome" })).toThrow(
      ConfigError,
    );
  });

  it("rejects an unknown browser name at construction", () => {
    expect(() => playwrightRenderer({ browser: "netscape" as "chromium" })).toThrow(ConfigError);
  });

  it("settles in order: goto → waitForSelector → waitForTimeout → content", async () => {
    const fake = fakePlaywrightModule();
    const renderer = playwrightRenderer({
      ...withFakeModule(fake),
      waitForSelector: "#app h1",
      waitForTimeout: 25,
    });
    await renderer.render("https://example.com/", { timeout: 9000 });
    expect(fake.state.events).toEqual([
      "goto",
      "waitForSelector:#app h1",
      "waitForTimeout:25",
      "content",
    ]);
    // The selector wait shares the navigation timeout budget.
    expect(fake.state.lastWaitForSelector?.options).toMatchObject({ timeout: 9000 });
    await renderer.close();
  });

  it("a per-call waitForSelector/waitForTimeout wins over the renderer options", async () => {
    const fake = fakePlaywrightModule();
    const renderer = playwrightRenderer({
      ...withFakeModule(fake),
      waitForSelector: ".instance",
      waitForTimeout: 50,
    });
    await renderer.render("https://example.com/", {
      waitForSelector: ".per-call",
      waitForTimeout: 5,
    });
    expect(fake.state.events).toEqual([
      "goto",
      "waitForSelector:.per-call",
      "waitForTimeout:5",
      "content",
    ]);
    await renderer.close();
  });

  it("rejects a blank waitForSelector and a junk waitForTimeout at construction", () => {
    expect(() => playwrightRenderer({ waitForSelector: "   " })).toThrow(ConfigError);
    expect(() => playwrightRenderer({ waitForTimeout: -1 })).toThrow(ConfigError);
    expect(() => playwrightRenderer({ waitForTimeout: Number.NaN })).toThrow(ConfigError);
    expect(() => playwrightRenderer({ waitForTimeout: Number.POSITIVE_INFINITY })).toThrow(
      ConfigError,
    );
  });

  it("rejects junk per-call settle options with ConfigError before launching", async () => {
    const fake = fakePlaywrightModule();
    const renderer = playwrightRenderer(withFakeModule(fake));
    const blank = await renderer
      .render("https://example.com/", { waitForSelector: "" })
      .catch((e: unknown) => e);
    const negative = await renderer
      .render("https://example.com/", { waitForTimeout: -1 })
      .catch((e: unknown) => e);
    const nan = await renderer
      .render("https://example.com/", { waitForTimeout: Number.NaN })
      .catch((e: unknown) => e);
    expect(blank).toBeInstanceOf(ConfigError);
    expect(negative).toBeInstanceOf(ConfigError);
    expect(nan).toBeInstanceOf(ConfigError);
    expect(fake.state.launches).toBe(0);
    await renderer.close();
  });

  it("re-launches after close", async () => {
    const fake = fakePlaywrightModule();
    const renderer = playwrightRenderer(withFakeModule(fake));
    await renderer.render("https://example.com/");
    await renderer.close();
    expect(fake.state.browserClosed).toBe(true);
    await renderer.render("https://example.com/");
    expect(fake.state.launches).toBe(2);
    await renderer.close();
  });
});
