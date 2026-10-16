# scrape-sdk

Simple, typed web scraping for static HTML: fetch a page, parse it, and extract
typed fields via CSS selectors. Pre-1.0 — the API may still change.

## Install

```sh
pnpm add scrape-sdk
# or
npm i scrape-sdk
```

Requires Node.js >= 22.

## Usage

```ts
import { scrape } from "scrape-sdk";

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

Be a good citizen: respect the target site's terms, robots.txt, and rate limits.

## Etiquette

The defaults are deliberately polite: robots.txt is honored
(`robots: true` — set `robots: false` to skip it), requests to the same
origin are serialized (`serializePerOrigin: true`), `requestDelay` can add a
minimum gap in milliseconds between consecutive same-origin requests, a
global concurrency cap of 4 applies, and every request carries an
identifiable `scrape-sdk/<version>` User-Agent.

Everything is unlockable: `robots: false` skips robots.txt,
`serializePerOrigin: false` lets same-origin requests run concurrently, and
`concurrency` raises the global cap — combine all three for maximum speed, at
your risk. `userAgent`, `headers`, or an injected `fetch` change what goes on
the wire.

These limits exist to be a good citizen; disabling them is your
responsibility — respect the target site's terms and applicable law.

## License

MIT
