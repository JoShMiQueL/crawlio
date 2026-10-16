import { createRequire } from "node:module";
import { fuseSignal } from "./signal.js";

const require = createRequire(import.meta.url);
type RobotParser = (
  url: string,
  robotstxt: string,
) => {
  isAllowed(url: string, ua?: string): boolean | undefined;
  isDisallowed(url: string, ua?: string): boolean | undefined;
  getMatchingLineNumber(url: string, ua?: string): number;
  getCrawlDelay(ua?: string): number | undefined;
  getSitemaps(): string[];
  getPreferredHost(): string | null;
};
const robotsParser = require("robots-parser") as RobotParser;

export type RobotsAgent = ReturnType<RobotParser>;

export function parseRobots(url: string, contents: string): RobotsAgent {
  return robotsParser(url, contents);
}

export function robotsAllowed(
  robots: RobotsAgent | null | undefined,
  url: string,
  userAgent: string,
): boolean {
  if (!robots) return true;
  const allowed = robots.isAllowed(url, userAgent);
  return allowed !== false;
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
  } = {},
): Promise<RobotsFetchResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout ?? 10_000);
  const fused = fuseSignal(controller.signal, options.signal);
  try {
    const response = await fetchImpl(url, {
      headers: options.userAgent ? { "user-agent": options.userAgent } : {},
      signal: fused.signal,
    });
    if (!response.ok) return { kind: "none" };
    const text = await response.text();
    return { kind: "agent", agent: parseRobots(url, text) };
  } catch {
    return { kind: "failed" };
  } finally {
    clearTimeout(timeout);
    fused.release();
  }
}

export function robotsUrlFor(targetUrl: string): string {
  const parsed = new URL(targetUrl);
  return `${parsed.protocol}//${parsed.host}/robots.txt`;
}
