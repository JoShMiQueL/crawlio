import { describe, expect, it } from "vitest";
import { scrubUrl } from "../src/errors.js";
import type { ExtractResult, FieldSpec } from "../src/index.js";
import {
  ConfigError,
  extract,
  extractAll,
  FetchError,
  HttpError,
  ParseError,
  parseHtml,
  RobotsError,
  ScrapeError,
  TimeoutError,
} from "../src/index.js";
import { readFixture } from "./fixtures.js";

const root = () => parseHtml(readFixture("product-detail.html"));

/** Deliberately bypass the type system: these specs are invalid at runtime. */
const asSpec = (value: unknown) => value as FieldSpec;

describe("ScrapeError taxonomy", () => {
  it("carries code, name, message and url", () => {
    const err = new ScrapeError("fetch", "boom", { url: "https://example.com/a" });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("fetch");
    expect(err.name).toBe("ScrapeError");
    expect(err.message).toBe("boom");
    expect(err.url).toBe("https://example.com/a");
    expect(err.stack).toContain("ScrapeError");
  });

  it("preserves cause through the standard Error cause chain", () => {
    const underlying = new Error("socket hang up");
    const err = new ScrapeError("fetch", "request failed", { cause: underlying });
    expect(err.cause).toBe(underlying);
  });

  it("leaves cause undefined when no cause was supplied", () => {
    expect(new ScrapeError("parse", "nope").cause).toBeUndefined();
    expect(new ScrapeError("parse", "nope").url).toBeUndefined();
  });

  it("scrubs credentials out of the stored url", () => {
    const err = new ScrapeError("fetch", "boom", { url: "https://user:pass@shop.example.com/x" });
    expect(err.url).toBe("https://shop.example.com/x");
    expect(err.message).not.toContain("pass");
    // Subclasses inherit the scrubbing.
    expect(new FetchError("boom", { url: "https://u:p@h/x" }).url).toBe("https://h/x");
  });

  it("maps every code onto the matching subclass", () => {
    const cases: Array<[ScrapeError, string]> = [
      [new ConfigError("c"), "config"],
      [new ParseError("p"), "parse"],
      [new ScrapeError("fetch", "f"), "fetch"],
      [new TimeoutError("t"), "timeout"],
      [new HttpError("h"), "http"],
      [new RobotsError("r"), "robots"],
    ];
    for (const [err, code] of cases) {
      expect(err.code).toBe(code);
      expect(err).toBeInstanceOf(ScrapeError);
      expect(err.name).toBe(err.constructor.name);
    }
    expect(new TimeoutError("t", { url: "https://example.com" }).url).toBe("https://example.com");
  });
});

describe("errors thrown by extraction", () => {
  it("throws ConfigError for a malformed field spec", () => {
    const cases: Array<[string, unknown]> = [
      ["empty selector", { selector: "" }],
      ["blank selector", { selector: "   " }],
      ["non-string selector", { selector: 42 }],
      ["non-function transform", { selector: "h1", transform: "nope" }],
      ["non-string attr", { selector: "h1", attr: 7 }],
      ["not an object", 42],
      ["null spec", null],
    ];
    for (const [label, value] of cases) {
      let thrown: unknown;
      try {
        extract(root(), { bad: asSpec(value) });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, label).toBeInstanceOf(ConfigError);
      expect((thrown as ConfigError).code, label).toBe("config");
      expect((thrown as ConfigError).name, label).toBe("ConfigError");
      expect((thrown as Error).message, label).toMatch(/bad/);
    }
  });

  it("throws ParseError for a selector that cannot be compiled", () => {
    let thrown: unknown;
    try {
      extract(root(), { bad: "div:::" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ParseError);
    expect((thrown as ParseError).code).toBe("parse");
    expect((thrown as ParseError).message).toContain("div:::");
    expect((thrown as ParseError).cause).toBeInstanceOf(Error);
  });

  it("throws ParseError for an uncompilable container selector in extractAll", () => {
    expect(() => extractAll(root(), ".variant:has(", { size: ".variant-size" })).toThrow(
      ParseError,
    );
  });

  it("does NOT throw when a valid selector simply matches nothing", () => {
    const empty = parseHtml(readFixture("empty.html"));
    const result = extract(empty, { title: "h1.product-title" });
    expect(result.title).toBeUndefined();
    // The distinction matters: "no match" is data, "bad selector" is a bug.
    expect(() => extract(empty, { title: "h1.product-title" })).not.toThrow();
  });

  it("wraps a throwing transform in a ConfigError, naming the field but not the value", () => {
    const secret = "4111-1111-1111-1111";
    const root = parseHtml(`<p class="card">${secret}</p>`);
    let thrown: unknown;
    try {
      extract(root, {
        card: {
          selector: ".card",
          transform: () => {
            throw new RangeError(`bad card ${secret}`);
          },
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect(thrown).toBeInstanceOf(ScrapeError);
    expect((thrown as ConfigError).code).toBe("config");
    expect((thrown as ConfigError).message).toContain('field "card"');
    // Log hygiene: the message must not leak the scraped value, but `cause` keeps the
    // original error so the failure is still diagnosable.
    expect((thrown as ConfigError).message).not.toContain(secret);
    expect((thrown as ConfigError).cause).toBeInstanceOf(RangeError);
    expect(((thrown as ConfigError).cause as Error).message).toContain(secret);
  });

  it("wraps a throwing transform on the all: true path too", () => {
    const root = parseHtml('<span class="q">1</span><span class="q">2</span>');
    expect(() =>
      extract(root, {
        q: {
          selector: ".q",
          all: true,
          transform: (raw: string) => {
            if (raw === "2") throw new Error("boom");
            return raw;
          },
        },
      }),
    ).toThrow(ConfigError);
  });

  it("never throws anything other than a ScrapeError", () => {
    const doc = root();
    const cases: Array<() => unknown> = [
      // malformed spec
      () => extract(doc, { bad: { selector: "" } }),
      // uncompilable selector
      () => extract(doc, { bad: "div:::" }),
      // user callback blowing up
      () =>
        extract(doc, {
          bad: {
            selector: "h1",
            transform: () => {
              throw new RangeError("user bug");
            },
          },
        }),
      // non-object spec
      () => extract(doc, { bad: asSpec(null) }),
      // non-object field collection
      () => extract(doc, null as unknown as Record<string, never>),
      // blank container selector
      () => extractAll(doc, "", {}),
    ];
    for (const run of cases) {
      let thrown: unknown;
      try {
        run();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ScrapeError);
    }
  });
});

describe("scrubUrl", () => {
  it("strips credentials from a parseable URL", () => {
    expect(scrubUrl("https://user:pass@shop.example.com/x")).toBe("https://shop.example.com/x");
    expect(scrubUrl("https://user@shop.example.com/x")).toBe("https://shop.example.com/x");
    expect(scrubUrl("http://host:8080/a?b=c#d")).toBe("http://host:8080/a?b=c#d");
  });

  it("strips credentials from strings that are not parseable URLs", () => {
    expect(scrubUrl("not a url user:pass@host")).toBe("not a url user:pass@host");
    expect(scrubUrl("https://user:pass@")).toBe("https://");
  });

  it("strips through the LAST @ so a password containing @ leaves no fragment", () => {
    // `new URL` rejects this (invalid port), so the textual fallback runs —
    // matching only up to the first `@` would leak `ss@` of `p@ss`.
    expect(scrubUrl("http://user:p@ss@host:port trailing")).toBe("http://host:port trailing");
    expect(scrubUrl("http://user:p@ss@host/path")).toBe("http://host/path");
    // An `@` in the path must NOT trigger stripping.
    expect(scrubUrl("http://host/p@th")).toBe("http://host/p@th");
  });

  it("leaves credential-free values untouched", () => {
    expect(scrubUrl("https://shop.example.com/x")).toBe("https://shop.example.com/x");
  });

  it("only scrubs the url option — message and cause pass through verbatim", () => {
    // Pinning the documented scope: scrubUrl() cleans `url`, nothing else. A future
    // fetch layer that interpolates a URL into a message must scrub it first.
    const leaky = "GET https://user:pass@shop.example.com/x failed";
    const err = new FetchError(leaky, { url: "https://user:pass@shop.example.com/x" });
    expect(err.message).toBe(leaky);
    expect(err.url).toBe("https://shop.example.com/x");
  });
});

describe("type-level expectations (checked by tsc, asserted trivially at runtime)", () => {
  it("compiles only if ExtractResult infers the documented shape", () => {
    const result = extract(root(), {
      title: "h1",
      prices: { selector: ".price", all: true },
      n: {
        selector: ".price",
        transform: (raw: string) => Number.parseFloat(raw.replace(/[^\d.]/gu, "")),
      },
    });
    // Runtime counterpart of the type assertion below.
    expect(result.title).toBe("Trail Shell Jacket");
    expect(result.prices).toEqual(["£51.77", "£64.00"]);
    expect(result.n).toBeCloseTo(51.77);

    const typed: ExtractResult<{
      title: string;
      prices: { selector: string; all: true };
      n: { selector: string; transform: (raw: string) => number };
    }> = result;
    expect(typed.prices).toHaveLength(2);
  });
});
