import { ConfigError } from "../errors.js";
import type { RenderedPage, Renderer } from "../render.js";

/** The lazily-imported `puppeteer-core` module — a peer dep, never bundled. */
type PuppeteerCore = typeof import("puppeteer-core");
type Browser = import("puppeteer-core").Browser;
type ChromeReleaseChannel = import("puppeteer-core").ChromeReleaseChannel;

/** Options for {@link puppeteerRenderer}. */
export interface PuppeteerRendererOptions {
  /**
   * Path to a browser executable puppeteer-core does not resolve itself
   * (a system Chrome, a CI image, ...). Mutually exclusive with
   * {@link PuppeteerRendererOptions.channel}.
   */
  executablePath?: string;
  /**
   * Branded browser channel puppeteer-core resolves itself —
   * `"chrome"`, `"chrome-beta"`, `"chrome-canary"`, `"chrome-dev"`.
   * Mutually exclusive with {@link PuppeteerRendererOptions.executablePath}.
   */
  channel?: string;
  /** Launch headless. Default `true`. */
  headless?: boolean;
  /**
   * Navigation-settle condition for `page.goto`: `"load"` |
   * `"domcontentloaded"` | `"networkidle0"` | `"networkidle2"`. Default
   * `"load"` — the `networkidle*` states are stronger but can stall on pages
   * with long-lived connections.
   */
  waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
  /**
   * Default navigation timeout in milliseconds. A per-call
   * {@link Renderer.render} `timeout` (the scraper passes its resolved
   * request timeout) wins over this.
   */
  timeoutMs?: number;
}

/**
 * A {@link Renderer} plus lifecycle: the underlying browser is a shared,
 * expensive resource — call {@link PuppeteerRenderer.close} when done
 * (process exit, test teardown, scraper retired).
 */
export interface PuppeteerRenderer extends Renderer {
  /**
   * Close the browser if one was launched. Safe to call before any
   * {@link Renderer.render} (a no-op then) and more than once.
   */
  close(): Promise<void>;
}

/**
 * Test seam, deliberately NOT declared on {@link PuppeteerRendererOptions}:
 * `__loadPuppeteer` replaces the lazy `import("puppeteer-core")` so tests
 * can drive launch/render/close lifecycle against a stub module without a
 * real browser. Set it via a cast; it is not public API and may change
 * without notice.
 */
interface InternalPuppeteerRendererOptions extends PuppeteerRendererOptions {
  __loadPuppeteer?: () => Promise<PuppeteerCore>;
}

const WAIT_UNTIL_STATES: ReadonlySet<string> = new Set([
  "load",
  "domcontentloaded",
  "networkidle0",
  "networkidle2",
]);

/** puppeteer-core's closed release-channel union — no `"msedge"`. */
const CHANNELS: ReadonlySet<string> = new Set([
  "chrome",
  "chrome-beta",
  "chrome-canary",
  "chrome-dev",
]);

/**
 * A {@link Renderer} backed by Puppeteer — an optional engine for the
 * `render` seam. `puppeteer-core` is a peer dependency (`pnpm add
 * puppeteer-core`), imported lazily on the first render: the adapter module
 * itself loads and constructs fine without it.
 *
 * Lifecycle: the browser launches lazily on the first `render` call and is
 * reused across calls; each render gets an ephemeral `BrowserContext` +
 * `Page` (read-only isolation, no shared profile), closed when the render
 * settles. Call `close()` when done — the browser process outlives the
 * renderer otherwise.
 *
 * The engine owns its own context: the caller's `userAgent` is applied to the
 * page, but SDK-layer stealth headers, the cookie jar, and proxy routing do
 * NOT reach inside it. Rendering is read-only by contract — navigate, wait,
 * return HTML; browser actions live in the sibling project.
 *
 * @example
 * const renderer = puppeteerRenderer({ channel: "chrome" });
 * const scraper = createScraper({ render: renderer });
 * // ...scrape...
 * await renderer.close();
 */
export function puppeteerRenderer(options: PuppeteerRendererOptions = {}): PuppeteerRenderer {
  const waitUntil = options.waitUntil ?? "load";
  if (!WAIT_UNTIL_STATES.has(waitUntil)) {
    throw new ConfigError(
      `\`waitUntil\` must be "load", "domcontentloaded", "networkidle0" or "networkidle2", got ${JSON.stringify(options.waitUntil)}`,
    );
  }
  if (options.executablePath !== undefined && options.channel !== undefined) {
    throw new ConfigError("`executablePath` and `channel` are mutually exclusive — pick one");
  }
  if (options.channel !== undefined && !CHANNELS.has(options.channel)) {
    throw new ConfigError(
      `\`channel\` must be "chrome", "chrome-beta", "chrome-canary" or "chrome-dev", got ${JSON.stringify(options.channel)}` +
        (options.channel === "msedge"
          ? ' — "msedge" is a Playwright channel; for Edge use `executablePath` or the playwright adapter'
          : ""),
    );
  }
  const headless = options.headless ?? true;

  const loadPuppeteer = async (): Promise<PuppeteerCore> => {
    try {
      const loader =
        (options as InternalPuppeteerRendererOptions).__loadPuppeteer ??
        (() => import("puppeteer-core"));
      return await loader();
    } catch (cause) {
      if (cause instanceof ConfigError) throw cause;
      // A failed module load is almost always the missing peer dep — name
      // the install, whatever the underlying import error was.
      throw new ConfigError(
        "`puppeteerRenderer` needs `puppeteer-core` (>=24.21) — install it with `pnpm add puppeteer-core`",
        { cause },
      );
    }
  };

  // Lazily launched on first render and reused; a FAILED launch is not
  // cached, so a later render may retry (e.g. the peer dep got installed).
  let browserPromise: Promise<Browser> | undefined;
  const launch = (): Promise<Browser> => {
    browserPromise ??= loadPuppeteer()
      .then((pp) =>
        pp.launch({
          headless,
          ...(options.executablePath === undefined
            ? {}
            : { executablePath: options.executablePath }),
          // `channel` stays `string` on the public options (same contract
          // as the playwright adapter) but is validated eagerly above
          // against puppeteer-core's closed release-channel union — the
          // cast is checked, not blind.
          ...(options.channel === undefined
            ? {}
            : { channel: options.channel as ChromeReleaseChannel }),
        }),
      )
      .catch((error: unknown) => {
        browserPromise = undefined;
        throw error;
      });
    return browserPromise;
  };

  return {
    async render(url, call) {
      if (call?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const browser = await launch();
      // A fresh context per render: read-only isolation, no shared profile —
      // the engine owns its own context, SDK cookie jars do not reach in.
      const context = await browser.createBrowserContext();
      // Puppeteer's `BrowserContext.close()` is NOT idempotent — every call
      // sends `Target.disposeBrowserContext` — so the abort hook and the
      // `finally` share one guarded close. The flag flips before the await:
      // whichever caller gets here first owns the single real close, and a
      // second close's rejection can never supersede the AbortError.
      let closed = false;
      const closeContext = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        await context.close();
      };
      const onAbort = (): void => {
        void closeContext().catch(() => undefined);
      };
      call?.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const page = await context.newPage();
        if (call?.userAgent !== undefined) {
          await page.setUserAgent({ userAgent: call.userAgent });
        }
        const response = await page.goto(url, {
          waitUntil,
          timeout: call?.timeout ?? options.timeoutMs,
        });
        const html = await page.content();
        return {
          url: page.url(),
          html,
          ...(response === null ? {} : { status: response.status() }),
        } satisfies RenderedPage;
      } catch (cause) {
        // An abort closes the context mid-navigation, which puppeteer
        // reports as a "target closed" error — surface the real reason.
        if (call?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        throw cause;
      } finally {
        call?.signal?.removeEventListener("abort", onAbort);
        await closeContext();
      }
    },
    async close() {
      const pending = browserPromise;
      browserPromise = undefined;
      if (pending === undefined) return;
      // A still-in-flight launch is closed once it resolves; a rejected
      // launch has nothing to close.
      const browser = await pending.catch(() => undefined);
      await browser?.close();
    },
  };
}
