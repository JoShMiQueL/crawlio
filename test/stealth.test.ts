import { describe, expect, it, vi } from "vitest";
import { detectChallenge } from "../src/captcha.js";
import {
  type CaptchaChallenge,
  type CaptchaSolver,
  ConfigError,
  createScraper,
  fetchHtml,
  HttpError,
} from "../src/index.js";

type FetchImpl = typeof globalThis.fetch;

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" };

/** A fetch mock that records (url, headers) and serves canned responses. */
function recordingFetch(handler: (call: number, url: string) => Response | Promise<Response>) {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const impl: FetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    return handler(calls.length, url);
  }) as FetchImpl;
  return { impl, calls };
}

const okHtml = (body = "<html><h1>ok</h1></html>") =>
  new Response(body, { status: 200, headers: HTML_HEADERS });

describe("stealth headers", () => {
  it("keeps the honest UA and minimal headers when stealth is off", async () => {
    const { impl, calls } = recordingFetch(() => okHtml());
    await fetchHtml("https://example.com/", { fetch: impl, robots: false });
    const h = calls[0]?.headers;
    expect(h?.get("user-agent")).toContain("crawlio/");
    expect(h?.get("sec-ch-ua")).toBeNull();
    expect(h?.get("sec-fetch-dest")).toBeNull();
    expect(h?.get("accept-language")).toBeNull();
  });

  it("stealth: true sends a complete, brand-consistent Chrome profile", async () => {
    const { impl, calls } = recordingFetch(() => okHtml());
    await fetchHtml("https://example.com/", { fetch: impl, robots: false, stealth: true });
    const h = calls[0]?.headers;
    // One coherent Chrome 131 desktop story: UA brand matches the client hints.
    expect(h?.get("user-agent")).toContain("Chrome/131.0.0.0");
    expect(h?.get("sec-ch-ua")).toBe(
      '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    );
    expect(h?.get("sec-ch-ua-mobile")).toBe("?0");
    expect(h?.get("sec-ch-ua-platform")).toBe('"Windows"');
    expect(h?.get("sec-fetch-dest")).toBe("document");
    expect(h?.get("sec-fetch-mode")).toBe("navigate");
    expect(h?.get("sec-fetch-site")).toBe("none");
    expect(h?.get("sec-fetch-user")).toBe("?1");
    expect(h?.get("upgrade-insecure-requests")).toBe("1");
    expect(h?.get("accept-language")).toBe("en-US,en;q=0.9");
    expect(h?.get("accept")).toContain("text/html");
  });

  it("firefox profile omits client hints, matching the real browser", async () => {
    const { impl, calls } = recordingFetch(() => okHtml());
    await fetchHtml("https://example.com/", {
      fetch: impl,
      robots: false,
      stealth: { browser: "firefox", locale: "de-DE" },
    });
    const h = calls[0]?.headers;
    expect(h?.get("user-agent")).toContain("Firefox/133.0");
    // Real Firefox sends no sec-ch-ua hints — consistency is the point.
    expect(h?.get("sec-ch-ua")).toBeNull();
    expect(h?.get("sec-ch-ua-platform")).toBeNull();
    expect(h?.get("accept-language")).toBe("de-DE,de;q=0.5");
    expect(h?.get("sec-fetch-dest")).toBe("document");
    // Priority is Chromium-only — Firefox does not emit it.
    expect(h?.get("priority")).toBeNull();
  });

  it("safari profile sends no Fetch Metadata headers", async () => {
    const { impl, calls } = recordingFetch(() => okHtml());
    await fetchHtml("https://example.com/", {
      fetch: impl,
      robots: false,
      stealth: { browser: "safari" },
    });
    const h = calls[0]?.headers;
    expect(h?.get("user-agent")).toContain("Version/18.2 Safari/605.1.15");
    // Real Safari sends NO sec-fetch-* family — sending them is a tell.
    expect(h?.get("sec-fetch-dest")).toBeNull();
    expect(h?.get("sec-fetch-mode")).toBeNull();
    expect(h?.get("sec-fetch-site")).toBeNull();
    expect(h?.get("sec-ch-ua")).toBeNull();
    expect(h?.get("priority")).toBeNull();
    expect(h?.get("accept-language")).toBe("en-US,en;q=0.9");
  });

  it("per-call stealth: false beats an instance-level stealth: true", async () => {
    const { impl, calls } = recordingFetch(() => okHtml());
    const scraper = createScraper({ fetch: impl, robots: false, stealth: true });
    await scraper.fetchHtml("https://example.com/", { stealth: false });
    expect(calls[0]?.headers.get("user-agent")).toContain("crawlio/");
    expect(calls[0]?.headers.get("sec-ch-ua")).toBeNull();
  });

  it("an explicit userAgent still wins over the profile UA", async () => {
    const { impl, calls } = recordingFetch(() => okHtml());
    await fetchHtml("https://example.com/", {
      fetch: impl,
      robots: false,
      stealth: true,
      userAgent: "Custom/9.9",
    });
    expect(calls[0]?.headers.get("user-agent")).toBe("Custom/9.9");
    // The rest of the profile stays — the mixed story is the caller's choice.
    expect(calls[0]?.headers.get("sec-ch-ua")).not.toBeNull();
  });

  it("a caller-set header displaces the profile's value case-insensitively", async () => {
    const { impl, calls } = recordingFetch(() => okHtml());
    await fetchHtml("https://example.com/", {
      fetch: impl,
      robots: false,
      stealth: true,
      // Different casing than the profile key: a plain spread would send BOTH
      // `accept-language` and `Accept-Language` — a duplicated tell.
      headers: { "Accept-Language": "fr-FR", "x-custom": "1" },
    });
    const h = calls[0]?.headers;
    // Headers.get() would join duplicates — an exact match proves only one
    // value went on the wire.
    expect(h?.get("accept-language")).toBe("fr-FR");
    expect(h?.get("x-custom")).toBe("1");
  });

  it("displaces base headers case-insensitively on the honest path too", async () => {
    // No stealth: the caller's `Accept` must displace the honest `accept`
    // default — same overlayHeaders path, same duplicate tell otherwise.
    const { impl, calls } = recordingFetch(() => okHtml());
    await fetchHtml("https://example.com/", {
      fetch: impl,
      robots: false,
      headers: { Accept: "application/json" },
    });
    expect(calls[0]?.headers.get("accept")).toBe("application/json");
  });
});

describe("stealth cookie jar", () => {
  const withCookies = (setCookies: string[]) => {
    const headers = new Headers(HTML_HEADERS);
    for (const c of setCookies) headers.append("set-cookie", c);
    return new Response("<html></html>", { status: 200, headers });
  };

  it("stores Set-Cookie and resends it on the next same-origin request", async () => {
    const { impl, calls } = recordingFetch((n) =>
      n === 1 ? withCookies(["session=abc; Path=/; HttpOnly"]) : okHtml(),
    );
    const scraper = createScraper({ fetch: impl, robots: false, stealth: true });
    await scraper.fetchHtml("https://example.com/login");
    await scraper.fetchHtml("https://example.com/account");
    expect(calls[0]?.headers.get("cookie")).toBeNull();
    expect(calls[1]?.headers.get("cookie")).toContain("session=abc");
  });

  it("does not send the origin's cookies to a different origin", async () => {
    const { impl, calls } = recordingFetch((_n, url) =>
      url.includes("one.example") ? withCookies(["s=1"]) : okHtml(),
    );
    const scraper = createScraper({ fetch: impl, robots: false, stealth: true });
    await scraper.fetchHtml("https://one.example/");
    await scraper.fetchHtml("https://two.example/");
    expect(calls[1]?.headers.get("cookie")).toBeNull();
  });

  it("merges jar cookies with a caller-provided Cookie header", async () => {
    const { impl, calls } = recordingFetch((n) =>
      n === 1 ? withCookies(["session=abc"]) : okHtml(),
    );
    const scraper = createScraper({ fetch: impl, robots: false, stealth: true });
    await scraper.fetchHtml("https://example.com/a");
    await scraper.fetchHtml("https://example.com/b", { headers: { cookie: "manual=1" } });
    const cookie = calls[1]?.headers.get("cookie");
    expect(cookie).toContain("session=abc");
    expect(cookie).toContain("manual=1");
  });

  it("honors Max-Age over Expires regardless of attribute order (RFC 6265)", async () => {
    const { impl, calls } = recordingFetch((n) =>
      n === 1
        ? withCookies([
            // Max-Age is valid → the past Expires must NOT kill the cookie.
            "live=1; Max-Age=3600; Expires=Wed, 01 Jan 2020 00:00:00 GMT",
            // Inverse order: Max-Age=0 still wins over a future Expires.
            "dead=1; Expires=Wed, 01 Jan 2031 00:00:00 GMT; Max-Age=0",
          ])
        : okHtml(),
    );
    const scraper = createScraper({ fetch: impl, robots: false, stealth: true });
    await scraper.fetchHtml("https://example.com/a");
    await scraper.fetchHtml("https://example.com/b");
    const cookie = calls[1]?.headers.get("cookie");
    expect(cookie).toContain("live=1");
    expect(cookie).not.toContain("dead=1");
  });

  it("falls back to Expires when Max-Age is garbage (RFC 6265)", async () => {
    const { impl, calls } = recordingFetch((n) =>
      n === 1
        ? withCookies(["keep=1; Max-Age=abc; Expires=Wed, 01 Jan 2031 00:00:00 GMT"])
        : okHtml(),
    );
    const scraper = createScraper({ fetch: impl, robots: false, stealth: true });
    await scraper.fetchHtml("https://example.com/a");
    await scraper.fetchHtml("https://example.com/b");
    // "abc" is an invalid Max-Age → the attribute is ignored and the future
    // Expires keeps the cookie alive.
    expect(calls[1]?.headers.get("cookie")).toContain("keep=1");
  });

  it("evicts expired cookies lazily (Max-Age=0 deletes)", async () => {
    const { impl, calls } = recordingFetch((n) =>
      n === 1 ? withCookies(["gone=1", "gone=1; Max-Age=0"]) : okHtml(),
    );
    const scraper = createScraper({ fetch: impl, robots: false, stealth: true });
    await scraper.fetchHtml("https://example.com/a");
    await scraper.fetchHtml("https://example.com/b");
    expect(calls[1]?.headers.get("cookie")).toBeNull();
  });

  it("only sends Secure cookies over https", async () => {
    const { impl, calls } = recordingFetch((n) =>
      n === 1 ? withCookies(["sec=1; Secure"]) : okHtml(),
    );
    const scraper = createScraper({ fetch: impl, robots: false, stealth: true });
    await scraper.fetchHtml("https://example.com/a");
    await scraper.fetchHtml("http://example.com/b");
    await scraper.fetchHtml("https://example.com/c");
    // http://example.com is a different ORIGIN anyway — the https repeat is the
    // assertion that a stored Secure cookie survives and is sent.
    expect(calls[1]?.headers.get("cookie")).toBeNull();
    expect(calls[2]?.headers.get("cookie")).toContain("sec=1");
  });

  it("stealth: { cookies: false } disables the jar", async () => {
    const { impl, calls } = recordingFetch((n) =>
      n === 1 ? withCookies(["session=abc"]) : okHtml(),
    );
    const scraper = createScraper({
      fetch: impl,
      robots: false,
      stealth: { cookies: false },
    });
    await scraper.fetchHtml("https://example.com/a");
    await scraper.fetchHtml("https://example.com/b");
    expect(calls[1]?.headers.get("cookie")).toBeNull();
    // Browser headers still apply — only the jar is off.
    expect(calls[1]?.headers.get("sec-ch-ua")).not.toBeNull();
  });
});

describe("stealth referer chain", () => {
  it("sends no Referer on first visit, then chains same-origin navigations", async () => {
    const { impl, calls } = recordingFetch(() => okHtml());
    const scraper = createScraper({ fetch: impl, robots: false, stealth: true });
    await scraper.fetchHtml("https://example.com/one");
    await scraper.fetchHtml("https://example.com/two");
    expect(calls[0]?.headers.get("referer")).toBeNull();
    expect(calls[0]?.headers.get("sec-fetch-site")).toBe("none");
    expect(calls[1]?.headers.get("referer")).toBe("https://example.com/one");
    expect(calls[1]?.headers.get("sec-fetch-site")).toBe("same-origin");
  });

  it("does not leak a referer across origins", async () => {
    const { impl, calls } = recordingFetch(() => okHtml());
    const scraper = createScraper({ fetch: impl, robots: false, stealth: true });
    await scraper.fetchHtml("https://one.example/");
    await scraper.fetchHtml("https://two.example/");
    expect(calls[1]?.headers.get("referer")).toBeNull();
  });

  it("a caller-set referer always wins over the chain", async () => {
    const { impl, calls } = recordingFetch(() => okHtml());
    const scraper = createScraper({ fetch: impl, robots: false, stealth: true });
    await scraper.fetchHtml("https://example.com/one");
    await scraper.fetchHtml("https://example.com/two", {
      headers: { referer: "https://elsewhere.example/from" },
    });
    expect(calls[1]?.headers.get("referer")).toBe("https://elsewhere.example/from");
  });

  it("chains the referer on safari without inventing Fetch Metadata", async () => {
    const { impl, calls } = recordingFetch(() => okHtml());
    const scraper = createScraper({
      fetch: impl,
      robots: false,
      stealth: { browser: "safari" },
    });
    await scraper.fetchHtml("https://example.com/one");
    await scraper.fetchHtml("https://example.com/two");
    // Safari DOES send Referer on same-origin navigations — but never
    // sec-fetch-site (it sends no Fetch Metadata at all).
    expect(calls[1]?.headers.get("referer")).toBe("https://example.com/one");
    expect(calls[1]?.headers.get("sec-fetch-site")).toBeNull();
  });

  it("stealth: { refererChain: false } sends no referer", async () => {
    const { impl, calls } = recordingFetch(() => okHtml());
    const scraper = createScraper({
      fetch: impl,
      robots: false,
      stealth: { refererChain: false },
    });
    await scraper.fetchHtml("https://example.com/one");
    await scraper.fetchHtml("https://example.com/two");
    expect(calls[1]?.headers.get("referer")).toBeNull();
  });
});

describe("requestDelay range", () => {
  it("samples the delay within [min, max] — deterministic bounds via stubbed RNG", async () => {
    const starts: number[] = [];
    const impl: FetchImpl = (async () => {
      starts.push(Date.now());
      return okHtml();
    }) as FetchImpl;
    const random = vi.spyOn(Math, "random").mockReturnValue(1); // → always max
    try {
      const scraper = createScraper({
        fetch: impl,
        robots: false,
        requestDelay: { min: 30, max: 60 },
      });
      await Promise.all([
        scraper.fetchHtml("https://paced.example/a"),
        scraper.fetchHtml("https://paced.example/b"),
      ]);
    } finally {
      random.mockRestore();
    }
    expect(starts).toHaveLength(2);
    // rng=1 ⇒ sampled delay == max (60ms). Assert ≥ ~70% of it: proves the
    // pacing gap exists without flaking on a busy runner's scheduler jitter.
    expect((starts[1] as number) - (starts[0] as number)).toBeGreaterThanOrEqual(42);
  });

  it("samples the minimum when the RNG returns 0", async () => {
    const starts: number[] = [];
    const impl: FetchImpl = (async () => {
      starts.push(Date.now());
      return okHtml();
    }) as FetchImpl;
    const random = vi.spyOn(Math, "random").mockReturnValue(0); // → always min
    try {
      const scraper = createScraper({
        fetch: impl,
        robots: false,
        requestDelay: { min: 40, max: 500 },
      });
      await Promise.all([
        scraper.fetchHtml("https://paced.example/a"),
        scraper.fetchHtml("https://paced.example/b"),
      ]);
    } finally {
      random.mockRestore();
    }
    const gap = (starts[1] as number) - (starts[0] as number);
    // rng=0 ⇒ sampled delay == min (40ms): ≥ ~70% of it proves pacing, and
    // far-under-max proves the draw rather than the range edge was used.
    expect(gap).toBeGreaterThanOrEqual(28);
    expect(gap).toBeLessThan(200);
  });

  it("rejects malformed ranges with ConfigError", async () => {
    const { impl, calls } = recordingFetch(() => okHtml());
    for (const requestDelay of [
      { min: -1, max: 10 },
      { min: 50, max: 10 },
      { min: Number.NaN, max: 5 },
      { min: 0, max: Number.POSITIVE_INFINITY },
    ]) {
      const err = await fetchHtml("https://example.com/x", {
        fetch: impl,
        requestDelay,
        robots: false,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(ConfigError);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("captcha solver", () => {
  const CF_CHALLENGE_HTML =
    '<html><head><script>window._cf_chl_opt = { cvId: "3" };</script></head><body>challenge</body></html>';

  const cloudflarePage = () =>
    new Response(CF_CHALLENGE_HTML, {
      status: 403,
      headers: { ...HTML_HEADERS, "cf-mitigated": "challenge" },
    });

  it("calls the solver on a Cloudflare interstitial and retries once with its credentials", async () => {
    const { impl, calls } = recordingFetch((n) => (n === 1 ? cloudflarePage() : okHtml()));
    const seen: CaptchaChallenge[] = [];
    const solver: CaptchaSolver = {
      solve: async (challenge) => {
        seen.push(challenge);
        return { cookies: { cf_clearance: "solved-token" }, userAgent: "SolverUA/1.0" };
      },
    };
    const scraper = createScraper({ fetch: impl, robots: false, stealth: true, solver });
    const result = await scraper.fetchHtml("https://example.com/protected");

    expect(result.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe("cloudflare-interstitial");
    expect(seen[0]?.url).toBe("https://example.com/protected");
    expect(seen[0]?.html).toContain("_cf_chl_opt");
    expect(calls).toHaveLength(2);
    // The retry carries the solved clearance AND the UA it is bound to.
    expect(calls[1]?.headers.get("cookie")).toContain("cf_clearance=solved-token");
    expect(calls[1]?.headers.get("user-agent")).toBe("SolverUA/1.0");
  });

  it("persists solver cookies in the jar for later same-origin requests", async () => {
    const { impl, calls } = recordingFetch((n) => (n === 1 ? cloudflarePage() : okHtml()));
    const solver: CaptchaSolver = {
      solve: async () => ({ cookies: { cf_clearance: "solved-token" } }),
    };
    const scraper = createScraper({ fetch: impl, robots: false, stealth: true, solver });
    await scraper.fetchHtml("https://example.com/protected");
    await scraper.fetchHtml("https://example.com/other");
    // Request 3 (later navigation) still carries the clearance via the jar.
    expect(calls[2]?.headers.get("cookie")).toContain("cf_clearance=solved-token");
  });

  it("applies solver cookies on the retry even with stealth fully off", async () => {
    const { impl, calls } = recordingFetch((n) => (n === 1 ? cloudflarePage() : okHtml()));
    const solver: CaptchaSolver = {
      solve: async () => ({ cookies: { cf_clearance: "solved-token" } }),
    };
    const scraper = createScraper({ fetch: impl, robots: false, solver });
    const result = await scraper.fetchHtml("https://example.com/protected");
    expect(result.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers.get("cookie")).toContain("cf_clearance=solved-token");
    // No stealth: honest UA — except where the solver bound its own.
    expect(calls[0]?.headers.get("user-agent")).toContain("crawlio/");
  });

  it("detects a Turnstile widget page and extracts the sitekey", async () => {
    const turnstilePage = () =>
      new Response(
        '<html><body><div class="cf-turnstile" data-sitekey="0x4AAA-test"></div></body></html>',
        { status: 403, headers: HTML_HEADERS },
      );
    const { impl, calls } = recordingFetch((n) => (n === 1 ? turnstilePage() : okHtml()));
    const seen: CaptchaChallenge[] = [];
    const solver: CaptchaSolver = {
      solve: async (challenge) => {
        seen.push(challenge);
        return { token: "turnstile-token" };
      },
    };
    const scraper = createScraper({ fetch: impl, robots: false, stealth: true, solver });
    const result = await scraper.fetchHtml("https://example.com/form");
    expect(result.status).toBe(200);
    expect(seen[0]?.type).toBe("turnstile");
    expect(seen[0]?.sitekey).toBe("0x4AAA-test");
    expect(calls).toHaveLength(2);
  });

  it("detects reCAPTCHA and hCaptcha markup", async () => {
    const pages = {
      recaptcha: '<html><body><div class="g-recaptcha" data-sitekey="gkey"></div></body></html>',
      hcaptcha: '<html><body><div class="h-captcha" data-sitekey="hkey"></div></body></html>',
    } as const;
    for (const [type, html] of Object.entries(pages)) {
      const { impl } = recordingFetch(
        () => new Response(html, { status: 403, headers: HTML_HEADERS }),
      );
      const seen: CaptchaChallenge[] = [];
      const solver: CaptchaSolver = {
        solve: async (challenge) => {
          seen.push(challenge);
          return {};
        },
      };
      const scraper = createScraper({ fetch: impl, robots: false, retries: 0, solver });
      await scraper
        .fetchHtml("https://example.com/", { throwOnHttpError: false })
        .catch(() => undefined);
      expect(seen[0]?.type).toBe(type);
      expect(seen[0]?.sitekey).toBe(type === "recaptcha" ? "gkey" : "hkey");
    }
  });

  it("solves at most once per call — a persistent challenge does not loop", async () => {
    const { impl, calls } = recordingFetch(() => cloudflarePage());
    let solves = 0;
    const solver: CaptchaSolver = {
      solve: async () => {
        solves += 1;
        return { cookies: { cf_clearance: "nope" } };
      },
    };
    const scraper = createScraper({ fetch: impl, robots: false, retries: 0, solver });
    const err = await scraper.fetchHtml("https://example.com/protected").catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(solves).toBe(1);
    expect(calls).toHaveLength(2); // initial + exactly one solver retry
  });

  it("without a solver, a challenge page behaves exactly as before", async () => {
    const { impl, calls } = recordingFetch(() => cloudflarePage());
    const scraper = createScraper({ fetch: impl, robots: false, retries: 0, stealth: true });
    const err = await scraper.fetchHtml("https://example.com/protected").catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    expect(calls).toHaveLength(1);
  });

  it("a throwing solver surfaces as ConfigError (user-callback convention)", async () => {
    const { impl } = recordingFetch(() => cloudflarePage());
    const solver: CaptchaSolver = {
      solve: async () => {
        throw new Error("provider quota exhausted");
      },
    };
    const scraper = createScraper({ fetch: impl, robots: false, retries: 0, solver });
    const err = await scraper.fetchHtml("https://example.com/protected").catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
  });

  it("does not mutate the caller's headers object on the solver retry", async () => {
    const { impl } = recordingFetch((n) => (n === 1 ? cloudflarePage() : okHtml()));
    const solver: CaptchaSolver = {
      solve: async () => ({ userAgent: "SolverUA/1.0" }),
    };
    // No stealth, no solution cookies → the retry must not write the solved UA
    // back into the caller's own headers record.
    const headers = { "x-keep": "1" };
    const scraper = createScraper({ fetch: impl, robots: false, solver });
    await scraper.fetchHtml("https://example.com/protected", { headers });
    expect(headers).toEqual({ "x-keep": "1" });
  });

  it("detects Amazon's Robot Check wall as a full-page bot check", () => {
    // The real page shape: <title>Robot Check</title>, a form posting to
    // /errors/validateCaptcha — served at status 200.
    const html =
      '<html><head><title>Robot Check</title></head><body><form method="POST" action="/errors/validateCaptcha"><input type="text" name="field-keywords"/></form></body></html>';
    const challenge = detectChallenge({
      url: "https://www.amazon.com/",
      status: 200,
      headers: new Headers(HTML_HEADERS),
      html,
    });
    expect(challenge?.type).toBe("amazon-robot-check");
    expect(challenge?.url).toBe("https://www.amazon.com/");
    expect(challenge?.html).toBe(html);
  });

  it("does not match a normal page merely mentioning captchas", () => {
    // Marker tightness: the generic word "captcha" must not fire the
    // amazon-robot-check markers — nor any widget marker.
    const html =
      "<html><head><title>Contact</title></head><body><p>This form is protected by a captcha.</p></body></html>";
    expect(
      detectChallenge({
        url: "https://example.com/contact",
        status: 200,
        headers: new Headers(HTML_HEADERS),
        html,
      }),
    ).toBeNull();
  });

  it("does not invoke the solver on a normal 200 page", async () => {
    const { impl, calls } = recordingFetch(() => okHtml());
    let solves = 0;
    const solver: CaptchaSolver = {
      solve: async () => {
        solves += 1;
        return {};
      },
    };
    const scraper = createScraper({ fetch: impl, robots: false, solver });
    const result = await scraper.fetchHtml("https://example.com/");
    expect(result.status).toBe(200);
    expect(solves).toBe(0);
    expect(calls).toHaveLength(1);
  });
});
