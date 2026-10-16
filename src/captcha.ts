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
 * interstitial, Turnstile, reCAPTCHA, hCaptcha widgets). Unknown or custom
 * interstitials are not detected — and a 200 page that merely embeds a captcha
 * widget in a form WILL match its marker; scope `solver` per-call if the
 * target site embeds widgets on normal pages.
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
 * the body. Widget types (turnstile/recaptcha/hcaptcha) are detected by markup
 * at any status — per the detection contract, presence of the widget IS the
 * marker.
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
}): CaptchaChallenge | null {
  const { url, status, headers, html } = input;

  const cfMitigated = headers.get("cf-mitigated") === "challenge";
  const cfMarkers = CF_INTERSTITIAL_MARKERS.some((marker) => html.includes(marker));
  if (INTERSTITIAL_STATUSES.has(status) && (cfMitigated || cfMarkers)) {
    return { url, type: "cloudflare-interstitial", sitekey: extractSitekey(html), html };
  }

  for (const { type, markers } of WIDGET_MARKERS) {
    if (markers.some((marker) => html.includes(marker))) {
      return { url, type, sitekey: extractSitekey(html), html };
    }
  }
  return null;
}
