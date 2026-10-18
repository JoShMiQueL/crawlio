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
 * Honesty note: these markers identify KNOWN challenge shapes (Cloudflare's
 * interstitial, Turnstile, reCAPTCHA, hCaptcha widgets, Amazon's "Robot
 * Check" full-page bot check). Unknown or custom interstitials are not
 * detected — and a 200 page that merely embeds a captcha widget in a form
 * WILL match its marker; scope `solver` per-call if the target site embeds
 * widgets on normal pages. Detection is NOT a solvability claim: no
 * built-in solver handles Amazon's bot-check pages — the type exists for
 * honest error/reporting paths.
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
 * the body. `amazon-robot-check` is Amazon's full-page "Robot Check" wall —
 * served at 200, matched on body substrings that only appear on that shape.
 * Page-level checks run before widget markup: a wall that happens to embed
 * a widget-shaped token is still the wall. Widget types
 * (turnstile/recaptcha/hcaptcha) are detected by markup at any status — per
 * the detection contract, presence of the widget IS the marker.
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

  // Full-page bot checks before widget markup — a challenge wall IS the
  // page, so it outranks any widget-shaped token embedded in it.
  if (AMAZON_ROBOT_CHECK_MARKERS.some((marker) => html.includes(marker))) {
    return {
      url,
      type: "amazon-robot-check",
      sitekey: extractSitekey(html),
      html,
      ...context,
    };
  }

  for (const { type, markers } of WIDGET_MARKERS) {
    if (markers.some((marker) => html.includes(marker))) {
      return { url, type, sitekey: extractSitekey(html), html, ...context };
    }
  }
  return null;
}
