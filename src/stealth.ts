import type { StealthOptions } from "./types.js";

/**
 * Stealth: HTTP-layer browser mimicry, opt-in only.
 *
 * What lives here is deliberately limited to what fetch CAN honestly imitate:
 * - a complete, internally consistent request-header set per browser family
 *   (a Chrome UA without matching client hints is itself a tell);
 * - a minimal per-origin cookie jar;
 * - a referer chain across same-origin navigations (state held by the caller).
 *
 * What it cannot do — and does not pretend to: TLS/JA3 and HTTP/2 fingerprints
 * are properties of the transport (Node's undici), not the headers. To mimic
 * those, inject an impersonating transport via `fetch`.
 */

/** The `stealth` option with every field resolved. `null` = stealth off. */
export interface ResolvedStealth {
  /** Browser family to mimic. */
  browser: "chrome" | "firefox" | "safari";
  /** Locale for `Accept-Language`. */
  locale: string;
  /** Persist and resend cookies per origin. */
  cookies: boolean;
  /** Send `Referer` of the previous same-origin page. */
  refererChain: boolean;
}

/**
 * Normalize a `boolean | StealthOptions | undefined` option.
 *
 * `undefined`/`false` → `null` (the honest default path is untouched).
 * `true` → a modern desktop Chrome profile with cookies and referer chaining.
 */
export function resolveStealth(
  stealth: boolean | StealthOptions | undefined,
): ResolvedStealth | null {
  if (stealth === undefined || stealth === false) return null;
  const opts = stealth === true ? {} : stealth;
  return {
    browser: opts.browser ?? "chrome",
    locale: opts.locale ?? "en-US",
    cookies: opts.cookies ?? true,
    refererChain: opts.refererChain ?? true,
  };
}

/**
 * Static header profiles for a top-level document GET, desktop flavours.
 *
 * Snapshots: Chrome 131 / Firefox 133 / Safari 18 era — the exact version
 * matters less than INTERNAL CONSISTENCY: UA brand, `sec-ch-ua` brand+platform,
 * and `sec-fetch-*` metadata must all tell the same story. Only Chrome sends
 * client hints; Firefox and Safari do not, so their profiles omit them.
 * `priority` is a Chromium-only behavior (Firefox does not emit it), and
 * Safari sends NO Fetch Metadata headers at all — its profile omits the whole
 * `sec-fetch-*` family, which the referer-chaining layer respects too.
 *
 * `accept-encoding` is deliberately ABSENT from every profile: undici sets it
 * itself (`gzip, deflate, br`) and overriding it would desync from transparent
 * response decompression. Header ORDER is likewise owned by the transport — a
 * plain fetch cannot control it; documented, not fixed.
 */
const BROWSER_HEADERS: Record<ResolvedStealth["browser"], Record<string, string>> = {
  chrome: {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
    priority: "u=0, i",
  },
  firefox: {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/png,image/svg+xml,*/*;q=0.8",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
  },
  safari: {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  },
};

/**
 * `Accept-Language` for a locale, phrased the way each family phrases it:
 * `en-US,en;q=0.9` for Chrome/Safari, `q=0.5` for Firefox. A locale without a
 * region (`"en"`) is sent as-is.
 */
function acceptLanguageFor(browser: ResolvedStealth["browser"], locale: string): string {
  const q = browser === "firefox" ? "0.5" : "0.9";
  const base = locale.split("-")[0];
  return base !== undefined && base !== locale ? `${locale},${base};q=${q}` : locale;
}

/**
 * The request headers a real `browser` sends for a typed-URL document GET —
 * minus `accept-encoding` (owned by the transport; see {@link BROWSER_HEADERS}).
 * Layer caller headers over these; an explicit header always wins.
 */
export function stealthRequestHeaders(stealth: ResolvedStealth): Record<string, string> {
  return {
    ...BROWSER_HEADERS[stealth.browser],
    "accept-language": acceptLanguageFor(stealth.browser, stealth.locale),
  };
}

/**
 * Find the key in `headers` that holds `name`, case-insensitively (the plain
 * `Record` header bag does no normalization). `undefined` when absent.
 */
export function headerKey(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  return Object.keys(headers).find((key) => key.toLowerCase() === lower);
}

/**
 * Read the `Set-Cookie` headers off a response.
 *
 * `Headers.getSetCookie()` is the correct API (present in undici/Node 22); a
 * joined `set-cookie` string is the fallback — split on a comma followed by a
 * `name=` token so `Expires=Wed, 21 Oct ...` dates are not split mid-value.
 */
export function setCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (headers as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === "function") return getSetCookie.call(headers);
  const joined = headers.get("set-cookie");
  return joined === null ? [] : joined.split(/,(?=\s*[^\s;,=]+=)/u);
}

interface StoredCookie {
  /** Cookie name. */
  name: string;
  /** Cookie value (verbatim — not decoded). */
  value: string;
  /** Epoch ms at which the cookie expires; `null` = session cookie. */
  expiresAt: number | null;
  /** `Secure` attribute — only sent to https URLs. */
  secure: boolean;
}

/**
 * A minimal, per-origin cookie jar — the stateful half of stealth.
 *
 * Deliberately small (RFC 6265 basics only): `Expires`/`Max-Age` are honored
 * with lazy eviction on read, and `Secure` cookies are https-only. `Domain`
 * subdomain scoping and `Path` are NOT modeled — a cookie belongs to an origin
 * and is sent to every path on it. `HttpOnly`/`SameSite` are parsed-and-ignored:
 * they constrain browsers, not clients that chose to store the cookie.
 *
 * Lifecycle: one jar per `createScraper` instance — including the process-wide
 * default scraper, so module-level `scrape()`/`fetchHtml()` calls DO share a
 * jar across calls to the same origin.
 */
export class CookieJar {
  private readonly origins = new Map<string, Map<string, StoredCookie>>();

  /**
   * Record a response's `Set-Cookie` headers for `origin`. An already-expired
   * cookie (`Max-Age=0`, past `Expires`) deletes the stored entry, per RFC.
   */
  storeResponseCookies(origin: string, setCookies: readonly string[]): void {
    for (const raw of setCookies) {
      const cookie = CookieJar.parse(raw);
      if (cookie === null) continue;
      if (cookie.expiresAt !== null && cookie.expiresAt <= Date.now()) {
        this.origins.get(origin)?.delete(cookie.name);
        continue;
      }
      let jar = this.origins.get(origin);
      if (jar === undefined) {
        jar = new Map();
        this.origins.set(origin, jar);
      }
      jar.set(cookie.name, cookie);
    }
  }

  /**
   * Store `name=value` for `origin` as a session cookie — used to inject
   * solver-provided cookies (e.g. `cf_clearance`) into the jar.
   */
  set(origin: string, name: string, value: string): void {
    let jar = this.origins.get(origin);
    if (jar === undefined) {
      jar = new Map();
      this.origins.set(origin, jar);
    }
    jar.set(name, { name, value, expiresAt: null, secure: false });
  }

  /**
   * The `Cookie` header value for `url` — every live cookie stored for the
   * URL's origin — or `undefined` when there is nothing to send. Expired
   * entries are evicted here (lazily — no timers, no sweeping).
   */
  cookieHeaderFor(url: URL): string | undefined {
    const jar = this.origins.get(url.origin);
    if (jar === undefined) return undefined;
    const now = Date.now();
    const pairs: string[] = [];
    for (const [name, cookie] of jar) {
      if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
        jar.delete(name);
        continue;
      }
      if (cookie.secure && url.protocol !== "https:") continue;
      pairs.push(`${cookie.name}=${cookie.value}`);
    }
    if (jar.size === 0) this.origins.delete(url.origin);
    return pairs.length === 0 ? undefined : pairs.join("; ");
  }

  /**
   * Parse one `Set-Cookie` header down to what the jar keeps: the `name=value`
   * pair plus `Expires`/`Max-Age`/`Secure`. Everything else (`Domain`, `Path`,
   * `HttpOnly`, `SameSite`, extensions) is ignored by design.
   */
  private static parse(raw: string): StoredCookie | null {
    const segments = raw.split(";");
    const pair = segments[0];
    if (pair === undefined) return null;
    const eq = pair.indexOf("=");
    if (eq <= 0) return null;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name === "") return null;
    let maxAgeAt: number | null = null;
    let expiresDate: number | null = null;
    let secure = false;
    for (const segment of segments.slice(1)) {
      const attrEq = segment.indexOf("=");
      const attrName = (attrEq === -1 ? segment : segment.slice(0, attrEq)).trim().toLowerCase();
      const attrValue = attrEq === -1 ? "" : segment.slice(attrEq + 1).trim();
      if (attrName === "secure") {
        secure = true;
      } else if (attrName === "max-age") {
        // RFC 6265 §5.2.2: a value that is not all digits (optionally a
        // leading "-") is an ignored attribute — Expires may still apply.
        if (/^-?\d+$/u.test(attrValue)) {
          maxAgeAt = Date.now() + Number.parseInt(attrValue, 10) * 1000;
        }
      } else if (attrName === "expires") {
        const when = Date.parse(attrValue);
        if (!Number.isNaN(when)) expiresDate = when;
      }
    }
    // RFC 6265: a valid Max-Age wins over Expires regardless of the order the
    // attributes appeared in.
    const expiresAt = maxAgeAt ?? expiresDate;
    return { name, value, expiresAt, secure };
  }
}
