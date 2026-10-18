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

- **SSRF is mitigated by an opt-in guard — with honest limits.**
  `blockPrivateHosts: true` (a `ScraperOptions` default, overridable per
  call; `CRAWLIO_BLOCK_PRIVATE_HOSTS=1` on `crawlio-mcp`) refuses requests
  whose host is a private/reserved IP literal or resolves to one via DNS
  — loopback, RFC 1918, link-local (including the 169.254.169.254
  metadata endpoint), CGNAT, benchmarking and documentation ranges, IPv6
  ULA/link-local/multicast — checked on the initial URL, on every
  redirect hop, and on the robots.txt probe (whose own redirects are
  followed hop-by-hop under the guard), surfacing as `BlockedHostError`
  (`code: "blocked-host"`). It stays OFF by default: intranet and
  localhost scraping are legitimate uses. The guard is a lookup-time
  check — DNS rebinding can re-resolve a hostname differently at connect
  (TOCTOU), a custom `fetch` that follows redirects internally bypasses
  the per-hop check, and the blocked-range list is a high-value denylist,
  not an exhaustive IANA registry mirror. With `render`, only the initial
  navigation target is vetted — redirects and subresources inside the
  browser cannot be. For strict isolation, run crawlio in a
  network-restricted environment (egress firewall or namespace), and
  still gate untrusted URLs upstream. Target URLs are http(s);
  `map`/`crawl` reject other schemes outright.
- **Response bodies are size-capped.** `maxBodyBytes` (default 10 MiB)
  bounds the memory a single response can consume — a `Content-Length`
  over the cap fails without reading, a lengthless body is aborted
  mid-stream, and robots.txt is capped internally at 512 KiB — so a
  hostile target cannot OOM the process. `maxBodyBytes: Infinity`
  disables the cap.
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
