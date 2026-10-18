/**
 * Real-browser e2e for the render seam: playwright-core driving a real
 * chromium against a loopback node:http server. Gated on CRAWLIO_E2E=1 —
 * the `e2e-browsers` CI job installs chromium and sets it; everywhere else
 * the suite self-skips so `bun test`/`vitest` stay engine-free.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScraper, type Renderer, scrape } from "../src/index.js";
import { type PlaywrightRenderer, playwrightRenderer } from "../src/render/playwright.js";

const E2E = process.env.CRAWLIO_E2E === "1";
const e2e = E2E ? it : it.skip;
/** A real browser launch is slow, worst on a cold CI image. */
const E2E_TIMEOUT = 60_000;

/** A JS shell: an empty #app mount plus a script that injects the content. */
const SHELL_HTML = `<!doctype html><html><body>
<div id="app"></div>
<script>
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("app").innerHTML =
    '<h1>Rendered title</h1><span class="price">42.5</span><a href="/about">about</a>';
});
</script>
</body></html>`;

/** A populated static page — no shell marker, real body text. */
const STATIC_HTML = `<!doctype html><html><body>
<h1>Static title</h1>
<p>Plain server-rendered content with well over fifty characters of real
text, so neither the empty-mount nor the near-empty-body signal fires.</p>
</body></html>`;

const ROUTES: Record<string, string> = {
  "/shell": SHELL_HTML,
  "/static": STATIC_HTML,
  "/robots.txt": "User-agent: *\nAllow: /\n",
};

function startServer(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const body = ROUTES[new URL(req.url ?? "/", "http://localhost").pathname];
    if (body === undefined) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

describe("e2e — real chromium render seam", () => {
  let server: Server | undefined;
  let base = "";
  let renderer: PlaywrightRenderer | undefined;

  /** Narrowed handles for a live test — beforeAll filled them under E2E. */
  function live(): { renderer: PlaywrightRenderer; base: string } {
    if (renderer === undefined) throw new Error("e2e renderer not initialized");
    return { renderer, base };
  }

  beforeAll(async () => {
    if (!E2E) return;
    ({ server, base } = await startServer());
    renderer = playwrightRenderer(); // lazy — chromium launches on first render
  });

  afterAll(async () => {
    await renderer?.close(); // browser first — releases its keep-alive sockets
    const http = server;
    if (http !== undefined) {
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });

  e2e(
    "render() returns the post-JS DOM of a shell page",
    async () => {
      const { renderer: engine, base: origin } = live();
      const page = await engine.render(`${origin}/shell`);
      expect(page.status).toBe(200);
      expect(page.url).toBe(`${origin}/shell`);
      expect(page.html).toContain("<h1>Rendered title</h1>");
      expect(page.html).toContain('<span class="price">42.5</span>');
    },
    E2E_TIMEOUT,
  );

  e2e(
    "scrape(renderMode 'always') extracts the JS-injected fields, typed",
    async () => {
      const { renderer: engine, base: origin } = live();
      const data = await scrape(
        `${origin}/shell`,
        {
          title: "#app h1",
          price: { selector: ".price", transform: Number.parseFloat },
          about: { selector: "#app a", attr: "href" },
        },
        { render: engine, renderMode: "always" },
      );
      expect(data.title).toBe("Rendered title");
      expect(data.price).toBe(42.5); // transform ran — a number, not a string
      expect(data.about).toBe(`${origin}/about`); // resolved against the final URL
    },
    E2E_TIMEOUT,
  );

  e2e(
    "renderMode 'auto' renders the shell but leaves the static page alone",
    async () => {
      const { renderer: engine, base: origin } = live();
      let calls = 0;
      const counted: Renderer = {
        render: (url, options) => {
          calls += 1;
          return engine.render(url, options);
        },
      };
      const scraper = createScraper({ render: counted });

      const shell = await scraper.fetchHtml(`${origin}/shell`);
      expect(shell.rendered).toBe(true);
      expect(shell.html).toContain("Rendered title");
      expect(calls).toBe(1);

      const staticPage = await scraper.fetchHtml(`${origin}/static`);
      expect(staticPage.rendered).toBeUndefined();
      expect(staticPage.html).toContain("Static title");
      expect(calls).toBe(1); // no escalation on a populated page
    },
    E2E_TIMEOUT,
  );

  e2e(
    "close() tears the browser down and is idempotent",
    async () => {
      const { base: origin } = live();
      // A dedicated renderer — closing the shared one mid-suite would
      // strand the tests that still need it.
      const own = playwrightRenderer();
      const page = await own.render(`${origin}/shell`);
      expect(page.html).toContain("Rendered title");
      await own.close();
      await own.close(); // a second close is a documented no-op
      // A leaked browser would keep this process alive — the suite (and CI
      // job) exiting at all is the assertion that nothing hangs.
    },
    E2E_TIMEOUT,
  );
});
