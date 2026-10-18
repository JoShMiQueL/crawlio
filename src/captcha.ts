import { extract } from "./extract.js";
import { parseHtml } from "./parse.js";
import type { CaptchaChallenge } from "./types.js";

/**
 * CAPTCHA/challenge-page detection — marker matching only, no solving.
 *
 * This runs AFTER a response, only when the caller configured a `solver`.
 * Detection is cheap-string-first: the HTML is parsed with the SDK's own
 * {@link parseHtml}/{@link extract} (dogfooding) only when a marker matched and
 * a `sitekey` is worth extracting.
 *
 * Two detection tiers:
 *
 * 1. **Vendor signatures** — substrings unique to a known challenge shape:
 *    Cloudflare's interstitial, Turnstile/reCAPTCHA/hCaptcha widgets, and
 *    the full-page bot-walls (Amazon's "Robot Check", PerimeterX, DataDome,
 *    Akamai Bot Manager, Incapsula). A hit is a positive identification.
 * 2. **Generic tier** — `generic-bot-check` for the long tail of unbranded
 *    walls. Conservative by design: it fires only when a challenge-shaped
 *    artifact AND a too-thin-to-be-content page agree, and only after every
 *    signature above missed. It means "signals consistent with a bot check"
 *    — reporting evidence, not a named wall.
 *
 * Honesty note: a 200 page that merely embeds a captcha widget in a form
 * WILL match its marker; scope `solver` per-call if the target site embeds
 * widgets on normal pages. Detection is NOT a solvability claim: no
 * built-in solver handles the wall types — they exist for honest
 * error/reporting paths.
 */

/** Statuses Cloudflare-style interstitials are served with. */
const INTERSTITIAL_STATUSES = new Set([403, 503]);

/** Substrings that only ever appear on Cloudflare challenge-platform pages. */
const CF_INTERSTITIAL_MARKERS = ["window._cf_chl_opt", "/cdn-cgi/challenge-platform/", "cf-chl-"];

/** Marker substrings per widget type, checked against the raw HTML. */
const WIDGET_MARKERS: ReadonlyArray<{
  type: CaptchaChallenge["type"];
  markers: readonly string[];
}> = [
  { type: "turnstile", markers: ["cf-turnstile", "challenges.cloudflare.com/turnstile"] },
  { type: "recaptcha", markers: ["g-recaptcha", "www.google.com/recaptcha", "recaptcha.net"] },
  { type: "hcaptcha", markers: ["h-captcha", "hcaptcha.com"] },
];

/**
 * Amazon's "Robot Check" — a third shape: a full-page bot check that is
 * neither an interstitial challenge platform nor an embeddable widget. It
 * is served at status 200, so only the body markers identify it.
 *
 * Each substring must ONLY ever appear on that shape — a bare "captcha"
 * would fire on any normal page mentioning widgets (and widgets already
 * have their own markers above).
 *
 * Detection ≠ solvability: no built-in solver claims Amazon pages; this
 * exists so error/reporting paths can name the wall honestly.
 */
const AMAZON_ROBOT_CHECK_MARKERS = [
  // <title>/h1 text on the wall.
  "Robot Check",
  // The challenge form posts to /errors/validateCaptcha.
  "validateCaptcha",
  // The other copy variant of the same bot page.
  "Sorry, we just need to make sure you're not a robot",
];

/**
 * Full-page vendor bot-walls — same shape as Amazon's: the wall IS the
 * page, served in place of content (at 200 or 4xx), so it outranks any
 * widget-shaped token embedded in it. One row per vendor.
 *
 * Marker bar — vendor-UNIQUE substrings only: every entry must appear
 * exclusively on that vendor's wall. Markers that also ride on NORMAL
 * pages behind the product are rejected: Incapsula's `/_Incapsula_Resource`
 * snippet path, Akamai's `/akam/` sensor URL and DataDome's
 * `js.datadome.co/tags.js` tag are injected into every protected page, so
 * they would brand each of those pages a wall.
 *
 * Detection ≠ solvability: no built-in solver claims these pages; the
 * types exist so ban-signal and reporting paths can name the wall honestly.
 */
const WALL_MARKERS: ReadonlyArray<{
  type: CaptchaChallenge["type"];
  markers: readonly string[];
}> = [
  { type: "amazon-robot-check", markers: AMAZON_ROBOT_CHECK_MARKERS },
  {
    // PerimeterX (HUMAN): the wall loads its captcha script from the
    // captcha.* CDN subdomain — normal pages pull client.*/collector-*
    // hosts only — and renders it into a `px-captcha` div driven by
    // `window._pxCaptcha`.
    type: "perimeterx",
    markers: ["captcha.px-cdn.net", "_pxCaptcha", "px-captcha"],
  },
  {
    // DataDome: the block page iframes the challenge from the
    // captcha-delivery.com host; dd.datadome.co is its check endpoint.
    // The tags.js URL above is deliberately excluded (normal pages).
    type: "datadome",
    markers: ["captcha-delivery.com", "dd.datadome.co"],
  },
  {
    // Akamai Bot Manager: the wall's inline JS writes the `bm_sz`/`_abck`
    // cookies from markup — on normal pages they arrive via Set-Cookie
    // headers — and deny pages pull assets from errors.edgesuite.net.
    type: "akamai",
    markers: ["_abck", "bm_sz", "errors.edgesuite.net"],
  },
  {
    // Incapsula (Imperva): the block page names its incident ID and sets
    // the incap_ses/visid_incap cookies from markup.
    type: "incapsula",
    markers: ["Incapsula incident ID", "incap_ses", "visid_incap"],
  },
];

/**
 * Challenge types that ARE the page — a full-page wall served in place of
 * content, as opposed to a widget embedded IN content. Used by the scraper
 * as the page-block set: a detected wall at any status is burned egress,
 * not a served page.
 */
export const PAGE_BLOCK_TYPES: ReadonlySet<CaptchaChallenge["type"]> = new Set([
  "cloudflare-interstitial",
  "amazon-robot-check",
  "perimeterx",
  "datadome",
  "akamai",
  "incapsula",
  "generic-bot-check",
]);

/**
 * Generic tier — signal A, the markup half: a form/script/iframe pointing
 * at captcha/challenge/verify machinery. Attribute-prefixed (` action=`,
 * ` src=`, ` formaction=`) so `data-*` attributes and prose are ignored;
 * case-insensitive (`validateCaptcha` counts).
 */
const GENERIC_ARTIFACT_RE =
  /\s(?:action|src|formaction)\s*=\s*["']?[^\s>"']*(?:captcha|challenge|verify)/i;

/**
 * Generic tier — signal A, the copy half: phrases that only make sense on
 * a bot-check page, matched against stripped VISIBLE text (lowercased) —
 * a script bundle merely containing the word is not evidence.
 */
const GENERIC_COPY_MARKERS = [
  "are you a robot",
  "verify you are human",
  "verify you're not a robot",
  "verify you are not a robot",
  "human verification",
  "security check",
  "just a moment",
];

/**
 * Generic tier — signal B: the page is too thin to be content. A wall is
 * nearly all markup; a real page carries real copy. 300 chars of visible
 * text is the floor below which "content" stops being plausible.
 */
const GENERIC_MAX_VISIBLE_TEXT_CHARS = 300;

/**
 * Cheap raw-HTML precheck for the copy half of signal A — a superset of the
 * real check (raw markup includes scripts/comments the stripped text drops).
 * It only exists to skip {@link stripVisibleText} on pages that cannot
 * possibly match: detection runs on every response while a solver or proxy
 * pool is configured, and a normal page should not pay for five regex
 * passes. Phrases are joined verbatim — keep them regex-literal-safe.
 */
const GENERIC_COPY_PRECHECK_RE = new RegExp(GENERIC_COPY_MARKERS.join("|"), "i");

/**
 * Rough visible-text estimate: drop script/style/noscript blocks, comments
 * and tags, collapse whitespace. Good enough for the generic tier's only
 * question — "real copy, or an interstitial skeleton?" — and cheaper than
 * a DOM walk on every inspected response.
 */
function stripVisibleText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extract the first `data-sitekey` in the document — via the SDK's own extract(). */
function extractSitekey(html: string): string | undefined {
  try {
    const { sitekey } = extract(parseHtml(html), {
      sitekey: { selector: "[data-sitekey]", attr: "data-sitekey" },
    });
    return sitekey;
  } catch {
    return undefined;
  }
}

/**
 * Detect a challenge page in a completed response.
 *
 * @returns A {@link CaptchaChallenge} when markers match, else `null`.
 *
 * `cloudflare-interstitial` is detected on 403/503 responses carrying the
 * `cf-mitigated: challenge` header or Cloudflare challenge-platform tokens in
 * the body. The full-page bot-walls (`amazon-robot-check`, `perimeterx`,
 * `datadome`, `akamai`, `incapsula`) match on body substrings unique to each
 * vendor's wall, at any status — a wall IS the page, so it outranks widget
 * markup embedded in it. Widget types (turnstile/recaptcha/hcaptcha) are
 * detected by markup at any status — per the detection contract, presence of
 * the widget IS the marker.
 *
 * `generic-bot-check` runs LAST, only when no signature matched, and only
 * when both generic signals agree: a challenge-shaped artifact (markup
 * token or wall copy) AND a page too thin to be real content. It is a
 * lower-confidence detection — "signals consistent with a bot check" —
 * meant for reporting, not a positive identification.
 */
export function detectChallenge(input: {
  /** Final response URL (scrubbed). */
  url: string;
  /** HTTP status of the response. */
  status: number;
  /** Response headers. */
  headers: Headers;
  /** Decoded response body. */
  html: string;
  /** The egress proxy the failed request used, when it went through a pool. */
  proxyUrl?: string;
  /** The User-Agent the failed request carried. */
  userAgent?: string;
}): CaptchaChallenge | null {
  const { url, status, headers, html, proxyUrl, userAgent } = input;
  const context = {
    ...(proxyUrl === undefined ? {} : { proxyUrl }),
    ...(userAgent === undefined ? {} : { userAgent }),
  };

  const cfMitigated = headers.get("cf-mitigated") === "challenge";
  const cfMarkers = CF_INTERSTITIAL_MARKERS.some((marker) => html.includes(marker));
  if (INTERSTITIAL_STATUSES.has(status) && (cfMitigated || cfMarkers)) {
    return {
      url,
      type: "cloudflare-interstitial",
      sitekey: extractSitekey(html),
      html,
      ...context,
    };
  }

  // Full-page bot-walls before widget markup — a challenge wall IS the
  // page, so it outranks any widget-shaped token embedded in it.
  for (const { type, markers } of WALL_MARKERS) {
    if (markers.some((marker) => html.includes(marker))) {
      return { url, type, sitekey: extractSitekey(html), html, ...context };
    }
  }

  for (const { type, markers } of WIDGET_MARKERS) {
    if (markers.some((marker) => html.includes(marker))) {
      return { url, type, sitekey: extractSitekey(html), html, ...context };
    }
  }

  // Generic tier — last resort. Both signals must agree: challenge-shaped
  // markup/copy AND a page too thin to be real content. Either alone is
  // noise — a docs page can SAY "captcha" all it wants, and a sparse SPA
  // shell can be nearly empty without being a wall. The text strip runs
  // only when a signal could possibly hold — normal pages exit cheaply.
  const hasArtifact = GENERIC_ARTIFACT_RE.test(html);
  if (!hasArtifact && !GENERIC_COPY_PRECHECK_RE.test(html)) return null;
  const visibleText = stripVisibleText(html);
  if (visibleText.length >= GENERIC_MAX_VISIBLE_TEXT_CHARS) return null;
  const lowerText = visibleText.toLowerCase();
  if (hasArtifact || GENERIC_COPY_MARKERS.some((phrase) => lowerText.includes(phrase))) {
    return {
      url,
      type: "generic-bot-check",
      sitekey: extractSitekey(html),
      html,
      ...context,
    };
  }
  return null;
}
