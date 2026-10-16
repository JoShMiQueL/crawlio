import { describe, expect, it } from "vitest";
import { charsetFromContentType, decodeBody, sniffCharset } from "../src/index.js";
import { readFixture, readFixtureBytes } from "./fixtures.js";

const LATIN1_HEADER = "text/html; charset=iso-8859-1";
const UTF8_HEADER = "text/html; charset=utf-8";
const latin1Bytes = () => readFixtureBytes("latin1.html");
const utf8 = (text: string) => new TextEncoder().encode(text);

describe("sniffCharset", () => {
  it("finds a bare <meta charset>", () => {
    expect(sniffCharset(readFixtureBytes("product-listing.html"))).toBe("utf-8");
  });

  it("finds a <meta http-equiv> charset and normalises case", () => {
    expect(sniffCharset(latin1Bytes())).toBe("iso-8859-1");
  });

  it("returns null when no declaration is present", () => {
    expect(sniffCharset(utf8("<html><body><p>hi</p></body></html>"))).toBeNull();
    expect(sniffCharset(new Uint8Array())).toBeNull();
  });

  it("only inspects the head of the document", () => {
    const late = `<html><body><p>${"padding ".repeat(400)}</p><meta charset="utf-16"></body></html>`;
    expect(sniffCharset(utf8(late))).toBeNull();
  });

  it("scans latin1-decoded markup with non-ASCII bytes in the tag", () => {
    // Latin1 bytes: the declaration is ASCII, but decoding them as UTF-8 first would
    // corrupt the surrounding text (and, if the corruption reached a quote, the scan).
    const bytes = Uint8Array.from([
      ...Buffer.from('<meta name="description" content="caf', "latin1"),
      0xe9,
      ...Buffer.from('"><meta charset=windows-1252>', "latin1"),
    ]);
    expect(sniffCharset(bytes)).toBe("windows-1252");
  });

  describe("ignores charset= that is not a declaration", () => {
    it("prose inside another attribute", () => {
      const html = '<meta name="description" content="Set charset=utf-8 in your head">';
      expect(sniffCharset(utf8(html))).toBeNull();
    });

    it("keywords content", () => {
      expect(sniffCharset(utf8('<meta name="keywords" content="charset=big5">'))).toBeNull();
    });

    it("a <meta> string inside a <script> block", () => {
      const html = '<script>var s="<meta charset=big5>";</script>';
      expect(sniffCharset(utf8(html))).toBeNull();
    });

    it("the <metadata> element", () => {
      expect(sniffCharset(utf8("<metadata charset=utf-8></metadata>"))).toBeNull();
    });
  });

  it("finds a charset inside a content value that itself contains '>'", () => {
    const html = '<meta http-equiv="Content-Type" content="a > b; charset=big5">';
    expect(sniffCharset(utf8(html))).toBe("big5");
  });

  it("accepts unquoted values and either attribute order", () => {
    expect(sniffCharset(utf8("<meta charset = utf-8 />"))).toBe("utf-8");
    expect(
      sniffCharset(utf8('<meta content="text/html; charset=koi8-r" http-equiv=Content-Type>')),
    ).toBe("koi8-r");
  });
  it("does not swallow the slash of an XHTML-style self-closing meta", () => {
    // Regression: an unquoted-value scan that stopped only at whitespace/`>` returned
    // "utf-8/", which is not a charset label.
    expect(sniffCharset(utf8("<meta charset=utf-8/>"))).toBe("utf-8");
    expect(sniffCharset(utf8("<meta charset=utf-8 />"))).toBe("utf-8");
    expect(sniffCharset(utf8('<meta charset="utf-8"/>'))).toBe("utf-8");
    // …and the decoded output is unaffected either way.
    expect(decodeBody(utf8("<meta charset=utf-8/><p>café</p>"))).toContain("café");
  });

  it("keeps the first value of a duplicated attribute", () => {
    expect(sniffCharset(utf8("<meta charset=utf-8 charset=big5>"))).toBe("utf-8");
    const dupContent =
      '<meta content="text/html; charset=utf-8" content="charset=big5" http-equiv="Content-Type">';
    expect(sniffCharset(utf8(dupContent))).toBe("utf-8");
  });

  it("treats an unterminated <script> as raw text to the end of the window", () => {
    const truncated = `<script>var a="<meta charset=big5>"${"x".repeat(1200)}`;
    expect(sniffCharset(utf8(truncated))).toBeNull();
  });

  it("treats an unterminated comment as raw text to the end of the window", () => {
    const truncated = `<!-- <meta charset=big5>${"x".repeat(1200)}`;
    expect(sniffCharset(utf8(truncated))).toBeNull();
  });

  it("still finds a real declaration after a closed <script>", () => {
    const html = '<script>var a="<meta charset=big5>";</script><meta charset="utf-8">';
    expect(sniffCharset(utf8(html))).toBe("utf-8");
  });
});

describe("charsetFromContentType", () => {
  it("extracts the charset parameter", () => {
    expect(charsetFromContentType(LATIN1_HEADER)).toBe("iso-8859-1");
    expect(charsetFromContentType('text/html; charset="Shift_JIS"; boundary=x')).toBe("shift_jis");
  });

  it("returns null when absent", () => {
    expect(charsetFromContentType("text/html")).toBeNull();
    expect(charsetFromContentType(null)).toBeNull();
    expect(charsetFromContentType(undefined)).toBeNull();
  });
});

describe("decodeBody", () => {
  it("decodes an ISO-8859-1 body declared by the Content-Type header", () => {
    const text = decodeBody(latin1Bytes(), LATIN1_HEADER);
    expect(text).toContain('<p class="price">£51.77</p>');
    expect(text).toContain("Café Crème");
  });

  it("proves naive UTF-8 decoding of the same bytes is mojibake", () => {
    const naive = new TextDecoder("utf-8").decode(latin1Bytes());
    expect(naive).not.toContain("£51.77");
    expect(naive).toContain("�"); // U+FFFD — the 0xA3 byte is invalid UTF-8
    expect(decodeBody(latin1Bytes(), LATIN1_HEADER)).toContain("£51.77");
  });

  it("sniffs the <meta charset> when the header carries none", () => {
    expect(decodeBody(latin1Bytes(), null)).toContain("£51.77");
    expect(decodeBody(latin1Bytes(), "text/html")).toContain("Café Crème");
  });

  it("prefers the header over the meta declaration", () => {
    // The document declares iso-8859-1 in a meta tag; the header says UTF-8.
    const text = decodeBody(latin1Bytes(), UTF8_HEADER);
    expect(text).toContain("�");
    expect(text).not.toContain("£51.77");
  });

  it("strips a UTF-8 BOM", () => {
    const withBom = Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8("<p>café</p>")]);
    const text = decodeBody(withBom, null);
    expect(text.startsWith("\uFEFF")).toBe(false);
    expect(text).toBe("<p>café</p>");
  });

  it("lets a BOM win over a bogus header charset", () => {
    const withBom = Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8("<p>ok</p>")]);
    expect(decodeBody(withBom, LATIN1_HEADER)).toBe("<p>ok</p>");
  });

  it("decodes UTF-16 by BOM", () => {
    // "<p>x" encoded as UTF-16LE and UTF-16BE.
    const le = Uint8Array.from([0xff, 0xfe, 0x3c, 0x00, 0x70, 0x00, 0x3e, 0x00, 0x78, 0x00]);
    const be = Uint8Array.from([0xfe, 0xff, 0x00, 0x3c, 0x00, 0x70, 0x00, 0x3e, 0x00, 0x78]);
    expect(decodeBody(le, null)).toBe("<p>x");
    expect(decodeBody(be, null)).toBe("<p>x");
  });

  it("decodes UTF-16 declared by the header when there is no BOM", () => {
    const le = Uint8Array.from([0x3c, 0x00, 0x70, 0x00, 0x3e, 0x00, 0x78, 0x00]);
    const be = Uint8Array.from([0x00, 0x3c, 0x00, 0x70, 0x00, 0x3e, 0x00, 0x78]);
    expect(decodeBody(le, "text/html; charset=utf-16le")).toBe("<p>x");
    expect(decodeBody(be, "text/html; charset=utf-16be")).toBe("<p>x");
  });

  it("strips a UTF-32 BOM instead of decoding it as UTF-16", () => {
    // UTF-32 is not in the WHATWG standard and Node has no decoder for it: the BOM is
    // removed so the body cannot masquerade as UTF-16 and emit leading NULs.
    const le = Uint8Array.from([0xff, 0xfe, 0x00, 0x00, 0x3c, 0x00, 0x00, 0x00]);
    const text = decodeBody(le, null);
    expect(text.startsWith("\u0000")).toBe(false);
    expect(decodeBody(le, LATIN1_HEADER)).toBe(text);
  });

  it("accepts a missing contentType argument", () => {
    expect(decodeBody(utf8("<p>ok</p>"))).toBe("<p>ok</p>");
    expect(decodeBody(latin1Bytes())).toContain("£51.77");
  });

  it("falls back to UTF-8 for a bogus charset label instead of throwing", () => {
    const text = decodeBody(utf8("<p>£10 café</p>"), "text/html; charset=wtf-8");
    expect(text).toBe("<p>£10 café</p>");
  });

  it("falls back to UTF-8 for a label Node does not know", () => {
    expect(decodeBody(utf8("plain"), "text/html; charset=x-bogus-42")).toBe("plain");
  });

  it("returns an empty string for an empty body", () => {
    expect(decodeBody(new Uint8Array(), LATIN1_HEADER)).toBe("");
    expect(decodeBody(new Uint8Array(), null)).toBe("");
  });

  it("returns an empty string for a BOM-only body", () => {
    expect(decodeBody(Uint8Array.from([0xef, 0xbb, 0xbf]), null)).toBe("");
  });

  it("round-trips an ordinary UTF-8 document unchanged", () => {
    const html = readFixture("product-detail.html");
    expect(decodeBody(utf8(html), UTF8_HEADER)).toBe(html);
  });
});
