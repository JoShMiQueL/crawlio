# Changelog

## [0.1.1](https://github.com/JoShMiQueL/crawlio/compare/v0.1.0...v0.1.1) (2026-10-19)


### Bug Fixes

* release-please component-less tags — crawlio-v* tags never matched release.yml v* trigger ([#38](https://github.com/JoShMiQueL/crawlio/issues/38)) ([54cc520](https://github.com/JoShMiQueL/crawlio/commit/54cc520124c26e80fdf89530a9a3a65693e46810))


### Reverts

* release-please PR template customization ([#40](https://github.com/JoShMiQueL/crawlio/issues/40)) ([08adee8](https://github.com/JoShMiQueL/crawlio/commit/08adee86a806e80081562d83b9c84a52c3854288))

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
- Challenge detection — `detectChallenge` recognizes Cloudflare interstitials, Turnstile/reCAPTCHA/hCaptcha widgets, full-page vendor bot-walls (Amazon "Robot Check", PerimeterX, DataDome, Akamai, Incapsula), and a conservative `generic-bot-check` fallback; solvers declare the shapes they handle via `CaptchaSolver.claims` (built-ins claim Cloudflare interstitials only)
- Bun runtime support — `isBun` flag; under Bun, proxies route via `fetch`'s native `proxy` option instead of undici dispatchers, and `crawlio-mcp --transport http` serves via `Bun.serve` (`createCrawlioMcpFetchHandler` on the SDK's `WebStandardStreamableHTTPServerTransport`)
- `build:bin` — `bun build --compile` standalone binaries for `crawlio` and `crawlio-mcp` into `dist-bin/` (engine peers stay external, version stamped from package.json)
- `blockPrivateHosts` (opt-in) — SSRF guard refusing private/reserved IP literals and DNS answers before the request fires, rechecked on every redirect hop and on robots.txt probes; refusals throw `BlockedHostError` (`CRAWLIO_BLOCK_PRIVATE_HOSTS=1` on `crawlio-mcp`)
- `maxBodyBytes` — response body size cap (10 MiB default, `Infinity` disables; sitemaps capped at the 50 MiB protocol max, robots.txt at 512 KiB); over-cap responses throw `ResponseTooLargeError`
