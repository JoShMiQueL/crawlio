import { ConfigError } from "../errors.js";
import type { RenderCallOptions, RenderedPage, Renderer } from "../render.js";
import { lazyBrowser } from "./lifecycle.js";
import {
  assertExecutablePathChannelExclusive,
  assertWaitForSelector,
  assertWaitForTimeout,
} from "./validate.js";

/** The lazily-imported `playwright-core` module — a peer dep, never bundled. */
type PlaywrightCore = typeof import("playwright-core");

/** Options for {@link playwrightRenderer}. */
export interface PlaywrightRendererOptions {
  /**
   * Browser engine to launch: `"chromium"` | `"firefox"` | `"webkit"`.
   * Default `"chromium"`.
   */
  browser?: "chromium" | "firefox" | "webkit";
  /**
   * Path to a browser executable, for engines not found by playwright-core's
   * own registry (a system Chrome, a CI image, ...). Mutually exclusive with
   * {@link PlaywrightRendererOptions.channel}.
   */
  executablePath?: string;
  /**
   * Branded browser channel playwright-core resolves itself —
   * `"chrome"`, `"msedge"`, ... Mutually exclusive with
   * {@link PlaywrightRendererOptions.executablePath}.
   */
  channel?: string;
  /** Launch headless. Default `true`. */
  headless?: boolean;
  /**
   * Navigation-settle condition for `page.goto`: `"load"` |
   * `"domcontentloaded"` | `"networkidle"`. Default `"load"` — `"networkidle"`
   * is stronger but can stall on pages with long-lived connections.
   */
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  /**
   * Wait for this selector after the `goto` settles (`waitUntil`), before the
   * page content is read — THE deterministic way to wait for SPA content.
   * Uses the engine's `waitForSelector` (default state: visible), bounded by
   * the same timeout as the navigation. A per-call
   * {@link RenderCallOptions.waitForSelector} wins over this.
   */
  waitForSelector?: string;
  /**
   * Fixed settle time in milliseconds, applied after
   * {@link PlaywrightRendererOptions.waitForSelector} (or after the `goto`
   * when no selector is set) and before the content is read. The cruder
   * escape hatch — prefer `waitForSelector` when you know what to wait for.
   * A per-call {@link RenderCallOptions.waitForTimeout} wins over this.
   */
  waitForTimeout?: number;
  /**
   * Default navigation timeout in milliseconds. A per-call
   * {@link Renderer.render} `timeout` (the scraper passes its resolved
   * request timeout) wins over this.
   */
  timeoutMs?: number;
}

/**
 * A {@link Renderer} plus lifecycle: the underlying browser is a shared,
 * expensive resource — call {@link PlaywrightRenderer.close} when done
 * (process exit, test teardown, scraper retired).
 */
export interface PlaywrightRenderer extends Renderer {
  /**
   * Close the browser if one was launched. Safe to call before any
   * {@link Renderer.render} (a no-op then) and more than once.
   */
  close(): Promise<void>;
}

/**
 * Test seam, deliberately NOT declared on {@link PlaywrightRendererOptions}:
 * `__loadPlaywright` replaces the lazy `import("playwright-core")` so tests
 * can drive launch/render/close lifecycle against a stub module without a
 * real browser. Set it via a cast; it is not public API and may change
 * without notice.
 */
interface InternalPlaywrightRendererOptions extends PlaywrightRendererOptions {
  __loadPlaywright?: () => Promise<PlaywrightCore>;
}

const BROWSER_NAMES: ReadonlySet<string> = new Set(["chromium", "firefox", "webkit"]);
const WAIT_UNTIL_STATES: ReadonlySet<string> = new Set(["load", "domcontentloaded", "networkidle"]);

/**
 * A {@link Renderer} backed by Playwright — the optional engine for the
 * `render` seam. `playwright-core` is a peer dependency (`pnpm add
 * playwright-core`), imported lazily on the first render: the adapter module
 * itself loads and constructs fine without it.
 *
 * Lifecycle: the browser launches lazily on the first `render` call and is
 * reused across calls; each render gets an ephemeral `BrowserContext` +
 * `Page` (read-only isolation, no shared profile), closed when the render
 * settles. Call `close()` when done — the browser process outlives the
 * renderer otherwise.
 *
 * The engine owns its own context: the caller's `userAgent` is applied to the
 * browser context, but SDK-layer stealth headers, the cookie jar, and proxy
 * routing do NOT reach inside it. Rendering is read-only by contract —
 * navigate, wait, return HTML; browser actions live in the sibling project.
 *
 * @example
 * const renderer = playwrightRenderer({ channel: "chrome" });
 * const scraper = createScraper({ render: renderer });
 * // ...scrape...
 * await renderer.close();
 */
export function playwrightRenderer(options: PlaywrightRendererOptions = {}): PlaywrightRenderer {
  const browserName = options.browser ?? "chromium";
  if (!BROWSER_NAMES.has(browserName)) {
    throw new ConfigError(
      `\`browser\` must be "chromium", "firefox" or "webkit", got ${JSON.stringify(options.browser)}`,
    );
  }
  const waitUntil = options.waitUntil ?? "load";
  if (!WAIT_UNTIL_STATES.has(waitUntil)) {
    throw new ConfigError(
      `\`waitUntil\` must be "load", "domcontentloaded" or "networkidle", got ${JSON.stringify(options.waitUntil)}`,
    );
  }
  assertExecutablePathChannelExclusive(options.executablePath, options.channel);
  assertWaitForSelector(options.waitForSelector);
  assertWaitForTimeout(options.waitForTimeout);
  const headless = options.headless ?? true;

  const loadPlaywright = async (): Promise<PlaywrightCore> => {
    try {
      const loader =
        (options as InternalPlaywrightRendererOptions).__loadPlaywright ??
        (() => import("playwright-core"));
      return await loader();
    } catch (cause) {
      if (cause instanceof ConfigError) throw cause;
      // A failed module load is almost always the missing peer dep — name
      // the install, whatever the underlying import error was.
      throw new ConfigError(
        "`playwrightRenderer` needs `playwright-core` — install it with `pnpm add playwright-core`",
        { cause },
      );
    }
  };

  // Lazily launched on first render and reused across calls — see
  // {@link lazyBrowser} for the shared lifecycle contract.
  const { launch, close } = lazyBrowser(() =>
    loadPlaywright().then((pw) =>
      pw[browserName].launch({
        headless,
        ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
        ...(options.channel === undefined ? {} : { channel: options.channel }),
      }),
    ),
  );

  return {
    async render(url, call) {
      // Per-call settle options get the same validation as the constructor —
      // a blank selector or NaN/negative wait is a ConfigError, not a silent
      // skip or a raw engine error.
      assertWaitForSelector(call?.waitForSelector);
      assertWaitForTimeout(call?.waitForTimeout);
      if (call?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const browser = await launch();
      // A fresh context per render: read-only isolation, no shared profile —
      // the engine owns its own context, SDK cookie jars do not reach in.
      const context = await browser.newContext(
        call?.userAgent === undefined ? {} : { userAgent: call.userAgent },
      );
      const onAbort = (): void => {
        void context.close().catch(() => undefined);
      };
      call?.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const page = await context.newPage();
        const response = await page.goto(url, {
          waitUntil,
          timeout: call?.timeout ?? options.timeoutMs,
        });
        // Settle order: goto(waitUntil) → waitForSelector → waitForTimeout →
        // content(). Per-call values win over the renderer's options, same
        // rule as `timeout`.
        const waitForSelector = call?.waitForSelector ?? options.waitForSelector;
        if (waitForSelector !== undefined) {
          await page.waitForSelector(waitForSelector, {
            timeout: call?.timeout ?? options.timeoutMs,
          });
        }
        const waitForTimeout = call?.waitForTimeout ?? options.waitForTimeout;
        if (waitForTimeout !== undefined && waitForTimeout > 0) {
          await page.waitForTimeout(waitForTimeout);
        }
        const html = await page.content();
        return {
          url: page.url(),
          html,
          ...(response === null ? {} : { status: response.status() }),
        } satisfies RenderedPage;
      } catch (cause) {
        // An abort closes the context mid-navigation, which playwright
        // reports as a "target closed" error — surface the real reason.
        if (call?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        throw cause;
      } finally {
        call?.signal?.removeEventListener("abort", onAbort);
        await context.close();
      }
    },
    close,
  };
}
