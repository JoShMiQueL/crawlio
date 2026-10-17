/**
 * Internal robots.txt parser — RFC 9309 plus Google's matching extensions
 * (`*` wildcard, `$` end-anchor, longest-match / allow-wins-tie precedence).
 * Pure: no I/O, no runtime-specific APIs.
 *
 * Observable semantics follow Google's robots.txt spec
 * (https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt):
 * a group applies when its product token is a case-insensitive SUBSTRING of the
 * crawler's user-agent (version suffix ignored); among matching groups the
 * longest token wins and equal-length tokens merge their rules.
 */

/** A parsed robots.txt policy for one origin. */
export interface RobotsAgent {
  /**
   * Whether `url` may be fetched by `userAgent`. Returns `true` when the
   * question is undecidable — an unparseable URL or a URL on a different
   * origin than the robots.txt — so ambiguity never silently blocks.
   */
  isAllowed(url: string, userAgent?: string): boolean;
  /** The group's `Crawl-delay` in seconds, if declared. */
  getCrawlDelay(userAgent?: string): number | undefined;
  /** Every `Sitemap:` value found in the file, in file order. */
  getSitemaps(): string[];
}

interface Rule {
  pattern: string;
  allow: boolean;
}

/** The rule set and crawl-delay shared by one user-agent token. */
interface Group {
  rules: Rule[];
  crawlDelay?: number;
}

interface Parsed {
  /** Origin of the robots.txt file itself; undefined when unparseable. */
  base: { protocol: string; hostname: string; port: string } | undefined;
  /** UA token to group, in first-seen file order. */
  groups: Map<string, Group>;
  sitemaps: string[];
}

// Dummy base so relative URLs parse; only consistency between the robots.txt
// URL and the probed URL matters, never reachability.
const RELATIVE_BASE = "http://robots-relative.invalid/";

function parseUrl(url: string): URL | undefined {
  try {
    const parsed = new URL(url, RELATIVE_BASE);
    if (!parsed.port) parsed.port = parsed.protocol === "https:" ? "443" : "80";
    return parsed;
  } catch {
    return undefined;
  }
}

/** Normalise a UA token: lowercase, drop any `/version` suffix, trim. */
function formatUserAgent(userAgent: string): string {
  const lower = userAgent.toLowerCase();
  const slash = lower.indexOf("/");
  return (slash > -1 ? lower.slice(0, slash) : lower).trim();
}

/** Uppercase the hex digits of every valid %-escape (`%2f` becomes `%2F`). */
function escapesToUpper(path: string): string {
  return path.replace(/%[0-9a-fA-F]{2}/g, (m) => m.toUpperCase());
}

/**
 * Normalise a rule pattern to the encoding a URL pathname will carry:
 * percent-encode non-ASCII/unsafe chars, restore pre-existing escapes
 * (`%25` back to `%`), uppercase escape hex. Patterns that `encodeURI`
 * rejects (lone surrogates) are kept raw — they can only match literally.
 */
function normalisePattern(pattern: string): string {
  try {
    return escapesToUpper(encodeURI(pattern).replace(/%25/g, "%"));
  } catch {
    return pattern;
  }
}

/**
 * Google pattern matcher (ported from google/robotstxt robots.cc):
 * `*` matches any sequence including empty; `$` at the very end anchors the
 * match to the full path. Tracks every candidate match length in the path.
 */
function matchesPattern(pattern: string, path: string): boolean {
  const lengths = new Array<number>(path.length + 1);
  let count = 1;
  lengths[0] = 0;
  for (let p = 0; p < pattern.length; p++) {
    const ch = pattern[p];
    if (ch === "$" && p === pattern.length - 1) {
      return lengths[count - 1] === path.length;
    }
    if (ch === "*") {
      // `*` widens: every length from the current minimum to path end matches.
      count = path.length - (lengths[0] as number) + 1;
      for (let i = 1; i < count; i++) {
        lengths[i] = (lengths[i - 1] as number) + 1;
      }
    } else {
      let kept = 0;
      for (let i = 0; i < count; i++) {
        const len = lengths[i] as number;
        if (len < path.length && path[len] === ch) {
          lengths[kept] = len + 1;
          kept += 1;
        }
      }
      if (kept === 0) return false;
      count = kept;
    }
  }
  return true;
}

/** Longest matching pattern wins; an allow beats a disallow of equal length. */
function findRule(path: string, rules: Rule[]): Rule | undefined {
  let matched: Rule | undefined;
  for (const rule of rules) {
    if (!matchesPattern(rule.pattern, path)) continue;
    if (!matched || rule.pattern.length > matched.pattern.length) {
      matched = rule;
    } else if (rule.pattern.length === matched.pattern.length && rule.allow && !matched.allow) {
      matched = rule;
    }
  }
  return matched;
}

function parseContents(contents: string): Pick<Parsed, "groups" | "sitemaps"> {
  const groups = new Map<string, Group>();
  const sitemaps: string[] = [];
  // Tokens of the current UA run. Any rule-ish line materialises a group for
  // its tokens — even with an empty/invalid value — so the group counts for
  // UA selection (a rule-less group is allow-all, not a `*` fallback).
  let tokens: string[] = [];
  let inUserAgentRun = false;

  const materialise = (): Group[] => {
    const out: Group[] = [];
    for (const token of tokens) {
      let group = groups.get(token);
      if (!group) {
        group = { rules: [] };
        groups.set(token, group);
      }
      out.push(group);
    }
    return out;
  };

  for (const raw of contents.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/)) {
    // Comments run to end-of-line; fields split at the first colon.
    const hash = raw.indexOf("#");
    const line = (hash > -1 ? raw.slice(0, hash) : raw).trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    switch (field) {
      case "user-agent":
        // A UA line after a non-UA record starts a new group; blank or
        // malformed lines do not break a run of consecutive UA lines.
        if (!inUserAgentRun) tokens = [];
        inUserAgentRun = true;
        if (value) tokens.push(formatUserAgent(value));
        continue;
      case "disallow":
      case "allow":
        for (const group of materialise()) {
          if (value) {
            group.rules.push({ pattern: normalisePattern(value), allow: field === "allow" });
          }
        }
        break;
      case "crawl-delay": {
        const delay = Number(value);
        for (const group of materialise()) {
          if (!Number.isNaN(delay)) group.crawlDelay = delay;
        }
        break;
      }
      case "sitemap":
        if (value) sitemaps.push(value);
        break;
    }
    inUserAgentRun = false;
  }
  return { groups, sitemaps };
}

/**
 * The groups whose UA token matches `userAgent`: `*` always matches, a named
 * token matches as a substring of the (normalised) UA. Longest token wins;
 * equal-length winners merge. Undefined when nothing matches.
 */
function selectGroups(parsed: Parsed, userAgent: string | undefined): Group[] | undefined {
  const ua = formatUserAgent(userAgent ?? "*");
  let best: Group[] = [];
  let bestLength = -1;
  for (const [token, group] of parsed.groups) {
    // `*` is the least-specific match; named tokens must be substrings.
    // An empty token (e.g. `User-agent: /`) never matches.
    const length = token === "*" ? 0 : token.length;
    if (token !== "*" && (token === "" || !ua.includes(token))) continue;
    if (length > bestLength) {
      bestLength = length;
      best = [group];
    } else if (length === bestLength) {
      best.push(group);
    }
  }
  return best.length > 0 ? best : undefined;
}

/**
 * Parse robots.txt `contents` (as fetched from `url`) into a policy object.
 * Pure — performs no I/O.
 */
export function parse(url: string, contents: string): RobotsAgent {
  const parsed: Parsed = { base: parseUrl(url), ...parseContents(contents || "") };

  return {
    isAllowed(target: string, userAgent?: string): boolean {
      const targetUrl = parseUrl(target);
      // Undecidable (bad URL, or a different origin than this robots.txt)
      // answers true: an ambiguous policy must not silently block.
      if (
        !targetUrl ||
        !parsed.base ||
        targetUrl.protocol !== parsed.base.protocol ||
        targetUrl.hostname !== parsed.base.hostname ||
        targetUrl.port !== parsed.base.port
      ) {
        return true;
      }
      const groups = selectGroups(parsed, userAgent);
      if (!groups) return true;
      const path = escapesToUpper(targetUrl.pathname + targetUrl.search);
      let rule: Rule | undefined;
      for (const group of groups) {
        const found = findRule(path, group.rules);
        if (!found) continue;
        if (!rule || found.pattern.length > rule.pattern.length) {
          rule = found;
        } else if (found.pattern.length === rule.pattern.length && found.allow && !rule.allow) {
          rule = found;
        }
      }
      return !rule || rule.allow;
    },
    getCrawlDelay(userAgent?: string): number | undefined {
      const groups = selectGroups(parsed, userAgent);
      if (!groups) return undefined;
      // Merged groups keep the largest declared delay — the polite answer.
      let delay: number | undefined;
      for (const group of groups) {
        if (group.crawlDelay !== undefined && (delay === undefined || group.crawlDelay > delay)) {
          delay = group.crawlDelay;
        }
      }
      return delay;
    },
    getSitemaps(): string[] {
      return parsed.sitemaps.slice();
    },
  };
}
