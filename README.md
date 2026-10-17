# crawlio

Simple, typed web scraping for static HTML: fetch a page, parse it, and extract
typed fields via CSS selectors. Pre-1.0 — the API may still change.

## Install

```sh
pnpm add crawlio
# or
npm i crawlio
```

Requires Node.js >= 22.

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
- fix IP reputation — that needs proxies, which are out of scope.

Solver services are external and usually paid; API keys live inside your own
`solve` implementation, never in SDK config. A solved challenge is not a
guarantee of access. Using stealth is your responsibility — respect the target
site's terms and applicable law.

## License

MIT
