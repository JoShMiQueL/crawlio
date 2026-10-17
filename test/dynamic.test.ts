import { describe, expect, it } from "vitest";
import { isLikelyDynamic } from "../src/index.js";

/**
 * `isLikelyDynamic` is a pure heuristic — these cases pin the signals it keys
 * on and the false-positive shapes it must NOT fire on. It is a hint for the
 * `render` seam's `auto` mode, not a verdict: SSR pages carry framework
 * markers while being fully populated, and must answer `false`.
 */
describe("isLikelyDynamic", () => {
  it("flags a React app shell", () => {
    const html = `<!doctype html><html><head><script src="/static/js/main.js"></script></head>
      <body><div id="root"></div><script src="/runtime.js"></script></body></html>`;
    expect(isLikelyDynamic(html)).toBe(true);
  });

  it("flags an empty #app mount point even without scripts", () => {
    const html = `<html><body><div id="app"></div></body></html>`;
    expect(isLikelyDynamic(html)).toBe(true);
  });

  it("flags a mount point holding only whitespace or a hydration script", () => {
    expect(isLikelyDynamic(`<html><body><div id="__next">   </div></body></html>`)).toBe(true);
    expect(
      isLikelyDynamic(
        `<html><body><div id="root"><script>window.__DATA__={}</script></div></body></html>`,
      ),
    ).toBe(true);
  });

  it("does NOT flag a fully populated SSR page carrying framework markers", () => {
    const html = `<!doctype html><html><head><script src="/_next/static/chunks/main.js"></script></head>
      <body><div id="__next"><article><h1>Server-rendered article</h1>
      <p>This paragraph is real, server-rendered content — the #__next marker
      and hydration scripts are present but the page is fully populated.</p>
      </article></div>
      <script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>
      </body></html>`;
    expect(isLikelyDynamic(html)).toBe(false);
  });

  it("does NOT flag an ordinary populated static page", () => {
    const html = `<html><body><h1>About us</h1><p>Plain static content, well over
      fifty characters of real text.</p></body></html>`;
    expect(isLikelyDynamic(html)).toBe(false);
  });

  it("flags a page whose only content is a noscript enable-JavaScript warning", () => {
    const html = `<html><body><noscript>You need to enable JavaScript to run this app.</noscript>
      <div id="root"></div><script src="/app.js"></script></body></html>`;
    expect(isLikelyDynamic(html)).toBe(true);
  });

  it("flags a noscript warning even inside an otherwise populated page", () => {
    // Some SPA shells render a warning plus a minimal layout — the warning
    // alone is the signal.
    const html = `<html><body><header>Site chrome that is longer than fifty characters of text</header>
      <noscript>We're sorry but this app doesn't work properly without JavaScript enabled.</noscript>
      <script src="/js/chunk-vendors.js"></script></body></html>`;
    expect(isLikelyDynamic(html)).toBe(true);
  });

  it("does NOT flag a noscript with ordinary fallback content", () => {
    const html = `<html><body><h1>Static page with a noscript image fallback for a tracking pixel</h1>
      <noscript><img src="/px.gif" alt=""></noscript>
      <p>Plenty of real text here, well past the threshold.</p>
      <script>console.log("a small progressive-enhancement script")</script>
      </body></html>`;
    expect(isLikelyDynamic(html)).toBe(false);
  });

  it("flags a near-empty body that still ships scripts", () => {
    const html = `<html><head><script src="/bundle.js"></script></head>
      <body><div></div></body></html>`;
    expect(isLikelyDynamic(html)).toBe(true);
  });

  it("does NOT flag a sparse page that ships no scripts", () => {
    const html = `<html><body><p>short</p></body></html>`;
    expect(isLikelyDynamic(html)).toBe(false);
  });
});
