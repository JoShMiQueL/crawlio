# crawlio

[![ci](https://github.com/JoShMiQueL/crawlio/actions/workflows/ci.yml/badge.svg)](https://github.com/JoShMiQueL/crawlio/actions/workflows/ci.yml)

[Why crawlio](#why-crawlio) · [Install](#install) · [Node and Bun](#node-and-bun) · [Usage](#usage) · [CLI](#cli) · [MCP server](#mcp-server) · [Stealth](#stealth-opt-in) · [Proxies](#proxies) · [Rendering](#rendering-javascript-pages-render) · [Custom providers](#custom-providers-and-renderers) · [Contributing](CONTRIBUTING.md)

A typed, self-hosted web-data extraction library: scrape, map, crawl, and
search over HTTP with typed field specs, plus a pluggable renderer for
JS-heavy pages. A library you run in your own process — not a hosted API.
Pre-1.0 — the API may still change.

| Capability | Status |
| --- | --- |
| scrape — fetch + typed extraction over HTTP | done |
| Politeness controls — robots.txt, per-origin serialization, delays, concurrency cap | done |
| Stealth (opt-in) — browser header profiles, cookie jar, referer chain, jitter | done |
| CAPTCHA solver seam — user-provided `solve` interface | done |
| `map` — discover all URLs on a site | done |
| `crawl` — recursive same-site traversal | done |
| Proxies — pool routing with rotation and ban-aware health checks | done |
| `render` seam + `isLikelyDynamic` — headless engine injection for JS pages | done |
| CLI — `crawlio scrape`/`map`/`crawl`/`search`/`install` | done |
| `search` — via external search providers | done |
| MCP server (`crawlio-mcp`) — expose the toolkit to agents | done |

Non-goals:

- **No browser actions, ever.** No click/fill/type/navigation flows — the
  renderer is read-only. Browser automation lives in a separate sibling
  project.
- **No own search index** — `search` delegates to external providers.
- **No managed-challenge guarantees at the HTTP layer** — the solver seam
  exists, but solving is your solver's job and success is never promised.
- **Nothing hosted** — no API keys, no cloud component, no account.

## Why crawlio

| Differentiator | What it means |
| --- | --- |
| **Self-hosted, not SaaS** | Unlike hosted scraping APIs (Firecrawl, Decodo, …): no API keys owed to us, no per-request billing, nothing leaves your infrastructure. You own the rate limits and the data. |
| **Typed extraction** | Field specs infer the result type — `page.title` is `string \| undefined` because the spec says so, not because you annotated it. |
| **Dual-runtime** | Same API on Node >= 26.12 and Bun >= 1.4.3; Bun gets native upgrades — see [Node and Bun](#node-and-bun). |
| **Polite by default** | robots.txt on, per-origin serialization, an identifiable `crawlio/<version>` User-Agent, exponential backoff with jitter. `robots: false` and `stealth: true` are explicit opt-outs. |
| **Proxies first-class** | Per-origin rotation, ban-aware health tracking, pooled-client cleanup. |
| **Read-only rendering** | JS rendering via Playwright/Puppeteer adapters you inject — never bundled. Scraper-only by design: no clicking, no form fills, no automation. |
| **MCP built-in** | `crawlio-mcp` exposes the same toolkit to agents over stdio or HTTP. |
| **Compiled binaries** | `bun build --compile` produces standalone `crawlio`/`crawlio-mcp` executables with no runtime to install. |
| **2 runtime deps** | cheerio + undici — and undici loads only on the Node lane. Everything else is internal or an optional peer. |

### Why not just Playwright?

Playwright drives a browser — a different tool for a different layer. Most
scraping targets are static HTML, where a browser is ~150 MB of binary and
hundreds of MB of RAM per instance to deliver what a single HTTP request
already returns. And the browser is only step one: robots.txt handling,
retries with backoff, per-origin politeness, proxy rotation, typed field
extraction, sitemap traversal, and agent-facing MCP tools are all yours to
build on top of it.

crawlio is the scraping product around the transport: `renderMode: "auto"`
tries plain HTTP first and escalates to a real browser only when the page
needs one — and the injected engine *is* `playwright-core`. crawlio doesn't
compete with Playwright; it uses it as an optional backend for the pages
that actually require it.

## Install

```sh
bun add crawlio
# or
npm i crawlio
```

Requires Node.js >= 26.12 or Bun >= 1.4.3 — see [Node and
Bun](#node-and-bun) for what each runtime gets.

## Node and Bun

Same code, same API, same results on both. Node >= 26.12 is the baseline;
Bun >= 1.4.3 is the preferred runtime and gets native upgrades where Bun
exposes better primitives:

- **Native `fetch`** — Bun's HTTP client is HTTP/2-capable; Node's global
  fetch (undici) is HTTP/1.1.
- **`Bun.FetchSession`** — per-proxy connection pools, each holding its own
  TLS and keep-alive sockets. The Node lane uses undici `ProxyAgent`
  dispatchers instead — `require()`d lazily, so undici is never loaded
  under Bun.
- **`Bun.serve`** — backs `crawlio-mcp --transport http`; the Node lane
  uses `node:http`.
- **`bun build --compile`** — `bun run build:bin` produces the standalone
  binaries. The repo toolchain is Bun end-to-end.

On TLS, honestly: Bun's TLS stack is BoringSSL — the Chromium-family stack —
so its TLS fingerprint is closer to browser-class fingerprints than Node's
OpenSSL one. That is a mild advantage on fingerprint-sensitive targets, not
a guarantee — managed challenges belong to the renderer and solver seams.

Identical on both runtimes: the API, extraction results, error classes,
and the robots/retry/politeness policy. What can differ at the wire level:

- TLS fingerprint — BoringSSL vs OpenSSL, above.
- HTTP/2 negotiation — Bun negotiates h2; undici is h1.1.
- Low-level error strings — each transport words failures its own way.
- Ambient proxy env vars — Bun's `fetch` honors `HTTP_PROXY`/`HTTPS_PROXY`,
  undici ignores them. crawlio pins `proxy: false` on Bun so env vars never
  silently route on either runtime; `proxies` is the only opt-in channel.

Need the wire layer identical too? `createScraper({ fetch })` accepts any
fetch implementation — injecting undici's fetch normalizes the HTTP layer
across runtimes (an injected `fetch` can't combine with `proxies` — see
[Proxies](#proxies)):

```ts
import { fetch } from "undici";
import { createScraper } from "crawlio";

const scraper = createScraper({ fetch });
```

## Usage

```ts
import { scrape } from "crawlio";

const page = await scrape("https://example.com", {
  title: "h1",
  author: { selector: "meta[name=author]", attr: "content" },
  links: { selector: "article a", attr: "href", all: true },
});
// page.title: string | undefined — inferred from the field spec
```

### `map` — discover a site's URLs

```ts
import { map } from "crawlio";

const { urls, source } = await map("https://example.com", { limit: 500 });
// urls: { url, lastModified? }[] — source: "sitemap" | "links"
```

`Sitemap:` directives in robots.txt and `/sitemap.xml` are tried first
(sitemap indexes recurse into their children, bounded at 50 documents); when
no sitemap yields URLs, the seed page's same-origin links are used instead.
`source` tells you which strategy answered.

### `crawl` — same-origin traversal

```ts
import { crawl } from "crawlio";

const result = await crawl("https://example.com/docs", {
  maxDepth: 3,                        // default 2
  maxPages: 50,                       // default 50 — a hard politeness cap
  include: [/^https:\/\/example\.com\/docs\//],
  exclude: [/\.(jpg|pdf)$/],
  fields: { title: "h1" },            // optional per-page extraction
});
// result.pages: { url, depth, data?, error? }[] in BFS order
```

Only links on the seed's origin are followed. A failing page is recorded with
`error` set and never aborts the crawl; an `AbortSignal` stops dequeuing and
returns what was collected. Every fetch goes through the normal pipeline —
robots.txt, per-origin serialization, delays, retries, and stealth all apply.

### `search` — web search via providers

```ts
import { scrapeMany, search } from "crawlio";

const results = await search("typed web scraping sdk", {
  provider: "brave", // reads BRAVE_API_KEY — or pass `apiKey`
  limit: 10,
});
// results: { url, title?, description? }[]

// Pipe the hits straight into extraction:
const pages = await scrapeMany(
  results.map((r) => r.url),
  { title: "h1" },
);
```

`provider` accepts a built-in name or an adapter object — the configurable
form, mirroring the engine adapters:

```ts
import { serperSearchProvider, search } from "crawlio";

const results = await search("typed web scraping sdk", {
  provider: serperSearchProvider({ apiKey: "..." }), // or SERPER_API_KEY env
  limit: 10,
});
```

| `provider` name | Adapter | Env var |
| --- | --- | --- |
| `"brave"` | `braveSearchProvider` (Brave Search API) | `BRAVE_API_KEY` |
| `"serper"` | `serperSearchProvider` (Serper.dev Google Search) | `SERPER_API_KEY` |
| `"tavily"` | `tavilySearchProvider` (Tavily Search) | `TAVILY_API_KEY` |

Every adapter takes `{ apiKey?, baseUrl?, fetch? }`: the key comes from
`apiKey` or the env var (explicit wins — `search`'s `apiKey` option overrides
the env var only when `provider` is a name; it is ignored for an object
provider) and travels in a request header only — never in the URL, never in
the body, never in error messages. Requests run through the same
retry/backoff policy as page fetches, with the honest `crawlio/<version>`
User-Agent. `query` is trimmed and must be non-empty; `limit` is forwarded to
the provider AND enforced client-side on the returned list.

`search` is a provider SEAM, not a search engine — crawlio ships no index (a
declared non-goal). A custom provider just implements the `SearchProvider`
interface directly — a self-hosted SearXNG, another API, a test stub:

```ts
interface SearchProvider {
  search(query: string, options?: { limit?: number; timeout?: number; signal?: AbortSignal }):
    Promise<{ url: string; title?: string; description?: string }[]>;
}
```

Prefer the terminal? The same toolkit ships as a `crawlio` binary —
`crawlio --help` lists the commands (see [CLI](#cli)).

## Features

- **Typed field extraction** — declare fields as CSS selectors (or `{ selector,
  attr, all, transform }` objects) and get a fully inferred result type.
- **Retry with backoff** — all network I/O goes through one shared retry policy
  with exponential backoff and jitter.
- **robots.txt support** — on by default (`robots: false` opts out); honors
  disallow rules and crawl-delay.
- **Identifiable User-Agent** — a configurable, honest UA by default.
- **Concurrency control** — per-origin serialization (opt-out) plus a global
  concurrency cap; batch helpers (`scrapeMany`, `scrapeManySafe`) included.
- **Opt-in stealth** — browser-consistent request headers, a per-origin cookie
  jar, referer chaining, jittered request pacing, and a pluggable CAPTCHA
  solver hook. Off by default; see below.

Be a good citizen: respect the target site's terms, robots.txt, and rate limits.

## Politeness

The defaults are deliberately polite: robots.txt is honored
(`robots: true` — set `robots: false` to skip it), requests to the same
origin are serialized (`serializePerOrigin: true`), `requestDelay` can add a
minimum gap in milliseconds between consecutive same-origin requests, a
global concurrency cap of 4 applies, and every request carries an
identifiable `crawlio/<version>` User-Agent.

Everything is unlockable: `robots: false` skips robots.txt,
`serializePerOrigin: false` lets same-origin requests run concurrently, and
`concurrency` raises the global cap — combine all three for maximum speed, at
your risk. `userAgent`, `headers`, or an injected `fetch` change what goes on
the wire.

These limits exist to be a good citizen; disabling them is your
responsibility — respect the target site's terms and applicable law.

## CLI

The `crawlio` binary ships with the package (`npx crawlio`, or a global
`pnpm add -g crawlio`). Zero extra dependencies — it is a thin wrapper over
the library API.

```
crawlio scrape <url> [--fields 'title=h1;links=a.href@all'] [--render auto|always] [--json]
crawlio map <url> [--limit N]
crawlio crawl <url> [--max-depth N] [--max-pages N]
crawlio search <query> [--provider brave|serper|tavily|module] [--api-key <key>] [--limit N] [--json]
crawlio install [--engine playwright|puppeteer] [--browser chromium|firefox|webkit] [--with-deps] [--dry-run]
crawlio --help | --version
```

- **`scrape`** fetches and extracts, printing JSON to stdout. `--fields`
  uses a mini-syntax: `name=selector` (text of first match),
  `name=selector@attr` or `name=selector.attr` for attributes (the `.attr`
  shorthand applies to common attributes: `href`, `src`, `content`, ...),
  and a trailing `@all` for arrays — entries separated by `;`. Defaults to
  `title=title`. One ambiguity to know: `name`, `title`, `value`, `alt`,
  `content`, `href`, `src`, ... are all shorthand attributes, so
  `desc=div.name` reads `div`'s `name` attribute — NOT elements with class
  `name`. For a class whose tail collides with a shorthand word use the
  bracket form (`div[class~="name"]`) or a fuller selector (`div.name
  span`); a bare `.name` (or `.name@all`) keeps the class meaning because a
  leading-dot tail can't be an attribute. `--render` loads an engine
  adapter dynamically (`--engine playwright|puppeteer`, defaulting to
  playwright when installed, else puppeteer) with the CLI's stronger
  `networkidle`/`networkidle0` settle default; `--wait-for <selector>` and
  `--wait-ms <N>` map onto the settle options above. `--browser` picks the
  Playwright engine (`chromium`|`firefox`|`webkit`; rejected under
  `--engine puppeteer`, which is Chrome-only — use `--channel` or
  `--executable-path` there instead), `--channel <name>` selects a branded
  channel the engine resolves (`"chrome"`, `"msedge"`, ... for playwright;
  `"chrome"`, `"chrome-beta"`, ... for puppeteer), and `--executable-path
  <path>` an explicit binary (mutually exclusive with `--channel`). Under
  puppeteer `--channel` defaults to `"chrome"` — puppeteer-core resolves no
  browser without one — covering both a system Chrome and `crawlio
  install`'s `puppeteer browsers install chrome` download.
  `--renderer <module>` is the custom-adapter escape hatch — a module
  specifier that replaces the built-in engines entirely (mutually
  exclusive with `--engine`/`--browser`/`--channel`/`--executable-path`/
  `--wait-for`/`--wait-ms`); see [Custom providers and
  renderers](#custom-providers-and-renderers).
  `--engine`/`--renderer`/`--browser`/`--channel`/`--executable-path`/
  `--wait-for`/`--wait-ms` all require `--render` and error out without
  it.
- **`map`/`crawl`** print their JSON result (`--limit`, `--max-depth`,
  `--max-pages` map to the library options).
- **`search`** queries a search provider and prints the hits (`--limit`
  caps them). `--provider` takes a built-in name — `brave`, `serper` or
  `tavily` — and without it the CLI auto-detects from the API-key env
  vars: `BRAVE_API_KEY` → `SERPER_API_KEY` → `TAVILY_API_KEY`, in that
  order; zero set is an error naming all three. `--api-key <key>`
  overrides the env var for a built-in name. A module specifier also
  works — see [Custom providers and
  renderers](#custom-providers-and-renderers) (`--api-key` is rejected
  there; a provider module carries its own config).
- **`install`** detects the package manager (`packageManager` manifest
  field → lockfile sniff → npm fallback; npm, pnpm, bun and yarn are
  recognized) and dev-installs `playwright-core` or `puppeteer-core`
  (`npm i -D`, `pnpm add -D`, `bun add -d`, `yarn add -D`), then runs the
  pm's npx-equivalent (`npx`, `pnpm dlx`, `bunx`, `yarn dlx`) for
  `playwright-core install <browser>` or `puppeteer browsers install
  chrome`. `--with-deps` forwards to `playwright-core install` so the
  browser's OS-level libraries come along too (apt on Linux — what a
  fresh box or CI image needs; playwright-only, rejected under
  `--engine puppeteer`). `--mcp` instead runtime-installs
  `@modelcontextprotocol/sdk`
  and `zod` (`pnpm add`, no `-D` — the `crawlio-mcp`/`crawlio/mcp` peer
  deps run inside your own server process; the SDK's own peer contract
  makes `zod` required); alone it is the whole plan, combined with
  `--engine`/`--browser` it is appended. `--dry-run` prints the plan
  without running it.

Errors go to stderr with exit code 1.

## MCP server

`crawlio-mcp` exposes the toolkit to MCP clients (Claude Desktop, agents).
It needs the optional peers `@modelcontextprotocol/sdk` and
`zod` (the SDK validates tool arguments through zod — its own peer
contract marks it required):

```sh
pnpm add crawlio && crawlio install --mcp
```

(`crawlio install --mcp` just runs `pnpm add @modelcontextprotocol/sdk
zod` through the detected package manager — runtime dependencies, not
`-D` — so installing the two packages directly yourself is the same
thing.)

Three ways to serve the same tool layer:

| Transport | How | For |
| --- | --- | --- |
| stdio (default) | `crawlio-mcp` | Claude Desktop and other local clients — the default, no flags needed |
| Streamable HTTP | `crawlio-mcp --transport http [--port N] [--host H]` | Remote/multi-client access — stateless endpoint, no session tracking |
| Any transport | `crawlio/mcp` programmatic API | Embedding — see [Embedding programmatically](#embedding-programmatically) |

`crawlio-mcp --help` prints the full flag reference (to stderr — stdout
stays clean for the JSON-RPC channel). `--port`/`--host` configure the
HTTP listener only and are rejected under `--transport stdio`.

`mcpServers` client config — stdio. `env` is THE configuration channel
for the bin: `crawlio-mcp` reads no config files, so renderer vars
(`CRAWLIO_*`) and provider API keys all ride on the `env` the client
spawns it with:

```json
{
  "mcpServers": {
    "crawlio": {
      "command": "crawlio-mcp",
      "env": {
        "CRAWLIO_ENGINE": "playwright",
        "CRAWLIO_BROWSER": "chromium",
        "BRAVE_API_KEY": "..."
      }
    }
  }
}
```

(or `"command": "npx", "args": ["-y", "-p", "crawlio", "crawlio-mcp"]` to
run it without a global install — the `crawlio-mcp` bin lives inside the
`crawlio` package.)

Where that `mcpServers` block lives per client:

| Client | Config file |
| --- | --- |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` (Windows) / `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) |
| Cursor | `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project) |
| VS Code Copilot | `.vscode/mcp.json` or `mcp.servers` in user settings — the top-level key is `"servers"`, not `"mcpServers"` |
| OpenCode | `opencode.json`/`opencode.jsonc` (project root) or `~/.config/opencode/opencode.json` (global) — different shape: top-level `"mcp"`, `"type": "local"`, `command` as an array, env under `"environment"` (see below) |
| Devin CLI | `.devin/mcp_config.json` (project) or `~/.config/devin/mcp_config.json` (global; `%APPDATA%\devin\mcp_config.json` on Windows) — same `mcpServers` shape; or `devin mcp add crawlio -- crawlio-mcp` |

OpenCode's block is the odd one out — the same server in `opencode.json`
(`"enabled": true` optional):

```json
{ "mcp": { "crawlio": { "type": "local", "command": ["crawlio-mcp"], "environment": { "BRAVE_API_KEY": "..." } } } }
```

For an HTTP client, start `crawlio-mcp --transport http` yourself and
point the client at the URL:

```json
{ "mcpServers": { "crawlio": { "type": "http", "url": "http://127.0.0.1:3000/mcp" } } }
```

(The handler answers on every path; `/mcp` is the conventional client
URL.) `--host` defaults to `127.0.0.1` — loopback only, because a scraper
bound to every interface would be a security smell. `--host 0.0.0.0` is
the explicit opt-out for LAN/remote access; do it only on a network you
trust — the HTTP endpoint has no authentication, so anyone who can reach
the port can drive the tools.

Tools — thin wrappers over the library calls, so robots.txt, per-origin
serialization, retries, and stealth flow through exactly as elsewhere:

| Tool | Arguments | Returns |
| --- | --- | --- |
| `scrape` | `url`, `fields?`, `render?` (`"auto"`/`"always"`) | Extracted fields JSON |
| `map` | `url`, `limit?` | `{ urls, source }` |
| `crawl` | `url`, `maxDepth?`, `maxPages?` | `{ pages, visited, skipped }` |
| `search` | `query`, `provider?`, `limit?` | `SearchResult[]` |

A `scrape` call and what the agent gets back — every tool returns its
result serialized as JSON text inside a `content` envelope:

```json
{
  "name": "scrape",
  "arguments": {
    "url": "https://example.com",
    "fields": { "title": "h1", "author": { "selector": "meta[name=author]", "attr": "content" } }
  }
}
```

```json
{ "content": [{ "type": "text", "text": "{\"title\":\"Example Domain\"}" }] }
```

Failures return `{ "isError": true, "content": [...] }` carrying the
error message — and unknown or misspelled arguments are rejected outright
(strict schemas), so a typo surfaces as an error instead of a silent
default.

`fields` is a JSON object matching `FieldSpecRecord` — a selector string or
`{ "selector", "attr"?, "all"? }` per entry (`transform` is a function and
cannot cross JSON, so it is rejected). `provider` takes a built-in name
(`"brave"`/`"serper"`/`"tavily"` — the key comes from `BRAVE_API_KEY` /
`SERPER_API_KEY` / `TAVILY_API_KEY`) or a module specifier; omit it to
autodetect from those env vars, in that order — the CLI's precedence.

Renderer config is env-only, mirroring the CLI's `--render` engine flags:

| Env var | Meaning |
| --- | --- |
| `CRAWLIO_ENGINE` | `playwright` or `puppeteer` — the built-in adapter |
| `CRAWLIO_BROWSER` | Playwright engine: `chromium`, `firefox`, `webkit` |
| `CRAWLIO_CHANNEL` | Branded channel the engine resolves (`"chrome"`, `"msedge"`, ...) |
| `CRAWLIO_EXECUTABLE_PATH` | Explicit browser binary (mutually exclusive with `CRAWLIO_CHANNEL`) |
| `CRAWLIO_RENDERER` | Custom-adapter module specifier — replaces engine resolution entirely |

Set `CRAWLIO_BROWSER`/`CRAWLIO_CHANNEL`/`CRAWLIO_EXECUTABLE_PATH` without
`CRAWLIO_ENGINE` and the engine autodetects like `--render` without
`--engine`: playwright when `playwright-core` is installed, else puppeteer.

Without any renderer env, `scrape` never renders and a `render` argument
errors. With one configured, `render` defaults to `"auto"`; `"always"`
skips the static fetch. One lazy renderer is shared by all tool calls and
closed on shutdown.

### Embedding programmatically

The same layer the `crawlio-mcp` binary wires onto stdio is importable as
`crawlio/mcp` — `createCrawlioMcpServer`, `createCrawlioTools`,
`createCrawlioMcpHttpHandler`, the
`resolveEnvRenderer`/`resolveMcpSearchProvider`/`parseJsonFields` helpers,
and their types (`CrawlioMcpServer`, `CrawlioTools`, `CrawlioToolsDeps`,
`CrawlioMcpHttpHandler`, `McpToolDefinition`, `McpToolResult`,
`ClosableRenderer`):

```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCrawlioMcpServer } from "crawlio/mcp";

const { server, tools } = await createCrawlioMcpServer();
// `server` is the high-level McpServer — onclose/onerror live on the
// underlying Server it wraps.
server.server.onclose = () => void tools.close().catch(() => undefined);
await server.connect(new StdioServerTransport());
```

Same server, any transport — over HTTP it's the Streamable HTTP transport
(the SSE transport is deprecated). `crawlio/mcp` ships the bin's exact
wiring as `createCrawlioMcpHttpHandler(tools, onError?)`: STATELESS
(`sessionIdGenerator: undefined` — no session tracking; the scraper holds
no per-session state) and per-request transports, because SDK 1.32's
stateless transport refuses to serve a second request on the same
instance:

```ts
import { createServer } from "node:http";
import { createCrawlioMcpHttpHandler, createCrawlioTools } from "crawlio/mcp";

const tools = createCrawlioTools();
const handler = await createCrawlioMcpHttpHandler(tools);
createServer((req, res) => void handler(req, res)).listen(3000, "127.0.0.1");
```

For Fetch-style runtimes (Workers, Deno, Bun) the equivalent is
`WebStandardStreamableHTTPServerTransport` from
`@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js` — fresh
transport (and `McpServer`, since a `Protocol` accepts one `connect()` at
a time) per request, `Request`/`Response` in place of `req`/`res`.

Like `crawlio/playwright` without `playwright-core`, `import "crawlio/mcp"`
works with the peers absent — the SDK and zod are only `import()`ed inside
`createCrawlioMcpServer`, where a missing install surfaces as a
`ConfigError`. `createCrawlioTools` (the transport-free tool layer) never
touches either at all.

## Stealth (opt-in)

`stealth` is available on `createScraper`, and per call on `fetchHtml` /
`scrape*` (the call-level value wins). `false` or absent keeps the honest
defaults untouched — an identifiable `crawlio/<version>` UA and minimal
headers.

```ts
const scraper = createScraper({ stealth: true });            // desktop Chrome profile
const scraper = createScraper({ stealth: { browser: "firefox", locale: "de-DE" } });
```

What it covers, all HTTP-layer:

- **Browser header profile** — a complete, internally consistent header set
  per family (`"chrome"` | `"firefox"` | `"safari"`): matching `user-agent`,
  `sec-ch-ua*` client hints (Chrome only, like the real thing), `accept`,
  `accept-language` from `locale`, and the `sec-fetch-*` metadata of a
  top-level document GET. Consistency is the point — a Chrome UA without its
  client hints is itself a tell.
- **Cookie jar** — `Set-Cookie` is stored per origin and resent on later
  requests (`Expires`/`Max-Age` and `Secure` honored; `Domain`/`Path`
  deliberately not modeled). One jar per scraper instance — the module-level
  helpers share the default scraper's jar.
- **Referer chain** — same-origin requests carry `Referer` of the previously
  fetched page (first request looks like a typed-URL visit).
- **Jittered pacing** — `requestDelay` also accepts `{ min, max }`, sampled
  uniformly per request.
- **CAPTCHA solver hook** — `solver` is a user-provided
  `{ solve(challenge) => Promise<CaptchaSolution> }` interface, not a built-in
  service. When a challenge page is detected (Cloudflare interstitial,
  Turnstile, reCAPTCHA, hCaptcha markers), the solver runs once and the request
  is retried once with the returned cookies + bound User-Agent.

Honest ceiling — stealth here is headers, cookies, and timing. It does NOT:

- mimic TLS (JA3) or HTTP/2 fingerprints — those belong to the transport;
  inject an impersonating client via the `fetch` option;
- execute JavaScript — challenges that need a real browser still need one;
- fix IP reputation — that's what proxies are for (see below).

Solver services are external and usually paid; API keys live inside your own
`solve` implementation, never in SDK config. A solved challenge is not a
guarantee of access. Using stealth is your responsibility — respect the target
site's terms and applicable law.

## Proxies

Route requests through HTTP(S) proxies — pin one, or pool several:

```ts
const scraper = createScraper({
  proxies: [
    process.env.PROXY_A as string, // e.g. "http://user:pass@1.2.3.4:8080"
    process.env.PROXY_B as string,
  ],
  proxyRotation: "on-ban", // default "per-origin"
});

// Per-call escape hatch — pin a single proxy for this request:
await scraper.fetchHtml("https://example.com", { proxy: process.env.PROXY_A });
```

Rotation strategies (`proxyRotation`):

- **`"per-origin"`** (default) — each target origin binds to one proxy on
  first touch and keeps it. Session consistency matters: a `cf_clearance` is
  bound to the IP that issued it, so cookies only stay valid while the origin
  exits through the same proxy.
- **`"per-request"`** — round-robin on every wire request. **Warning:** this
  breaks session consistency — consecutive requests to one origin leave
  through different IPs, so cookie jars and referer chains stop telling a
  coherent story. Stateless fan-out only.
- **`"on-ban"`** — `per-origin` plus health: the origin's proxy is reassigned
  on ban signals (transport failure, HTTP 407/403/429, a detected challenge
  page, or a timeout). A proxy that fails 3 times in a row is quarantined for
  ~5 minutes and skipped; if every proxy is quarantined, the earliest-expiring
  one serves anyway — a dead pool still tries.

Instance-level `proxies` builds one **stateful** pool whose health state is
shared across calls — that's what makes `on-ban` useful. A per-call `proxies`
builds a fresh **stateless** pool for that request, so `proxy` is the
sensible per-call option.

Rules and honest caveats:

- **Credentials** live only in the proxy URL (`http://user:pass@host:port`),
  typically composed from environment variables as above — never hardcoded,
  never logged; error messages scrub them.
- **Under Bun, proxies need Bun >= 1.4.3** — routing uses `Bun.FetchSession`
  (per-proxy pooled sessions); older Bun releases can't drive this feature.
- **`proxy`/`proxies` can't be combined with an injected `fetch`** — a custom
  fetch can't be routed through a proxy dispatcher, so the combination throws
  `ConfigError`. For transports the SDK can't drive (impersonating TLS
  clients, custom proxy logic), pass a proxy-aware `fetch` instead.
- **SOCKS is not supported in v1** — `socks:`/`socks5:` URLs throw
  `ConfigError`. undici 8's `ProxyAgent` can drive SOCKS natively, but it
  stays off until it has real SOCKS-server coverage; inject a SOCKS-capable
  client via `fetch` instead.
- **Free public proxy lists are mostly dead or MITM-risky** — the
  health-checking above exists for a reason. Send nothing sensitive through a
  proxy you don't trust; prefer paid providers or your own relays.

## Rendering JavaScript pages (`render`)

Static HTTP cannot see content that only exists after JavaScript runs. The
`render` option is the seam for that: inject a `Renderer` — "an expensive
fetcher" that navigates a real browser engine, waits, and returns the final
HTML. The engine is **injected, never bundled** — crawlio ships no browser.

```ts
import { createScraper } from "crawlio";
import { playwrightRenderer } from "crawlio/playwright";

const renderer = playwrightRenderer({
  channel: "chrome",            // branded channel — or executablePath: "/path/to/browser"
  waitUntil: "networkidle",     // default "load"
  waitForSelector: "#app h1",   // wait for this after the navigation settles
});
const scraper = createScraper({ render: renderer }); // renderMode: "auto" is the default

const page = await scraper.scrape("https://spa.example.com", { title: "h1" });
await renderer.close(); // the browser is yours to close
```

Two official adapters ship as subpath exports, each backed by an optional
peer dependency imported lazily on the first render:

- **`crawlio/playwright` — Playwright** (`pnpm add playwright-core`). `browser`
  (`"chromium"` | `"firefox"` | `"webkit"`), `executablePath`, `channel`,
  `headless`, `waitUntil`, `waitForSelector`, `waitForTimeout`, and
  `timeoutMs` configure it.
- **`crawlio/puppeteer` — Puppeteer** (`pnpm add puppeteer-core`, `>=24.21`). Same
  shape minus `browser` (Puppeteer is Chrome-only): `executablePath`,
  `channel` (`"chrome"`, `"chrome-beta"`, ...), `headless`, `waitUntil`
  (Puppeteer names: `"networkidle0"` / `"networkidle2"`, not `"networkidle"`),
  `waitForSelector`, `waitForTimeout`, and `timeoutMs`.

**Settle options** — how the page is waited out, in composition order:

1. `waitUntil` — the `goto` navigation-settle condition.
2. `waitForSelector` — after `goto` settles, wait for this selector before
   reading content. **This is the way to wait for SPA content
   deterministically.** Each engine applies its own defaults (Playwright:
   visible; Puppeteer: present in the DOM), bounded by the navigation
   timeout.
3. `waitForTimeout` — a fixed settle in milliseconds, applied last. The
   cruder escape hatch — prefer `waitForSelector` when you know what to wait
   for.

All three compose: `goto(waitUntil)` → `waitForSelector` → `waitForTimeout`
→ `content()`. Both are validated at construction (`waitForSelector`
non-empty, `waitForTimeout` a finite non-negative number — `ConfigError`
otherwise). They are renderer options, not scraper options — the scraper
never sets them. They also exist on `RenderCallOptions` so a caller driving
`renderer.render()` directly can pass them per call (per-call wins over the
adapter default).

**Browser resolution** — how each adapter finds a browser binary:

- `channel` — a branded, already-installed browser the engine resolves
  itself: `"chrome"`/`"msedge"` for Playwright, `"chrome"`/`"chrome-beta"`/
  `"chrome-canary"`/`"chrome-dev"` for Puppeteer. Zero downloads, but the
  browser must actually be installed.
- `playwright install` (or `crawlio install`) — Playwright downloads its own
  browser builds into the `ms-playwright` cache (`%LOCALAPPDATA%\ms-playwright`
  on Windows); with no `channel`/`executablePath` set, the adapter uses
  these. WebKit works on Windows — Playwright ships its own build.
- `executablePath` — an explicit binary path (CI images, unusual locations).
  Mutually exclusive with `channel`.
- Puppeteer never downloads on its own — `puppeteer-core` needs `channel`,
  `executablePath`, or a browser installed via `npx puppeteer browsers
  install chrome` (what `crawlio install --engine puppeteer` runs).

```ts
import { puppeteerRenderer } from "crawlio/puppeteer";
const renderer = puppeteerRenderer({ channel: "chrome", waitUntil: "networkidle2" });
```

Both share the same lifecycle: the browser launches lazily, is reused across
renders, each render runs in an ephemeral browser context, and `close()` is
yours to call. Any other engine works too — implement `Renderer` yourself,
it is one method:
`render(url, { timeout, signal, userAgent }) => { url, html, status? }`.

`renderMode` (instance default or per call — the call wins):

- **`"auto"` (default)** — static fetch first; render only when
  `isLikelyDynamic(html)` flags a JS shell (empty app mount points, a
  near-empty body with scripts, "enable JavaScript" noscript warnings) or, on
  `scrape*` calls, when every extracted field came back `undefined`. A render
  failure falls back to the static result — `auto` never makes a page worse.
- **`"always"`** — skip the static fetch entirely; the renderer IS the fetch
  and render failures propagate as the call's error.

`FetchHtmlResult.rendered` is `true` when the render path answered — an
honest signal of which path served, not a quality claim. robots.txt still
gates the URL before either path fires, and rendered HTML flows through the
normal parse/extract pipeline. `retries` applies to the static HTTP path
only — a renderer call is one navigation, never retried. An injected `fetch`
serves the static HTTP path and robots.txt only; the renderer is a separate
engine and never sees it. `isLikelyDynamic` is also exported on its own
— remember it is a hint, not a verdict (SSR pages carry framework markers
while being fully populated).

Honest limits:

- **The engine owns its own context** — stealth headers, the cookie jar, and
  proxy routing do NOT apply inside the browser, and browser-side cookies do
  not flow back into the SDK's jar.
- **A browser is not a challenge solver** — rendering does not defeat managed
  bot challenges (Turnstile, Cloudflare interstitials) by itself.
- **Rendering runs untrusted JavaScript** — the page's scripts execute in a
  real browser on your machine. The adapter isolates each render in an
  ephemeral context (no shared profile), but keep the engine patched and
  prefer an isolated environment for hostile targets.
- **Rendering is read-only** — navigate, wait, return HTML. Browser actions
  (click/fill/type) are a non-goal and live in the sibling project.

The repo e2e (`e2e/render.test.ts`) exercises all of this against a real
chromium — and against the real artifact: `bun run e2e` packs the tarball,
`npm install`s it into a throwaway consumer project where the packed
`crawlio install` does the engine setup, and runs the suite there.

## Custom providers and renderers

The built-in adapters cover the common cases — this section is for custom
adapters. Every external capability in crawlio is an object seam —
injected, never bundled:

| Seam | Interface | Where it's injected | Built-in adapters |
| --- | --- | --- | --- |
| Renderer | `{ render(url, options?) → RenderedPage }` (+ optional `close()`) | `createScraper({ render })` | `playwrightRenderer`, `puppeteerRenderer` |
| Search provider | `{ search(query, options?) → SearchResult[] }` | `search(q, { provider })` | `braveSearchProvider`, `serperSearchProvider`, `tavilySearchProvider` |
| CAPTCHA solver | `{ solve(challenge) → CaptchaSolution }` | `createScraper({ solver })` | none — always yours |
| Fetch | `typeof globalThis.fetch` | `createScraper({ fetch })`, per call, provider adapters | undici default |

A custom adapter is just a plain object satisfying the interface — no
registration, no base class:

```ts
import { createScraper, search } from "crawlio";

const render = { async render(url) { return { url, html: await myEngine.render(url) }; } };
const provider = { async search(q) { return [{ url: `https://hits.example/?q=${q}` }]; } };

const scraper = createScraper({ render });
await search("typed scraping sdk", { provider });
```

Writing one — or loading an adapter module into the CLI
(`--provider`/`--renderer` take module specifiers)? Contracts, worked
examples, packaging, and testing live in
[docs/custom-adapters.md](docs/custom-adapters.md).

## License

MIT
