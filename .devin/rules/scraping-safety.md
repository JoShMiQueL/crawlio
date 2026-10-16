---
description: Scraping etiquette and legal-safety rules for network/extraction code
trigger: model_decision
---

When writing or modifying fetching, extraction, or HTTP code:
- Honor robots.txt and rate limits; default to conservative request rates, configurable.
- All network I/O goes through the shared retry/backoff policy — no ad-hoc retries at call sites.
- Validate raw scraped data before it enters public types; never trust page shape.
- No credential leakage: credentials from config/env only, scrubbed from logs/errors/fixtures.
- Identifiable, configurable User-Agent by default; no stealth spoofing unless opt-in.
