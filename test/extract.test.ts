import { describe, expect, it } from "vitest";
import { ConfigError, extract, extractAll, parseHtml } from "../src/index.js";
import { readFixture } from "./fixtures.js";

const listing = () => parseHtml(readFixture("product-listing.html"));
const detail = () => parseHtml(readFixture("product-detail.html"));

/**
 * A transform that refuses anything but a single string argument. Passing this
 * function by reference to `Array#map` throws, which is exactly the bug this guards.
 */
const exactlyOneArg = (...args: string[]): string => {
  const [first] = args;
  if (args.length !== 1 || first === undefined) {
    throw new Error(`expected exactly 1 argument, received ${args.length}`);
  }
  return first;
};

describe("extract — field specs", () => {
  it("treats a bare string spec as { selector } and reads the first match", () => {
    const result = extract(listing(), { name: ".product-name" });
    expect(result.name).toBe("Trail Shell Jacket");
  });

  it("collapses whitespace runs and trims extracted text", () => {
    const root = parseHtml("<p class='w'>  Hello\n   World \t </p>");
    expect(extract(root, { w: ".w" }).w).toBe("Hello World");
  });

  it("decodes HTML entities while extracting", () => {
    expect(extract(listing(), { promo: ".promo" }).promo).toBe("Free shipping over £50");
  });

  it("reads attributes with attr instead of text content", () => {
    const root = detail();
    expect(extract(root, { text: ".product-title" }).text).toBe("Trail Shell Jacket");
    expect(extract(root, { attr: { selector: ".variant", attr: "data-sku" } }).attr).toBe(
      "TT-1001-S-BLK",
    );
  });

  it("reads meta tags by attribute", () => {
    const root = detail();
    const meta = { selector: 'meta[name="sku"]', attr: "content" };
    expect(extract(root, { sku: meta }).sku).toBe("TT-1001");
    expect(
      extract(root, { og: { selector: 'meta[property="og:description"]', attr: "content" } }).og,
    ).toBe("Waterproof three-layer shell jacket.");
  });

  it("collects every match with all: true", () => {
    const result = extract(detail(), { price: { selector: ".price", all: true } });
    expect(result.price).toEqual(["£51.77", "£64.00"]);
  });

  it("returns an empty array (never undefined) when all: true matches nothing", () => {
    const root = parseHtml(readFixture("empty.html"));
    const result = extract(root, { price: { selector: ".price", all: true } });
    expect(result.price).toEqual([]);
  });

  it("passes the raw string to transform and returns the mapped value", () => {
    const seen: string[] = [];
    const result = extract(detail(), {
      raw: {
        selector: ".price",
        transform: (raw) => {
          seen.push(raw);
          return raw;
        },
      },
    });
    expect(seen).toEqual(["£51.77"]);
    expect(result.raw).toBe("£51.77");
  });

  it("maps transform output over every element when combined with all: true", () => {
    const root = detail();
    const result = extract(root, {
      amounts: {
        selector: ".price",
        all: true,
        transform: (raw) => Number.parseFloat(raw.replace(/[^0-9.]/gu, "")),
      },
    });
    expect(result.amounts).toEqual([51.77, 64]);
  });

  it("calls transform with exactly one argument when all: true", () => {
    // Regression: passing the function reference straight to Array#map leaked
    // (value, index, array) into it, which tsc cannot catch.
    const root = parseHtml('<span class="qty">512</span><span class="qty">8</span>');
    const result = extract(root, {
      qty: { selector: ".qty", all: true, transform: exactlyOneArg },
    });
    expect(result.qty).toEqual(["512", "8"]);
  });

  it("calls transform with exactly one argument for a single value", () => {
    const root = detail();
    expect(extract(root, { price: { selector: ".price", transform: exactlyOneArg } }).price).toBe(
      "£51.77",
    );
  });

  it("does not leak map's index into a transform that accepts one", () => {
    // `Number.parseInt` is a realistic callback that takes an optional second
    // argument: with (value, index, array) it yields [512, NaN].
    const root = parseHtml('<span class="qty">512</span><span class="qty">8</span>');
    const result = extract(root, {
      qty: { selector: ".qty", all: true, transform: Number.parseInt },
    });
    expect(result.qty).toEqual([512, 8]);
  });
});

describe("extract — missing fields", () => {
  it("yields undefined for a selector that matched nothing", () => {
    const root = parseHtml(readFixture("empty.html"));
    const result = extract(root, { title: "h1.product-title", price: ".price" });
    expect(result.title).toBeUndefined();
    expect(result.price).toBeUndefined();
    expect(Object.keys(result)).toEqual(["title", "price"]);
  });

  it("yields undefined for an attribute that is not present", () => {
    const result = extract(detail(), {
      missing: { selector: ".product-title", attr: "data-nope" },
    });
    expect(result.missing).toBeUndefined();
  });

  it("does NOT call transform when the selector matched nothing", () => {
    let calls = 0;
    const root = parseHtml(readFixture("empty.html"));
    const result = extract(root, {
      price: {
        selector: ".price",
        transform: (raw) => {
          calls += 1;
          return Number.parseFloat(raw);
        },
      },
    });
    expect(result.price).toBeUndefined();
    expect(calls).toBe(0);
  });
});

describe("extract — baseUrl resolution", () => {
  const baseUrl = "https://shop.example.com/catalog/index.html";
  const href = { selector: "a.product-link", attr: "href", all: true } as const;

  it("resolves relative attribute values against baseUrl", () => {
    const result = extract(listing(), { href }, { baseUrl });
    expect(result.href).toEqual([
      "https://shop.example.com/products/trail-shell-jacket",
      "https://shop.example.com/products/ridge-trousers",
      "https://cdn.example.com/products/alpine-boots",
    ]);
  });

  it("resolves document-relative and root-relative values differently", () => {
    const result = extract(
      listing(),
      { src: { selector: "img.thumb", attr: "src", all: true } },
      { baseUrl },
    );
    expect(result.src[0]).toBe("https://shop.example.com/catalog/images/trail-shell.jpg");
    expect(result.src[1]).toBe("https://shop.example.com/images/ridge-trousers.jpg");
  });

  it("leaves already-absolute values untouched", () => {
    const result = extract(listing(), { href }, { baseUrl });
    expect(result.href[2]).toBe("https://cdn.example.com/products/alpine-boots");
  });

  it("returns raw attribute values when no baseUrl is given", () => {
    const result = extract(listing(), { href });
    expect(result.href).toEqual([
      "/products/trail-shell-jacket",
      "/products/ridge-trousers",
      "https://cdn.example.com/products/alpine-boots",
    ]);
  });

  it("falls back to the raw value when it cannot be resolved", () => {
    const root = parseHtml('<a href="http://">broken</a>');
    const result = extract(root, { href: { selector: "a", attr: "href" } }, { baseUrl });
    expect(result.href).toBe("http://");
  });

  it("accepts a URL instance as baseUrl", () => {
    const result = extract(
      detail(),
      { back: { selector: "a.back", attr: "href" } },
      {
        baseUrl: new URL("https://shop.example.com/catalog/p/1.html"),
      },
    );
    expect(result.back).toBe("https://shop.example.com/catalog/index.html");
  });
});

describe("extract — baseUrl only touches URL attributes", () => {
  const baseUrl = "https://shop.example.com/catalog/index.html";
  const ogSpec = { selector: 'meta[property="og:description"]', attr: "content" } as const;

  it("leaves a content attribute verbatim even when baseUrl is set", () => {
    const result = extract(detail(), { og: ogSpec }, { baseUrl });
    expect(result.og).toBe("Waterproof three-layer shell jacket.");
  });

  it("leaves alt and data-* attributes verbatim", () => {
    const result = extract(
      listing(),
      {
        alt: { selector: "img.thumb", attr: "alt" },
        sku: { selector: "li.product", attr: "data-sku" },
      },
      { baseUrl },
    );
    expect(result.alt).toBe("Trail Shell Jacket");
    expect(result.sku).toBe("TT-1001");
  });

  it("leaves a srcset candidate list untouched (it is a list, not one URL)", () => {
    const root = parseHtml('<img srcset="a.jpg 1x, b.jpg 2x" src="a.jpg">');
    const result = extract(
      root,
      { srcset: { selector: "img", attr: "srcset" }, src: { selector: "img", attr: "src" } },
      { baseUrl },
    );
    expect(result.srcset).toBe("a.jpg 1x, b.jpg 2x");
    // The single-URL sibling is still resolved.
    expect(result.src).toBe("https://shop.example.com/catalog/a.jpg");
  });

  it("does not turn a whitespace-only value into the base URL", () => {
    const root = parseHtml('<a href="   ">blank</a>');
    expect(extract(root, { href: { selector: "a", attr: "href" } }, { baseUrl }).href).toBe("   ");
  });

  it("opts IN to resolution for a URL stashed in a data attribute", () => {
    const root = parseHtml('<a data-href="/p/1">x</a>');
    expect(extract(root, { href: { selector: "a", attr: "data-href" } }, { baseUrl }).href).toBe(
      "/p/1",
    );
    expect(
      extract(root, { href: { selector: "a", attr: "data-href", resolve: true } }, { baseUrl })
        .href,
    ).toBe("https://shop.example.com/p/1");
  });

  it("opts OUT of resolution for a real href", () => {
    const root = parseHtml('<a href="/p/1">x</a>');
    expect(
      extract(root, { href: { selector: "a", attr: "href", resolve: false } }, { baseUrl }).href,
    ).toBe("/p/1");
  });

  it("honours resolve: true even for a non-URL attribute", () => {
    expect(extract(detail(), { og: { ...ogSpec, resolve: true } }, { baseUrl }).og).toBe(
      "https://shop.example.com/catalog/Waterproof%20three-layer%20shell%20jacket.",
    );
  });

  it("rejects a non-boolean resolve", () => {
    const root = detail();
    const bad = { selector: "a", attr: "href", resolve: "yes" } as unknown as {
      selector: string;
      attr: string;
      resolve: boolean;
    };
    expect(() => extract(root, { href: bad })).toThrow(ConfigError);
  });
});

describe("extract — empty values", () => {
  it("returns an empty string for a present-but-empty attribute", () => {
    const root = parseHtml('<a href="">blank</a><a href="/y">y</a>');
    expect(extract(root, { href: { selector: "a", attr: "href" } }).href).toBe("");
    expect(extract(root, { href: { selector: "a", attr: "href", all: true } }).href).toEqual([
      "",
      "/y",
    ]);
  });

  it("never resolves an empty attribute into the base URL", () => {
    const root = parseHtml('<a href="">blank</a>');
    const result = extract(
      root,
      { href: { selector: "a", attr: "href" } },
      {
        baseUrl: "https://shop.example.com/catalog/index.html",
      },
    );
    expect(result.href).toBe("");
  });

  it("collapses whitespace-only text to an empty string, not undefined", () => {
    const root = parseHtml("<p class='blank'>   \n\t  </p>");
    expect(extract(root, { blank: ".blank" }).blank).toBe("");
    // …and an empty match still reaches transform (it is a match, not a miss).
    expect(extract(root, { blank: { selector: ".blank", transform: exactlyOneArg } }).blank).toBe(
      "",
    );
  });
});

describe("extractAll", () => {
  it("extracts one record per container match, in document order", () => {
    const records = extractAll(listing(), "li.product", {
      name: ".product-name",
      price: ".price",
      href: { selector: "a.product-link", attr: "href" },
    });
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.name)).toEqual([
      "Trail Shell Jacket",
      "Ridge Trousers",
      "Alpine Boots",
    ]);
    expect(records.map((r) => r.price)).toEqual(["£51.77", "£29.99", "£109.50"]);
    expect(records[0]?.href).toBe("/products/trail-shell-jacket");
  });

  it("scopes field selectors inside the container so outside matches cannot leak in", () => {
    // The listing has a `.price` outside every `li.product` on purpose.
    const wholeDocument = extract(listing(), { price: { selector: ".price", all: true } });
    expect(wholeDocument.price).toHaveLength(4);

    const records = extractAll(listing(), "li.product", {
      price: { selector: ".price", all: true },
    });
    expect(records.map((r) => r.price)).toEqual([["£51.77"], ["£29.99"], ["£109.50"]]);
  });

  it("does not leak a field selector from one container into the next", () => {
    const root = detail();
    expect(extractAll(root, ".variant", { size: ".variant-size" })).toEqual([
      { size: "S" },
      { size: "M" },
    ]);
  });

  it("uses .find() semantics: a field selector does not match the container itself", () => {
    const root = detail();
    expect(
      extractAll(root, ".variant", { sku: { selector: ".variant", attr: "data-sku" } }),
    ).toEqual([{ sku: undefined }, { sku: undefined }]);
    // …whereas the same selector works against the document scope.
    expect(
      extract(root, { sku: { selector: ".variant", attr: "data-sku", all: true } }).sku,
    ).toEqual(["TT-1001-S-BLK", "TT-1001-M-BLK"]);
  });

  it("returns an empty array when the container matches nothing", () => {
    const root = parseHtml(readFixture("empty.html"));
    expect(extractAll(root, "li.product", { name: ".product-name" })).toEqual([]);
  });

  it("applies baseUrl resolution per record", () => {
    const records = extractAll(
      listing(),
      "li.product",
      { href: { selector: "a", attr: "href" } },
      {
        baseUrl: "https://shop.example.com/catalog/",
      },
    );
    expect(records.map((r) => r.href)).toEqual([
      "https://shop.example.com/products/trail-shell-jacket",
      "https://shop.example.com/products/ridge-trousers",
      "https://cdn.example.com/products/alpine-boots",
    ]);
  });
});
