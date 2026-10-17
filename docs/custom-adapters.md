# Writing custom adapters

The deep-dive companion to the README's [Custom providers and
renderers](../README.md#custom-providers-and-renderers) quick reference. It
documents the exact contracts `Renderer` and `SearchProvider` plug into, the
semantics the SDK relies on, the conventions the built-in adapters set, and
how to package an adapter for the CLI.

Every external capability in crawlio is an object seam — injected, never
bundled. An adapter is a plain object: no registration, no base class.

## The `Renderer` contract

```ts
interface RenderCallOptions {
  /** Navigation budget in ms — the same timeout the static fetch would have had. */
  timeout?: number;
  /** The caller's abort signal — honor it (abandon the navigation). */
  signal?: AbortSignal;
  /** The User-Agent the equivalent static request would have sent. */
  userAgent?: string;
  /** Wait for this selector after the navigation settles. Per-call wins over config. */
  waitForSelector?: string;
  /** Fixed settle in ms, applied after waitForSelector. Per-call wins over config. */
  waitForTimeout?: number;
}

interface RenderedPage {
  /** The final URL after any redirects — the analogue of `Response.url`. */
  url: string;
  /** The serialized DOM after JavaScript has run. */
  html: string;
  /** HTTP status of the main navigation, when the engine knows it. */
  status?: number;
}

interface Renderer {
  render(url: string, options?: RenderCallOptions): Promise<RenderedPage>;
}
```

Plus, by convention, an optional `close(): Promise<void>`. It is not part of
the `Renderer` interface — the built-in adapters declare it on their extended
interfaces (`PlaywrightRenderer`, `PuppeteerRenderer`), and the CLI calls it
on shutdown for module-loaded renderers. The SDK itself never calls it: a
programmatic caller owns the lifecycle (`const scraper = createScraper({
render }); … await renderer.close()`).

A renderer is "an expensive fetcher": navigate a real engine, wait for the
page to settle, return the final HTML. Rendering is read-only — browser
actions (click/fill/type) are a declared non-goal.

### Semantics the SDK relies on

- **robots.txt gates first.** `render` fires only after the URL passed the
  robots check, and a declared crawl-delay still paces it — politeness does
  not end at the transport. Your adapter never sees a URL the SDK decided not
  to fetch.
- **`renderMode: "auto"` (default) degrades gracefully.** The static fetch
  runs first; the renderer fires only when `isLikelyDynamic(html)` flags a JS
  shell (or, on `scrape*`/`crawl` calls, when the fields spec extracted to
  all-`undefined`). If `render` then throws, the SDK returns the static
  result — a render failure never makes a page worse. The exception is a
  caller abort: it propagates, it is never swallowed.
- **`renderMode: "always"` propagates.** The static fetch is skipped
  entirely — the renderer IS the fetch, and its failure is the call's error.
- **One navigation, never retried.** `retries` paces the static HTTP path
  only; a `render` call is a single attempt.
- **Honor `signal`.** Abandon the navigation on abort and throw
  `new DOMException("Aborted", "AbortError")` — the SDK maps that to
  `FetchError("Request aborted by caller")`. If your engine reports the abort
  as a generic error (a "target closed" when the context dies mid-
  navigation), check `signal.aborted` in your catch and re-throw the
  AbortError so the real reason surfaces.
- **Honor `timeout`.** It is the per-call navigation budget in milliseconds;
  a per-call value wins over whatever default the adapter is configured with.
- **Apply `userAgent` to the browser context** so the engine tells the same
  story the SDK's static request would have.
- **Return the final post-navigation URL.** Redirects included — the SDK
  treats `page.url` like `Response.url` (an empty `url` falls back to the
  requested one and is credential-scrubbed).
- **Return `status` when the engine knows it.** A renderer-reported status
  feeds the SDK's `throwOnHttpError` handling exactly like a static response:
  outside 200–299 it surfaces as `HttpError`. Omit it when unknowable — it
  defaults to 200.
- **`html` is the full serialized DOM** after JavaScript ran — the page state
  the normal parse/extract pipeline sees downstream.
- **`waitForSelector`/`waitForTimeout` are per-call overrides.** The scraper
  never sets them — settle behaviour is renderer configuration. They exist so
  a caller driving `renderer.render()` directly gets the same knobs, and a
  per-call value wins over the adapter's configured default. Validate them
  like constructor options: a blank selector or a NaN/negative wait is a
  `ConfigError`, not a silent skip.
- **The engine owns its own context.** SDK-layer stealth headers, the cookie
  jar, and proxy routing do NOT reach inside the browser, and browser-side
  cookies do not flow back into the SDK's jar — an adapter that wants that
  state implements it itself.

### Lifecycle conventions (from the built-ins)

The built-in Playwright/Puppeteer adapters share a lifecycle worth copying —
`src/render/lifecycle.ts` (`lazyBrowser`) implements it in ~20 lines:

- **Lazy launch on first `render`.** Constructing the adapter must not launch
  a browser — and the built-ins go further, lazy-`import()`ing the engine
  inside the launch so the adapter module loads fine without the peer dep.
- **One browser, reused across renders.** The launch is cached as a *promise*
  so concurrent first renders share a single launch.
- **Ephemeral context per render.** Each render gets a fresh
  context/page closed in `finally` — read-only isolation, no shared profile.
- **`close()` is idempotent and drains an in-flight launch.** Safe before any
  render and more than once; a launch still in progress is awaited and then
  closed.
- **A failed launch is not cached.** The next `render` retries — e.g. after
  the peer dep got installed.

### Errors

- **Construction-time `ConfigError` for config mistakes.** Bad option values,
  mutually exclusive options, a missing peer dep, an unparseable endpoint —
  name the option in the message. Never a raw `Error`, never a deferred
  mid-call failure.
- **Engine failures just propagate out of `render`.** What the SDK does with
  them: a `ScrapeError` passes through untouched; an `AbortError`
  `DOMException` becomes `FetchError("Request aborted by caller")`; anything
  else is wrapped in `ConfigError("Renderer failed", { cause })`. Then the
  mode decides — `"always"` propagates that as the call's error, `"auto"`
  swallows it and returns the static result (an abort still propagates).
  Throwing `crawlio`'s own error classes (`ConfigError`, `HttpError`, ...)
  keeps the precise `code` through that wrap.

### Worked example

A complete adapter over a hypothetical `webengine` package — lifecycle, abort
handling, and all:

```ts
import { ConfigError } from "crawlio";
import type { RenderedPage, Renderer } from "crawlio";

export interface WebEngineRenderer extends Renderer {
  close(): Promise<void>;
}

export function webEngineRenderer(options: { headless?: boolean } = {}): WebEngineRenderer {
  let browserPromise: Promise<import("webengine").Browser> | undefined;

  // Lazy launch: import the peer dep AND start the browser on first render.
  const launch = () => {
    browserPromise ??= import("webengine")
      .then((we) => we.launch({ headless: options.headless ?? true }))
      .catch((cause) => {
        browserPromise = undefined; // a failed launch is not cached — retry next call
        throw new ConfigError("`webEngineRenderer` needs `webengine` — `pnpm add webengine`", { cause });
      });
    return browserPromise;
  };

  return {
    async render(url, call): Promise<RenderedPage> {
      if (call?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const browser = await launch();
      const context = await browser.newContext(
        call?.userAgent === undefined ? {} : { userAgent: call.userAgent },
      );
      const onAbort = () => void context.close().catch(() => undefined);
      call?.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const page = await context.newPage();
        const response = await page.goto(url, { timeout: call?.timeout });
        if (call?.waitForSelector) await page.waitForSelector(call.waitForSelector);
        if (call?.waitForTimeout) await page.waitForTimeout(call.waitForTimeout);
        return {
          url: page.url(),                       // post-redirect URL
          html: await page.content(),            // serialized DOM, post-JS
          ...(response === null ? {} : { status: response.status() }),
        };
      } catch (cause) {
        // Engines report an abort as a generic context-closed error — surface
        // the real reason so the SDK maps it to FetchError.
        if (call?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        throw cause;
      } finally {
        call?.signal?.removeEventListener("abort", onAbort);
        await context.close(); // ephemeral context per render
      }
    },
    async close() {
      const pending = browserPromise;
      browserPromise = undefined;
      const browser = await pending?.catch(() => undefined); // drains an in-flight launch
      await browser?.close();
    },
  };
}
```

#### Using it

`webEngineRenderer` is a factory — call it and hand the object to
`createScraper`:

```ts
import { createScraper } from "crawlio";

const renderer = webEngineRenderer();
const scraper = createScraper({ render: renderer });
const page = await scraper.scrape("https://spa.example.com", { title: "h1" });
await renderer.close(); // the browser is yours to close
```

`renderMode: "auto"` (the default) fires the engine only when the static
fetch looks dynamic; `"always"` makes the renderer the fetch itself.

Or from the CLI — the module form needs the renderer **object** export
(see [Packaging for the CLI](#packaging-for-the-cli) below):

```sh
crawlio scrape https://spa.example --render always --renderer ./my-renderer.mjs
```

## The `SearchProvider` contract

```ts
interface SearchCallOptions {
  /** Cap on results — pass it to the provider; the SDK also enforces it client-side. */
  limit?: number;
  /** Per-request timeout in ms — the same budget a page fetch gets. */
  timeout?: number;
  /** Retries after the first attempt (total attempts = retries + 1). */
  retries?: number;
  /** The caller's abort signal — honor it. */
  signal?: AbortSignal;
}

interface SearchResult {
  /** The hit's URL — the only required field. */
  url: string;
  /** The page title the provider reported, when it sent one. */
  title?: string;
  /** A short text snippet describing the hit, when the provider sent one. */
  description?: string;
}

interface SearchProvider {
  search(query: string, options?: SearchCallOptions): Promise<SearchResult[]>;
}
```

### Semantics the SDK relies on

- `query` arrives trimmed and non-empty — the SDK validates before you are
  ever called (`limit: 0` returns `[]` without calling you at all).
- **The return value is untrusted input.** A non-array rejects as
  `ConfigError("Search provider returned a non-array result")`; entries
  without a non-empty string `url` are dropped; `title`/`description` pass
  through only when they are strings; `limit` is enforced client-side on top
  of whatever you return — your `count` is a hint, not a contract.
- **Same error taxonomy as `render`:** a `ScrapeError` passes through; a
  caller abort or an `AbortError` `DOMException` becomes
  `FetchError("Request aborted by caller")`; anything else is wrapped in
  `ConfigError("Search provider failed", { cause })`.

### Conventions (from the built-ins)

`brave`/`serper`/`tavily` share one plumbing layer (`src/search/shared.ts`);
following it keeps your adapter predictable:

- **API key via `apiKey` option or an env var — explicit wins.** A missing
  key is a `ConfigError` at construction naming both the option and the env
  var (`BRAVE_API_KEY`-style), not a mid-call failure.
- **The key travels in a request header ONLY** — never the URL (it would leak
  through error `url`s and request-line logs) and never the body (payload
  dumps). A 401/403 surfaces as an `HttpError` saying the key was rejected —
  the message names neither the key nor the header value.
- **`baseUrl` is overridable** (tests, proxies) and validated at construction
  — a malformed value is a `ConfigError`, not a first-query failure.
- **`fetch` is injectable** (`options.fetch`, default `globalThis.fetch`) so
  tests run offline.
- **Retries go through the shared `withRetries` policy** — a 429/5xx retries
  with backoff+jitter; a caller abort is never retried. No ad-hoc
  `setTimeout` retries.
- **A missing result list is `[]`, not an error** — providers omit the list
  key when there are no hits.
- **Clamp `limit` to the provider's bounds** before sending — Brave clamps to
  1–20 rather than let the API reject the request.
- **robots.txt does not apply** — a provider API is an authenticated
  endpoint, not a crawled site.
- Malformed JSON from the API is a `ParseError`.

### Worked example

```ts
import { ConfigError, HttpError, ParseError } from "crawlio";
import type { SearchProvider, SearchResult } from "crawlio";

export function acmeSearchProvider(options: {
  apiKey?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
} = {}): SearchProvider {
  const apiKey = (options.apiKey ?? process.env.ACME_API_KEY)?.trim();
  if (apiKey === undefined || apiKey === "") {
    throw new ConfigError("`acmeSearchProvider` needs an API key — pass `apiKey` or set ACME_API_KEY");
  }
  const endpoint = options.baseUrl ?? "https://api.acme.example/search";
  try {
    new URL(endpoint);
  } catch (cause) {
    throw new ConfigError("`baseUrl` must be a valid URL", { cause });
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return {
    async search(query, call = {}) {
      const url = new URL(endpoint);
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(Math.min(Math.max(1, call.limit ?? 10), 50)));
      const res = await fetchImpl(url, {
        headers: { accept: "application/json", "x-api-key": apiKey }, // header — never URL/body
        signal: call.signal,
      });
      if (res.status === 401 || res.status === 403) {
        throw new HttpError(`Acme API rejected the API key (HTTP ${res.status})`, {
          url: endpoint,
          status: res.status,
        });
      }
      if (!res.ok) {
        throw new HttpError(`Acme API HTTP ${res.status}`, { url: endpoint, status: res.status });
      }
      let payload: unknown;
      try {
        payload = await res.json();
      } catch (cause) {
        throw new ParseError("Acme API returned invalid JSON", { cause });
      }
      const list = (payload as { results?: unknown } | null)?.results;
      if (!Array.isArray(list)) return []; // missing list = empty, not error
      const hits: SearchResult[] = [];
      for (const entry of list) {
        const r = entry as Record<string, unknown>;
        if (typeof r.url !== "string" || r.url === "") continue;
        hits.push({
          url: r.url,
          ...(typeof r.title === "string" ? { title: r.title } : {}),
          ...(typeof r.snippet === "string" ? { description: r.snippet } : {}),
        });
      }
      return hits;
    },
  };
}
```

#### Using it

`acmeSearchProvider` is a factory — call it and hand the object to
`search`:

```ts
import { search } from "crawlio";

const provider = acmeSearchProvider(); // or { apiKey: "..." } — else ACME_API_KEY
const results = await search("typed scraping sdk", { provider, limit: 10 });
```

Or from the CLI — the module form needs the provider **object** export
(see [Packaging for the CLI](#packaging-for-the-cli) below):

```sh
crawlio search "typed scraping sdk" --provider ./my-provider.mjs
```

## Packaging for the CLI

`--provider <specifier>` and `--renderer <specifier>` load your adapter as a
module. The contract (`src/cli-args.ts`):

- **Specifier forms:** a relative path (`./my-adapter.mjs`, `../adapter.js` —
  `.\`/`..\` on Windows) resolved against the cwd, an absolute path, a
  `file:` URL, or a bare package name. A bare name resolves against the cwd's
  `node_modules` first — the user's own project install wins, which matters
  for `npx`/global crawlio — falling back to crawlio's own module context.
- **Export shape:** `export default` wins; otherwise the conventional named
  export — `searchProvider` or `provider` for search, `renderer` for render.
  The export must be an object with a `search(query, options)` /
  `render(url, options)` method; anything else is a `ConfigError` naming the
  expected shape. A load failure is likewise a `ConfigError` naming the flag
  and specifier.
- **Optional `close()`** on a renderer runs on CLI shutdown.
- **`--api-key` is rejected with a module specifier** — checked BEFORE the
  module is imported, so a bad flag combo never executes adapter code. A
  provider module carries its own config: env vars, a config file, whatever
  it needs.
- **`--renderer` is mutually exclusive** with `--engine`/`--browser`/
  `--channel`/`--executable-path`/`--wait-for`/`--wait-ms` — the module
  replaces engine resolution entirely; the built-in adapters' flags cannot
  reach it.

```sh
crawlio search "typed scraping sdk" --provider ./my-provider.mjs
crawlio scrape https://spa.example --render always --renderer ./my-renderer.mjs
crawlio search "q" --provider crawlio-provider-searxng   # bare package name
```

### Publishing a community adapter

- **Name it `crawlio-*`** — `crawlio-provider-searxng`,
  `crawlio-renderer-brightdata`, ... — so `crawlio search --provider
  crawlio-provider-searxng` reads as the adapter it is.
- **The importable entry exports the adapter object itself** — a default
  export or the conventional named export. A factory is fine for programmatic
  use, but the CLI needs an object it can call without arguments; a common
  pattern is `"exports": { ".": "...", "./adapter": "./dist/adapter.js" }`
  with `./adapter` default-exporting a preconfigured instance (env-var
  config), or making the package root itself the object module.
- **Importing from `crawlio`?** Types are compile-time-only (`import type`)
  and need nothing at runtime; importing `ConfigError`/`HttpError`/`ParseError`
  makes `crawlio` a real dependency — declare it a `peerDependency` so the
  adapter shares the user's install (and its error classes stay
  `instanceof`-identical).
- **A good adapter README states:** peer deps and how to install the engine
  (`pnpm add playwright-core`, `playwright install chromium`, ...), every env
  var it reads (`*_API_KEY`, endpoints), engine/binary requirements (a
  browser channel, an executable path, a remote endpoint URL), the options it
  accepts, and the crawlio version range it targets — pre-1.0, that range
  matters.

## Testing

Test offline — inject `fetch` or stub the engine, the same seams the
in-repo tests use:

- **Providers:** accept an injectable `fetch` and drive canned `Response`s
  through it (`test/search.test.ts`'s `recordingFetch` pattern). No network,
  deterministic status codes and bodies.
- **Renderers:** stub the engine module rather than launching a browser —
  the built-ins expose a `__loadPlaywright`/`__loadPuppeteer` seam for exactly
  that, and `test/render.test.ts`'s `fakeRenderer` (canned HTML + recorded
  calls) exercises the SDK side.
- **Drive the adapter through the SDK**, not just standalone —
  `search("q", { provider })` and `createScraper({ render })` exercise the
  untrusted-output validation and the auto/always error semantics a
  unit-level call cannot.
- **Cases worth pinning:** missing key → `ConfigError` at construction;
  malformed `baseUrl` → `ConfigError`; 401/403 → `HttpError` naming no
  secrets; bad JSON → `ParseError`; missing list → `[]`; abort → `FetchError`
  via `AbortError`; non-`url` entries dropped; `close()` twice, before any
  render, and while a launch is in flight.

## A note on `docs/` and the tarball

`docs/` does not ship in the npm package: `package.json` sets `files:
["dist"]`, so the tarball is `dist/` plus npm's always-included files
(package.json, README.md, LICENSE). Links to `docs/` from the README work on
GitHub, not from the installed package — fine for a guide like this.
