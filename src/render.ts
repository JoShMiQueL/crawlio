import { load } from "cheerio";

/**
 * When the injected {@link Renderer} is consulted.
 *
 * - `"auto"` (default) — a normal static fetch runs first; the renderer fires
 *   only when the static result looks JavaScript-dependent. A renderer failure
 *   degrades gracefully to the static result.
 * - `"always"` — the static fetch is skipped entirely and the renderer IS the
 *   fetch for that call; a renderer failure propagates as the call's error.
 */
export type RenderMode = "auto" | "always";

/** Per-call options the SDK hands to {@link Renderer.render}. */
export interface RenderCallOptions {
  /**
   * How long the engine may spend on the navigation, in milliseconds — the
   * same `timeout` budget the static fetch would have had.
   */
  timeout?: number;
  /** The caller's abort signal — honor it (abandon the navigation). */
  signal?: AbortSignal;
  /**
   * The User-Agent the equivalent static request would have sent. The engine
   * should apply it so the browser tells the same story the SDK would.
   */
  userAgent?: string;
}

/** What a {@link Renderer} returns: the final post-JavaScript page state. */
export interface RenderedPage {
  /** The final URL after any redirects — the analogue of `Response.url`. */
  url: string;
  /** The serialized DOM after JavaScript has run. */
  html: string;
  /** HTTP status of the main navigation, when the engine knows it. */
  status?: number;
}

/**
 * A pluggable browser renderer — the seam between crawlio's static HTTP
 * pipeline and JavaScript-rendered pages.
 *
 * A renderer is "an expensive fetcher": it navigates a real browser engine,
 * waits for the page to settle, and returns the final HTML. It is INJECTED,
 * never bundled — the SDK ships no browser engine. See `crawlio/render` for
 * the optional Playwright adapter, or implement this interface over your own
 * engine (Playwright, Puppeteer, a remote browser pool, ...).
 *
 * The engine owns its own context: HTTP-layer stealth headers, the cookie
 * jar, and proxies configured on the scraper do NOT apply inside the browser,
 * and browser-side cookies do not flow back into the SDK's jar — a renderer
 * that wants that state must implement it itself.
 *
 * Each `render` call is a single navigation: the SDK never retries it —
 * `retries` paces the static HTTP path only.
 *
 * Rendering is deliberately read-only: navigate, wait, return HTML. Browser
 * ACTIONS (click/fill/type/interception) are a non-goal of crawlio and live
 * in a separate sibling project.
 */
export interface Renderer {
  /**
   * Navigate `url` in a browser engine and return the final page state.
   *
   * @param url The page to render.
   * @param options Per-call budget and identity hints; see {@link RenderCallOptions}.
   * @returns The post-JavaScript page.
   */
  render(url: string, options?: RenderCallOptions): Promise<RenderedPage>;
}

/**
 * Body-text length below which a page is treated as content-empty for
 * {@link isLikelyDynamic} — whitespace-collapsed, scripts/styles excluded.
 */
const NEAR_EMPTY_BODY_CHARS = 50;

/**
 * Well-known client-side app mount points. When present AND empty the page is
 * an app shell waiting for its framework to paint — the clearest "needs JS"
 * signal there is.
 */
const APP_ROOT_SELECTORS = ["#root", "#app", "#__next", "#__nuxt", "[data-reactroot]"];

/**
 * Words that turn a `<noscript>` mentioning "javascript" into a
 * "please enable JavaScript"-style warning rather than ordinary fallback
 * content (a `<noscript><img>` beacon, say).
 */
const NOSCRIPT_WARNING_WORDS =
  /enable|disabled|required|requires|without|activate|doesn't work|does not work|not supported|turn on/i;

function looksLikeJsWarning(noscriptText: string): boolean {
  const text = noscriptText.toLowerCase();
  return text.includes("javascript") && NOSCRIPT_WARNING_WORDS.test(text);
}

/**
 * Heuristic: does this HTML look like a JavaScript-dependent shell rather
 * than a server-rendered page?
 *
 * Signals, any one of which is enough:
 *
 * - an empty well-known app mount point (`#root`, `#app`, `#__next`,
 *   `#__nuxt`, `[data-reactroot]`) — the framework has not painted;
 * - a `<noscript>` carrying an "enable JavaScript"-style warning;
 * - a body with almost no visible text (under ~50 collapsed characters)
 *   while `<script>` tags are present.
 *
 * This is a HINT, not a verdict. It exists to drive the `render` seam's
 * `auto` mode, where a false positive only costs a redundant render.
 * Framework markers say nothing by themselves — a fully populated SSR page
 * still ships `#__next` and hydration scripts, which is exactly why the
 * checks look at EMPTY containers and (near-)empty TEXT. A sparse static
 * page that happens to include a script can still read as "dynamic"; treat
 * the answer accordingly and use `renderMode: "always"` when you already
 * know the page needs an engine.
 *
 * Pure and offline: the HTML is parsed in memory, nothing is fetched.
 */
export function isLikelyDynamic(html: string): boolean {
  const $ = load(html);

  const scriptsPresent = $("script").length > 0;

  if (looksLikeJsWarning($("noscript").text())) return true;

  // Strip non-content nodes BEFORE measuring emptiness: a mount point holding
  // only a hydration <script> (or nothing at all) is still an empty shell.
  $("script, style, noscript, template").remove();

  for (const selector of APP_ROOT_SELECTORS) {
    const mount = $(selector).first();
    if (mount.length > 0 && mount.children().length === 0 && mount.text().trim() === "") {
      return true;
    }
  }

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  return scriptsPresent && bodyText.length < NEAR_EMPTY_BODY_CHARS;
}
