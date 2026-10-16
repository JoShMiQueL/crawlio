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
- **robots.txt support** — opt-in (`robots: true`); honors disallow rules and
  crawl-delay.
- **Identifiable User-Agent** — a configurable, honest UA by default.
- **Concurrency control** — per-origin serialization plus a global concurrency
  cap; batch helpers (`scrapeMany`, `scrapeManySafe`) included.

Be a good citizen: respect the target site's terms, robots.txt, and rate limits.

## License

MIT
