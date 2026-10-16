import { describe, expect, it, vi } from "vitest";
import { decodeBody, extractAll, parseHtml } from "../src/index.js";
import { readFixture, readFixtureBytes } from "./fixtures.js";

describe("parseHtml", () => {
  it("returns a cheerio root for well-formed markup", () => {
    const $ = parseHtml(readFixture("product-detail.html"));
    expect(typeof $).toBe("function");
    // cheerio's raw text is untouched; whitespace collapsing is `extract`'s job.
    expect($("h1.product-title").text()).toBe("Trail Shell\n    Jacket");
    expect(extractAll($, "body", { title: ".product-title" })[0]?.title).toBe("Trail Shell Jacket");
  });

  it("parses malformed markup without throwing", () => {
    expect(() => parseHtml(readFixture("malformed.html"))).not.toThrow();
  });

  it("recovers from unclosed <li> tags", () => {
    // Without malformed-tag recovery the second <li> would be nested inside the
    // first, and this selector would match a single element instead of three.
    const $ = parseHtml(readFixture("malformed.html"));
    expect($(".result")).toHaveLength(3);
  });

  it("recovers from unquoted attributes and a stray closing tag", () => {
    const $ = parseHtml(readFixture("malformed.html"));
    expect($(".result a").first().attr("href")).toBe("/alpha");
    expect($(".note").text()).toContain("Deliberately broken markup");
    expect(extractAll($, ".result", { price: ".price" }).map((r) => r.price)).toEqual([
      "£10.00",
      "£20.00",
      "£30.00",
    ]);
  });

  it("does not load remote resources while parsing", () => {
    // The document references a CDN image and a stylesheet; parsing must materialise
    // the DOM in memory and issue no requests at all. The spy is the assertion here —
    // the DOM checks only prove parsing happened.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network used"));
    try {
      const $ = parseHtml(readFixture("product-listing.html"));
      expect($("img.thumb")).toHaveLength(3);
      expect($("img.thumb").first().attr("src")).toBe("images/trail-shell.jpg");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("works on the decoded form of a non-UTF-8 body", () => {
    const html = decodeBody(readFixtureBytes("latin1.html"), "text/html; charset=iso-8859-1");
    const $ = parseHtml(html);
    expect(extractAll($, ".product", { name: ".name", price: ".price" })).toEqual([
      { name: "Café Crème", price: "£51.77" },
    ]);
  });

  it("parses an empty document", () => {
    const $ = parseHtml("");
    expect($("body")).toHaveLength(1);
    expect($(".product")).toHaveLength(0);
  });
});
