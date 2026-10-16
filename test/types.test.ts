import { describe, expectTypeOf, it } from "vitest";
import type {
  CaptchaChallenge,
  CaptchaSolution,
  CaptchaSolver,
  ExtractResult,
  FetchHtmlOptions,
  FetchHtmlResult,
  FieldSpec,
  FieldSpecRecord,
  FieldValue,
  RequestDelay,
  ScraperOptions,
  StealthOptions,
} from "../src/index.js";
import { fetchHtml, scrape } from "../src/index.js";

/**
 * TYPE-LEVEL ASSERTIONS ONLY — the `it` bodies below are runtime no-ops.
 *
 * `expectTypeOf` is a compile-time construct: a mismatch here is a `tsc` error, not a
 * vitest failure. They are enforced by `pnpm typecheck` / `pnpm test:types`
 * (`tsc --noEmit -p tsconfig.test.json`, which typechecks `src` + `test`); vitest is
 * only run to keep the file in the suite. The runtime-meaningful coverage lives in
 * the other suites — do not read a green `pnpm test` as evidence these pass.
 */
const spec = {
  title: "h1.product-title",
  prices: { selector: ".price", all: true },
  n: { selector: ".price", transform: (raw: string) => Number.parseFloat(raw) },
};

type Spec = typeof spec;

type Expected = {
  title: string | undefined;
  prices: string[];
  n: number | undefined;
};

describe("type inference", () => {
  it("infers one key per declared field", () => {
    expectTypeOf<keyof ExtractResult<Spec>>().toEqualTypeOf<keyof Expected>();
    expectTypeOf<ExtractResult<Spec>>().toEqualTypeOf<Expected>();
  });

  it("infers a bare selector as an optional string", () => {
    expectTypeOf<FieldValue<string>>().toEqualTypeOf<string | undefined>();
    expectTypeOf<FieldValue<{ selector: string }>>().toEqualTypeOf<string | undefined>();
    expectTypeOf<FieldValue<{ selector: string; attr: string }>>().toEqualTypeOf<
      string | undefined
    >();
  });

  it("infers all: true as an array", () => {
    expectTypeOf<FieldValue<{ selector: string; all: true }>>().toEqualTypeOf<string[]>();
    // A spec declared outside the extract() call widens `true` to `boolean`; both
    // spellings must still produce an array.
    expectTypeOf<FieldValue<{ selector: string; all: boolean }>>().toEqualTypeOf<string[]>();
    // …whereas `all: false` is the same as omitting the key.
    expectTypeOf<FieldValue<{ selector: string; all: false }>>().toEqualTypeOf<
      string | undefined
    >();
  });

  it("infers transform output, undefined included", () => {
    expectTypeOf<
      FieldValue<{ selector: string; transform: (raw: string) => number }>
    >().toEqualTypeOf<number | undefined>();
    expectTypeOf<
      FieldValue<{ selector: string; all: true; transform: (raw: string) => number }>
    >().toEqualTypeOf<number[]>();
  });

  it("is not poisoned by noUncheckedIndexedAccess", () => {
    expectTypeOf<ExtractResult<Spec>["prices"]>().toEqualTypeOf<string[]>();
    expectTypeOf<ExtractResult<Spec>["n"]>().toEqualTypeOf<number | undefined>();
  });

  it("documents that an annotated FieldSpec loses ALL inference", () => {
    // `FieldSpec.all` is optional, so under strictNullChecks it satisfies neither
    // `{ all: false }` nor `{ all: boolean }`: the conditional collapses and EVERY
    // field — including ones that really produce arrays — is declared
    // `string | undefined`. Narrower than reality, so unsound-but-safe, which is why
    // specs should be annotated with an inferred object type, never `FieldSpec`.
    expectTypeOf<FieldValue<FieldSpec>>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ExtractResult<FieldSpecRecord>>().toEqualTypeOf<{
      [key: string]: string | undefined;
    }>();
  });

  it("documents that `all: boolean` is a promise the flag must keep", () => {
    // A standalone `const` spec widens `all: true` to `boolean`, which must still
    // infer `string[]`. If such a flag can be false at runtime, the type is a lie —
    // pinned here so the trade-off is on the record rather than accidental.
    const widened = { prices: { selector: ".price", all: true } };
    expectTypeOf<ExtractResult<typeof widened>["prices"]>().toEqualTypeOf<string[]>();
  });

  it("documents HOW `all` widens: inline literal and as const keep `true`", () => {
    // Mirrors extract()'s signature so we observe what `S` infers to.
    const inferSpec = <S extends FieldSpecRecord>(spec: S): S => spec;

    type AllKind<F> = F extends { all: true }
      ? "literal"
      : F extends { all: boolean }
        ? "widened"
        : "absent";

    // Inline literal → literal `true` (verified, not assumed).
    const inline = inferSpec({ p: { selector: ".p", all: true } });
    expectTypeOf<AllKind<(typeof inline)["p"]>>().toEqualTypeOf<"literal">();

    // `as const` pins it.
    const pinned = inferSpec({ p: { selector: ".p", all: true } } as const);
    expectTypeOf<AllKind<(typeof pinned)["p"]>>().toEqualTypeOf<"literal">();

    // Standalone `const` (no assertion) → widened to `boolean`.
    const spec = { p: { selector: ".p", all: true } };
    const standalone = inferSpec(spec);
    expectTypeOf<AllKind<(typeof standalone)["p"]>>().toEqualTypeOf<"widened">();
  });

  it("keeps transform as the highest-precedence key and preserves `as const` readonly", () => {
    const transformed = {
      amounts: { selector: ".price", all: true, transform: (raw: string) => raw.length },
    } as const;
    // ExtractResult is a homomorphic mapped type, so `as const` survives into the
    // result type (including through the conditional FieldValue).
    expectTypeOf<ExtractResult<typeof transformed>>().toEqualTypeOf<{
      readonly amounts: number[];
    }>();
  });

  it("scrape() returns a typed ExtractResult for a string|URL url", async () => {
    // Injected fetch — the runtime body must stay offline like every other suite.
    const stub = async () => new Response("<html></html>", { status: 200 });
    const result = await scrape(
      "https://example.com/x",
      {
        title: "h1",
        prices: { selector: ".p", all: true },
      },
      { fetch: stub, robots: false },
    );
    expectTypeOf(result).toEqualTypeOf<{
      title: string | undefined;
      prices: string[];
    }>();
  });

  it("fetchHtml() returns a FetchHtmlResult", async () => {
    const stub = async () => new Response("<html></html>", { status: 200 });
    const result = await fetchHtml("https://example.com/x", { fetch: stub, robots: false });
    expectTypeOf(result).toEqualTypeOf<FetchHtmlResult>();
  });

  it("stealth accepts boolean | StealthOptions at both option levels", () => {
    expectTypeOf<FetchHtmlOptions["stealth"]>().toEqualTypeOf<
      boolean | StealthOptions | undefined
    >();
    expectTypeOf<ScraperOptions["stealth"]>().toEqualTypeOf<boolean | StealthOptions | undefined>();
    expectTypeOf<StealthOptions["browser"]>().toEqualTypeOf<
      "chrome" | "firefox" | "safari" | undefined
    >();
  });

  it("requestDelay accepts a fixed number or a { min, max } range", () => {
    expectTypeOf<FetchHtmlOptions["requestDelay"]>().toEqualTypeOf<RequestDelay | undefined>();
    expectTypeOf<ScraperOptions["requestDelay"]>().toEqualTypeOf<RequestDelay | undefined>();
    expectTypeOf<RequestDelay>().toEqualTypeOf<number | { min: number; max: number }>();
  });

  it("exposes the pluggable solver contract", () => {
    expectTypeOf<FetchHtmlOptions["solver"]>().toEqualTypeOf<CaptchaSolver | undefined>();
    expectTypeOf<ScraperOptions["solver"]>().toEqualTypeOf<CaptchaSolver | undefined>();
    expectTypeOf<CaptchaChallenge["type"]>().toEqualTypeOf<
      "turnstile" | "recaptcha" | "hcaptcha" | "cloudflare-interstitial"
    >();
    expectTypeOf<CaptchaSolution["cookies"]>().toEqualTypeOf<Record<string, string> | undefined>();
    expectTypeOf<CaptchaSolver["solve"]>().toBeFunction();
  });
});
