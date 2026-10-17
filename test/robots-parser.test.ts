import { describe, expect, it } from "vitest";
import { parse } from "../src/robots-parser.js";

const BASE = "https://example.com/robots.txt";
const at = (path: string) => `https://example.com${path}`;

describe("robots-parser — groups", () => {
  it("a named group beats the `*` group", () => {
    const agent = parse(
      BASE,
      ["User-agent: *", "Disallow: /all", "", "User-agent: mybot", "Allow: /all"].join("\n"),
    );
    expect(agent.isAllowed(at("/all"), "mybot")).toBe(true);
    expect(agent.isAllowed(at("/all"), "other")).toBe(false);
  });

  it("matches a UA token as a case-insensitive substring of the UA", () => {
    // Google spec: the product token is a substring of the crawler UA.
    const agent = parse(BASE, ["User-agent: bot", "Disallow: /x"].join("\n"));
    expect(agent.isAllowed(at("/x"), "MyBot/1.0")).toBe(false);
    expect(agent.isAllowed(at("/x"), "unrelated")).toBe(true);
  });

  it("ignores the version suffix when matching tokens", () => {
    const agent = parse(BASE, ["User-agent: bot/9", "Disallow: /x"].join("\n"));
    expect(agent.isAllowed(at("/x"), "bot/1.0")).toBe(false);
  });

  it("the longest matching token wins", () => {
    const agent = parse(
      BASE,
      ["User-agent: bot", "Disallow: /", "", "User-agent: googlebot", "Allow: /"].join("\n"),
    );
    // "googlebot" (9) outranks "bot" (3): the specific group allows.
    expect(agent.isAllowed(at("/anything"), "googlebot/2.1")).toBe(true);
  });

  it("merges rules of equally long matching tokens", () => {
    // Both "aab" and "abb" are length-3 substrings of "aabb".
    const agent = parse(
      BASE,
      ["User-agent: aab", "Disallow: /from-aab", "", "User-agent: abb", "Disallow: /from-abb"].join(
        "\n",
      ),
    );
    expect(agent.isAllowed(at("/from-aab"), "aabb")).toBe(false);
    expect(agent.isAllowed(at("/from-abb"), "aabb")).toBe(false);
    expect(agent.isAllowed(at("/other"), "aabb")).toBe(true);
  });

  it("merges groups sharing a token into one rule set", () => {
    const agent = parse(
      BASE,
      ["User-agent: bot", "Disallow: /a", "", "User-agent: bot", "Disallow: /b"].join("\n"),
    );
    expect(agent.isAllowed(at("/a"), "bot")).toBe(false);
    expect(agent.isAllowed(at("/b"), "bot")).toBe(false);
  });

  it("blank lines inside a user-agent run do not split the group", () => {
    const agent = parse(BASE, ["User-agent: a", "", "User-agent: b", "Disallow: /x"].join("\n"));
    expect(agent.isAllowed(at("/x"), "a")).toBe(false);
    expect(agent.isAllowed(at("/x"), "b")).toBe(false);
  });

  it("a user-agent line after rules starts a new group", () => {
    const agent = parse(
      BASE,
      ["User-agent: a", "Disallow: /x", "User-agent: b", "Disallow: /y"].join("\n"),
    );
    expect(agent.isAllowed(at("/x"), "a")).toBe(false);
    expect(agent.isAllowed(at("/y"), "a")).toBe(true);
    expect(agent.isAllowed(at("/y"), "b")).toBe(false);
  });

  it("ignores rules outside any group", () => {
    const agent = parse(BASE, "Disallow: /x");
    expect(agent.isAllowed(at("/x"), "bot")).toBe(true);
  });

  it("a group with only an empty disallow is allow-all — no `*` fallback", () => {
    const agent = parse(
      BASE,
      ["User-agent: *", "Disallow: /x", "", "User-agent: b", "Disallow:"].join("\n"),
    );
    expect(agent.isAllowed(at("/x"), "b")).toBe(true);
  });
});

describe("robots-parser — path matching", () => {
  it("the longest matching rule wins", () => {
    const agent = parse(BASE, ["User-agent: *", "Disallow: /fish", "Allow: /fish/test"].join("\n"));
    expect(agent.isAllowed(at("/fish"))).toBe(false);
    expect(agent.isAllowed(at("/fish/test"))).toBe(true);
    expect(agent.isAllowed(at("/fish/other"))).toBe(false);
  });

  it("an allow wins over a disallow of equal length", () => {
    const agent = parse(BASE, ["User-agent: *", "Disallow: /aa/", "Allow: /aa/"].join("\n"));
    expect(agent.isAllowed(at("/aa/"))).toBe(true);
  });

  it("matches paths case-sensitively", () => {
    const agent = parse(BASE, "User-agent: *\nDisallow: /test.html");
    expect(agent.isAllowed(at("/test.html"))).toBe(false);
    expect(agent.isAllowed(at("/Test.html"))).toBe(true);
  });

  it("`*` matches any sequence including empty", () => {
    const agent = parse(BASE, "User-agent: *\nDisallow: /fish*.php");
    expect(agent.isAllowed(at("/fish.php"))).toBe(false);
    expect(agent.isAllowed(at("/fishheads/catfish.php?parameters"))).toBe(false);
    expect(agent.isAllowed(at("/Fish.PHP"))).toBe(true);
  });

  it("`$` anchors the match to the end of the path", () => {
    const agent = parse(BASE, "User-agent: *\nDisallow: /*.dext$");
    expect(agent.isAllowed(at("/AnYthInG.dext"))).toBe(false);
    expect(agent.isAllowed(at("/a.dext1"))).toBe(true);
    // Query string counts as part of the matched path.
    expect(agent.isAllowed(at("/a.dext?x=1"))).toBe(true);
  });

  it("a `$` mid-pattern is a literal", () => {
    const agent = parse(BASE, "User-agent: *\nDisallow: /a$b");
    expect(agent.isAllowed(at("/a$b"))).toBe(false);
    expect(agent.isAllowed(at("/ab"))).toBe(true);
  });

  it("a rule without a leading `/` never matches", () => {
    const agent = parse(BASE, "User-agent: *\nDisallow: fish");
    expect(agent.isAllowed(at("/fish"))).toBe(true);
  });

  it("percent-encoded rules match the URL's encoded form", () => {
    const agent = parse(
      BASE,
      ["User-agent: *", "Disallow: /%CF%80", "Disallow: /💩", "Disallow: /%e2%9d%83"].join("\n"),
    );
    expect(agent.isAllowed(at("/π"))).toBe(false);
    expect(agent.isAllowed(at("/%CF%80/index.html"))).toBe(false);
    expect(agent.isAllowed(at("/💩"))).toBe(false);
    expect(agent.isAllowed(at("/%E2%9D%83"))).toBe(false);
    expect(agent.isAllowed(at("/other"))).toBe(true);
  });

  it("includes the query string in the matched path", () => {
    const agent = parse(BASE, "User-agent: *\nDisallow: /search?");
    expect(agent.isAllowed(at("/search?q=x"))).toBe(false);
    expect(agent.isAllowed(at("/search"))).toBe(true);
  });
});

describe("robots-parser — crawl-delay", () => {
  it("parses integer and float delays per group", () => {
    const agent = parse(
      BASE,
      [
        "User-agent: a",
        "Crawl-delay: 2",
        "",
        "User-agent: b",
        "Crawl-delay: 1.5",
        "",
        "User-agent: c",
        "Disallow: /x",
      ].join("\n"),
    );
    expect(agent.getCrawlDelay("a")).toBe(2);
    expect(agent.getCrawlDelay("b")).toBe(1.5);
    expect(agent.getCrawlDelay("c")).toBeUndefined();
  });

  it("falls back to the `*` group's delay", () => {
    const agent = parse(BASE, "User-agent: *\nCrawl-delay: 1");
    expect(agent.getCrawlDelay("anything")).toBe(1);
    expect(agent.getCrawlDelay()).toBe(1);
  });

  it("does not fall back when the UA's own group exists", () => {
    const agent = parse(
      BASE,
      ["User-agent: *", "Crawl-delay: 1", "", "User-agent: b", "Disallow:"].join("\n"),
    );
    expect(agent.getCrawlDelay("b")).toBeUndefined();
  });

  it("ignores non-numeric delays", () => {
    const agent = parse(BASE, "User-agent: a\nCrawl-delay: 1.2.1\nCrawl-delay: x");
    expect(agent.getCrawlDelay("a")).toBeUndefined();
  });

  it("the last crawl-delay in a group wins", () => {
    const agent = parse(BASE, "User-agent: a\nCrawl-delay: 1\nCrawl-delay: 3");
    expect(agent.getCrawlDelay("a")).toBe(3);
  });
});

describe("robots-parser — sitemaps", () => {
  it("collects sitemap lines anywhere in the file", () => {
    const agent = parse(
      BASE,
      [
        "Sitemap: https://example.com/top.xml",
        "User-agent: *",
        "Disallow: /x",
        "Sitemap: https://example.com/inside.xml",
        "",
        "Sitemap:   https://example.com/end.xml   ",
      ].join("\n"),
    );
    expect(agent.getSitemaps()).toEqual([
      "https://example.com/top.xml",
      "https://example.com/inside.xml",
      "https://example.com/end.xml",
    ]);
  });

  it("a sitemap line inside a group is still collected", () => {
    const agent = parse(BASE, "User-agent: a\nSitemap: https://example.com/s.xml\nDisallow: /x");
    expect(agent.getSitemaps()).toEqual(["https://example.com/s.xml"]);
    // ...and it ends the UA run — the disallow still lands on "a".
    expect(agent.isAllowed(at("/x"), "a")).toBe(false);
  });

  it("returns an empty array when no sitemap lines exist", () => {
    expect(parse(BASE, "User-agent: *\nDisallow: /").getSitemaps()).toEqual([]);
  });
});

describe("robots-parser — file shape", () => {
  it("accepts mixed line endings", () => {
    const agent = parse(BASE, "User-agent: *\r\nDisallow: /a\rDisallow: /b\n");
    expect(agent.isAllowed(at("/a"))).toBe(false);
    expect(agent.isAllowed(at("/b"))).toBe(false);
  });

  it("strips a BOM", () => {
    const agent = parse(BASE, "\uFEFFUser-agent: *\nDisallow: /x");
    expect(agent.isAllowed(at("/x"), "bot")).toBe(false);
  });

  it("strips `#` comments to end of line", () => {
    const agent = parse(
      BASE,
      ["# comment", "User-agent: * # inline", "Disallow: /x # note", "# Disallow: /y"].join("\n"),
    );
    expect(agent.isAllowed(at("/x"))).toBe(false);
    expect(agent.isAllowed(at("/y"))).toBe(true);
  });

  it("field names are case-insensitive and whitespace-tolerant", () => {
    const agent = parse(BASE, "  USER-AGENT :  * \n  DISALLOW :/x");
    expect(agent.isAllowed(at("/x"))).toBe(false);
  });

  it("ignores malformed and unknown lines", () => {
    const agent = parse(
      BASE,
      ["no colon here", ":::junk:::", "User-agent: *", "Unknown: x", "Disallow: /a"].join("\n"),
    );
    expect(agent.isAllowed(at("/a"))).toBe(false);
  });

  it("an empty file allows everything", () => {
    const agent = parse(BASE, "");
    expect(agent.isAllowed(at("/anything"), "bot")).toBe(true);
    expect(agent.getCrawlDelay("bot")).toBeUndefined();
    expect(agent.getSitemaps()).toEqual([]);
  });

  it("no matching group allows everything", () => {
    const agent = parse(BASE, "User-agent: specific\nDisallow: /");
    expect(agent.isAllowed(at("/x"), "other")).toBe(true);
  });
});

describe("robots-parser — URL scope", () => {
  const agent = parse("https://example.com/robots.txt", "User-agent: *\nDisallow: /x");

  it("a different origin is undecidable — answers allow", () => {
    expect(agent.isAllowed("https://other.com/x")).toBe(true);
    expect(agent.isAllowed("http://example.com/x")).toBe(true); // scheme differs
    expect(agent.isAllowed("https://example.com:8443/x")).toBe(true); // port differs
  });

  it("an unparseable URL is undecidable — answers allow", () => {
    expect(agent.isAllowed("not a url")).toBe(true);
  });

  it("host case is ignored", () => {
    const a = parse("https://eXamPle.com/robots.txt", "User-agent: *\nDisallow: /x");
    expect(a.isAllowed("https://EXAMPLE.COM/x")).toBe(false);
  });

  it("explicit default ports match implicit ones", () => {
    const a = parse("https://example.com/robots.txt", "User-agent: *\nDisallow: /x");
    expect(a.isAllowed("https://example.com:443/x")).toBe(false);
  });

  it("relative URLs work when the robots.txt URL is relative too", () => {
    const a = parse("/robots.txt", "User-agent: *\nDisallow: /fish");
    expect(a.isAllowed("/fish")).toBe(false);
    expect(a.isAllowed("/fish/test")).toBe(false);
    expect(a.isAllowed("/x")).toBe(true);
    // Absolute URLs are out of scope for a relative robots.txt — undecidable.
    expect(a.isAllowed("https://example.com/fish")).toBe(true);
  });
});
