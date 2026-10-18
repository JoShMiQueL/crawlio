# Changelog

## [0.1.0] - Unreleased

### Added

- `scrape` — fetch + typed field extraction via CSS selectors, types inferred from the spec
- Batch helpers — `scrapeMany`, `scrapeManySafe`
- `map` — site URL discovery (sitemap first, link fallback)
- `crawl` — recursive same-origin traversal with depth/page politeness caps
- `search` — `braveSearchProvider`, `serperSearchProvider`, `tavilySearchProvider`, custom `SearchProvider` seam
- `render` seam — `playwright`/`puppeteer` adapters (`crawlio/playwright`, `crawlio/puppeteer`) + custom adapter loading
- CLI — `crawlio scrape|map|crawl|search|install`
- MCP server — `crawlio-mcp` stdio + streamable HTTP, embeddable via `crawlio/mcp`
- Politeness — robots.txt honoring, per-origin serialization, delays, concurrency cap, shared retry/backoff
- Stealth (opt-in) — browser header profiles, cookie jar, referer chain, jitter
- Proxies — pool routing with rotation and ban-aware health checks
- CAPTCHA solver seam — user-provided `solve` interface
- Bun runtime support — `isBun` flag; under Bun, proxies route via `fetch`'s native `proxy` option instead of undici dispatchers, and `crawlio-mcp --transport http` serves via `Bun.serve` (`createCrawlioMcpFetchHandler` on the SDK's `WebStandardStreamableHTTPServerTransport`)
- `build:bin` — `bun build --compile` standalone binaries for `crawlio` and `crawlio-mcp` into `dist-bin/` (engine peers stay external, version stamped from package.json)
- `blockPrivateHosts` (opt-in) — SSRF guard refusing private/reserved IP literals and DNS answers before the request fires, rechecked on every redirect hop and on robots.txt probes; refusals throw `BlockedHostError` (`CRAWLIO_BLOCK_PRIVATE_HOSTS=1` on `crawlio-mcp`)
- `maxBodyBytes` — response body size cap (10 MiB default, `Infinity` disables; sitemaps capped at the 50 MiB protocol max, robots.txt at 512 KiB); over-cap responses throw `ResponseTooLargeError`
