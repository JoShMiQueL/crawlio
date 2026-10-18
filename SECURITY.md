# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | yes — current release line |

While crawlio is 0.x, security fixes land on the latest minor only;
older minors are not patched. Upgrade to the current release.

## Reporting a vulnerability

Report privately through [GitHub Security
Advisories](https://github.com/JoShMiQueL/crawlio/security/advisories/new)
("Report a vulnerability" on the repo's Security tab).

Please do NOT open a public issue for a suspected vulnerability — a public
report is visible before a fix exists. Include enough detail to reproduce:
the affected version, the URL shape or configuration that triggers it, and
the observed impact. If the report is confirmed, the fix ships on the
supported line and the advisory credits the reporter (or stays anonymous —
your choice).

## Scope notes

crawlio fetches the URLs you give it — that is the feature, and the threat
model:

- **SSRF is the caller's responsibility.** crawlio ships no IP
  allow/blocklist. If URLs come from untrusted input (an MCP client, an
  HTTP handler, agent output), gate them upstream — internal ranges,
  link-local, and metadata endpoints are yours to block. Target URLs are
  http(s); `map`/`crawl` reject other schemes outright.
- **robots.txt is honored by default** (`robots: false` opts out) and the
  default User-Agent is identifiable — politeness, not evasion.
- **Credential handling is best-effort.** Proxy credentials embedded in
  URLs are scrubbed from errors and result fields (`scrubUrl`), and auth
  headers/cookies are never written to fixtures — but no library can
  guarantee nothing ever leaks. Treat the log output of a scraping run as
  sensitive.
- **Solvers and proxies are third parties.** Whatever is sent to
  CapSolver, FlareSolverr, or a proxy exits through that provider's
  infrastructure; API keys live in the solver config or env, never in SDK
  config.
- **Renderers execute untrusted JavaScript.** The page's scripts run in a
  real browser on your machine. Each render is isolated in an ephemeral
  browser context, but keep the engine patched and prefer an isolated
  environment for hostile targets.
