# crawlio

Simple, typed web scraping for static HTML: fetch a page, parse it, and extract
typed fields via CSS selectors. Pre-1.0 — the API may still change.

## What is crawlio

A typed, self-hosted Node.js SDK for web data extraction — scrape/crawl/map/search
over HTTP, with a pluggable renderer for JS-heavy pages. It's a library you run
in your own process, not a hosted service.

| Capability | Status |
| --- | --- |
| scrape — fetch + typed extraction over HTTP | done |
| Politeness controls — robots.txt, per-origin serialization, delays, concurrency cap | done |
| Stealth (opt-in) — browser header profiles, cookie jar, referer chain, jitter | done |
| CAPTCHA solver seam — user-provided `solve` interface | done |
| `map` — discover all URLs on a site | done |
| `crawl` — recursive same-site traversal | done |
| Proxies — pool routing with rotation and ban-aware health checks | done |
| `render` seam + `isLikelyDynamic` — headless engine injection for JS pages | planned |
| `search` — via external search providers | planned |
| MCP server — expose the toolkit to agents | planned |

Non-goals:

- **No browser actions, ever.** No click/fill/type/navigation flows — the
  renderer is read-only. Browser automation lives in a separate sibling
  project.
- **No own search index** — `search` delegates to external providers.
- **No managed-challenge guarantees at the HTTP layer** — the solver seam
  exists, but solving is your solver's job and success is never promised.
- **Nothing hosted** — no API keys, no cloud component, no account.

## Install

```sh
pnpm add crawlio
# or
npm i crawlio
```

Requires Node.js >= 22.19.

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

## Etiquette

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

## License

MIT
