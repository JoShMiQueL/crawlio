import { ConfigError, showValue } from "./errors.js";
import { MAX_REDIRECTS, REDIRECT_STATUSES, readResponseBody } from "./fetch.js";
import { assertPublicHost, type HostLookup, systemHostLookup } from "./private-hosts.js";
import { defaultFetch } from "./proxy.js";
import { parse, type RobotsAgent } from "./robots-parser.js";
import { fuseSignal } from "./signal.js";

/** A parsed robots.txt policy for one origin — built by `src/robots-parser.ts`. */
export type { RobotsAgent } from "./robots-parser.js";

/**
 * Ceiling on a robots.txt body (512 KiB): RFC 9309 leaves file size to the
 * recipient and major crawlers cap near 500 KiB. An oversized file counts
 * as a FAILED fetch — the allow-all fallback, never cached — same as an
 * unreachable one; it must not pull unbounded memory to answer "may I?".
 */
export const ROBOTS_MAX_BODY_BYTES = 512 * 1024;

/**
 * Parse robots.txt `contents` (as fetched from `url`) into a {@link RobotsAgent}.
 * Pure — performs no I/O.
 *
 * @param url The URL the file was fetched from (rules are matched against it).
 * @param contents Raw robots.txt text.
 * @returns A queryable policy agent.
 */
export function parseRobots(url: string, contents: string): RobotsAgent {
  return parse(url, contents);
}

/**
 * Whether `userAgent` may fetch `url` under `robots`.
 *
 * A missing policy (`null`/`undefined` — no usable robots.txt) means allow; the
 * parser itself answers `true` for undecidable queries (bad or cross-origin
 * URL), so an ambiguous file never silently blocks scraping.
 */
export function robotsAllowed(
  robots: RobotsAgent | null | undefined,
  url: string,
  userAgent: string,
): boolean {
  if (!robots) return true;
  return robots.isAllowed(url, userAgent);
}

/**
 * The outcome of a `robots.txt` fetch, distinguished for caching:
 * - `agent` — a parsed robots.txt; cache it.
 * - `none` — the file is legitimately absent (non-OK status, e.g. 404/410);
 *   "allow-all" is a STABLE answer for the origin, so it is cacheable.
 * - `failed` — the fetch itself failed (network error, timeout, caller abort);
 *   "allow-all" here is a fallback, not an answer, and must NOT be cached —
 *   the next call retries the fetch.
 */
export type RobotsFetchResult =
  | { kind: "agent"; agent: RobotsAgent }
  | { kind: "none" }
  | { kind: "failed" };

/**
 * Fetch and parse `/robots.txt` for the given URL.
 *
 * Returns `null` — meaning "allow" — whenever the file cannot be obtained or is
 * absent: a 404/410, any non-OK status, a network error, or a timeout. RFC 9309
 * treats an unreachable robots.txt as full allowance, so a failure to fetch it
 * must never silently block scraping.
 */
export async function fetchRobotsTxt(
  url: string,
  options: {
    userAgent?: string;
    timeout?: number;
    fetch?: typeof globalThis.fetch;
    signal?: AbortSignal;
    /**
     * Same policy as `FetchHtmlOptions.blockPrivateHosts` — the robots.txt
     * probe is a request too, and it fires BEFORE the page fetch it gates.
     * Every redirect hop is vetted as well: with the guard on the probe
     * follows redirects manually, checking each `Location` target before it
     * is requested. When the guard is off the probe fires a single request
     * with the impl's default redirect handling.
     */
    blockPrivateHosts?: boolean;
    /**
     * Internal test seam — DNS resolver override for `blockPrivateHosts`
     * (the `__dnsLookup` seam in fetch.ts). Not public API.
     */
    __dnsLookup?: HostLookup;
  } = {},
): Promise<RobotsAgent | null> {
  const result = await fetchRobotsTxtResult(url, options);
  return result.kind === "agent" ? result.agent : null;
}

/**
 * {@link fetchRobotsTxt} with the failure kind preserved, so a cache can tell a
 * stable "no robots.txt" (`none`, cacheable) from a transient failure
 * (`failed`, must be retried on the next call).
 */
export async function fetchRobotsTxtResult(
  url: string,
  options: {
    userAgent?: string;
    timeout?: number;
    fetch?: typeof globalThis.fetch;
    signal?: AbortSignal;
    /**
     * Same policy as `FetchHtmlOptions.blockPrivateHosts` — the robots.txt
     * probe is a request too, and it fires BEFORE the page fetch it gates.
     * Every redirect hop is vetted as well: with the guard on the probe
     * follows redirects manually, checking each `Location` target before it
     * is requested. When the guard is off the probe fires a single request
     * with the impl's default redirect handling.
     */
    blockPrivateHosts?: boolean;
    /**
     * Internal test seam — DNS resolver override for `blockPrivateHosts`
     * (the `__dnsLookup` seam in fetch.ts). Not public API.
     */
    __dnsLookup?: HostLookup;
  } = {},
): Promise<RobotsFetchResult> {
  const fetchImpl = options.fetch ?? defaultFetch;
  // `blockPrivateHosts` is fail-closed like the fetch layer's flag: a
  // non-boolean must error, never silently read as "off" (`1` would fire
  // an UNGUARDED probe). Config validation runs BEFORE any resource
  // allocation below (the AbortController, its timer, the fused signal the
  // try guards) and before the try itself — a ConfigError must propagate
  // to the caller, not collapse into `failed` (allow-all).
  if (options.blockPrivateHosts !== undefined && typeof options.blockPrivateHosts !== "boolean") {
    throw new ConfigError(
      `\`blockPrivateHosts\` must be a boolean, got ${showValue(options.blockPrivateHosts)}`,
      { url },
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout ?? 10_000);
  const fused = fuseSignal(controller.signal, options.signal);
  const headers: Record<string, string> = options.userAgent
    ? { "user-agent": options.userAgent }
    : {};
  try {
    if (options.blockPrivateHosts === true) {
      // The probe runs before the page fetch it gates — without this, a
      // private host's robots.txt would be fetched before the fetch-layer
      // guard ever fires. Redirects are followed MANUALLY here so every hop
      // is vetted before it is requested: the impl's own redirect handling
      // would carry the probe to a private target unchecked. A refusal (or
      // a bad/off-scheme Location) lands in `catch` → `failed` (allow-all
      // fallback); the page fetch itself still gets refused downstream.
      const lookup = options.__dnsLookup ?? systemHostLookup;
      let currentUrl = url;
      let hops = 0;
      for (;;) {
        await assertPublicHost(currentUrl, lookup);
        const response = await fetchImpl(currentUrl, {
          headers,
          signal: fused.signal,
          redirect: "manual",
        });
        const location = response.headers.get("location");
        if (!REDIRECT_STATUSES.has(response.status) || location === null || location === "") {
          if (!response.ok) return { kind: "none" };
          // A custom impl may ignore `manual` and follow redirects itself —
          // vet its reported landing URL before the body is read, the same
          // post-hoc check fetchHtmlOnce runs for internally-followed hops.
          if (response.url !== "" && response.url !== currentUrl) {
            try {
              await assertPublicHost(response.url, lookup);
            } catch (cause) {
              await response.body?.cancel().catch(() => undefined);
              throw cause;
            }
          }
          const bytes = await readResponseBody(response, ROBOTS_MAX_BODY_BYTES, currentUrl);
          return {
            kind: "agent",
            agent: parseRobots(currentUrl, new TextDecoder().decode(bytes)),
          };
        }
        // Release the redirect response's body so its connection can be
        // reused before the next hop fires.
        if (response.body !== null) {
          await response.body.cancel().catch(() => undefined);
        }
        hops += 1;
        if (hops > MAX_REDIRECTS) {
          throw new Error(`Too many redirects (>${MAX_REDIRECTS}) fetching robots.txt`);
        }
        const next = new URL(location, currentUrl);
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          throw new Error(`Refusing a robots.txt redirect off http(s) to ${next.protocol}`);
        }
        currentUrl = next.toString();
      }
    }
    const response = await fetchImpl(url, {
      headers,
      signal: fused.signal,
    });
    if (!response.ok) return { kind: "none" };
    const bytes = await readResponseBody(response, ROBOTS_MAX_BODY_BYTES, url);
    return { kind: "agent", agent: parseRobots(url, new TextDecoder().decode(bytes)) };
  } catch {
    return { kind: "failed" };
  } finally {
    clearTimeout(timeout);
    fused.release();
  }
}

/** The `/robots.txt` URL for the origin of `targetUrl`. */
export function robotsUrlFor(targetUrl: string): string {
  const parsed = new URL(targetUrl);
  return `${parsed.protocol}//${parsed.host}/robots.txt`;
}
