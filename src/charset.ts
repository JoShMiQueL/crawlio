/**
 * Charset detection and decoding — built on Node's WHATWG `TextDecoder`, zero
 * dependencies. `TextDecoder` already implements the whole WHATWG encoding set
 * (ISO-8859-1, windows-1252, Shift_JIS, GBK, Big5, UTF-16, …), so there is no
 * reason to pull in a charset library.
 */

/** Number of leading bytes inspected when sniffing a `<meta charset>`. */
const SNIFF_BYTES = 1024;

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const UTF16LE_BOM = [0xff, 0xfe] as const;
const UTF16BE_BOM = [0xfe, 0xff] as const;
/**
 * UTF-32LE and UTF-32BE share their first two bytes with UTF-16, so they must be
 * tested first or they would decode as garbage. Neither encoding exists in the WHATWG
 * standard any more and Node's `TextDecoder` has no label for them: we strip the BOM
 * and fall back to UTF-8 rather than emit a stream of NULs.
 */
const UTF32LE_BOM = [0xff, 0xfe, 0x00, 0x00] as const;
const UTF32BE_BOM = [0x00, 0x00, 0xfe, 0xff] as const;

/** Matches `charset=` in a `Content-Type` header value, quoted or bare. */
const CONTENT_TYPE_CHARSET_RE = /(?:^|;)\s*charset\s*=\s*"?\s*([^\s;"']+)/i;

/** Same, applied to the `content` value of a `<meta http-equiv="Content-Type">`. */
const META_CONTENT_CHARSET_RE = CONTENT_TYPE_CHARSET_RE;

/** Decodes bytes as latin1 — lossless for the ASCII range, which is all we sniff. */
const LATIN1 = new TextDecoder("latin1");

/**
 * `<script>`/`<style>` content and comments are raw text, not markup: a `<meta …>`
 * appearing inside them must never be read as a real declaration.
 *
 * The `$` alternative handles an element that is never closed inside the sniff
 * window: everything after it is still raw text, so it is dropped as well.
 */
const RAW_TEXT_RE = /<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)|<!--[\s\S]*?(?:-->|$)/giu;

/** `<meta` followed by a delimiter — `<metadata …>` must not match. */
const META_OPEN_RE = /<meta(?=[\s/>])/giu;

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, i) => bytes[i] === byte);
}

function normalizeLabel(label: string | undefined | null): string | null {
  const trimmed = label?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/**
 * Pull the charset out of a `Content-Type` header value.
 *
 * @param contentType Raw header value, or `null`/absent.
 * @returns The lowercased charset label, or `null` when the header carries none.
 */
export function charsetFromContentType(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  return normalizeLabel(CONTENT_TYPE_CHARSET_RE.exec(contentType)?.[1]);
}

/**
 * Read the attributes of the `<meta>` element whose tag starts at `start`.
 *
 * A hand-rolled scanner rather than a regex, because attribute values may be
 * unquoted, may appear in any order, and may legitimately contain `>`
 * (`content="a > b; charset=big5"`). Duplicated attributes keep the first value, as
 * the HTML tokenizer does.
 *
 * @returns Lower-cased attribute names mapped to raw values.
 */
function readMetaAttributes(markup: string, start: number): Map<string, string> {
  const attributes = new Map<string, string>();
  let i = start;
  while (i < markup.length) {
    while (i < markup.length && /[\s/]/u.test(markup[i] as string)) i += 1;
    if (markup[i] === ">") return attributes;

    let name = "";
    while (i < markup.length && !/[\s/>=]/u.test(markup[i] as string))
      name += markup[i++] as string;
    if (name === "") {
      i += 1; // Unexpected character — skip it rather than spinning.
      continue;
    }

    let cursor = i;
    while (cursor < markup.length && /\s/u.test(markup[cursor] as string)) cursor += 1;
    let value = "";
    if (markup[cursor] === "=") {
      cursor += 1;
      while (cursor < markup.length && /\s/u.test(markup[cursor] as string)) cursor += 1;
      const quote = markup[cursor];
      if (quote === '"' || quote === "'") {
        cursor += 1;
        while (cursor < markup.length && markup[cursor] !== quote) {
          value += markup[cursor++] as string;
        }
        cursor += 1;
      } else {
        // Unquoted value: ends at whitespace, `>` or `/`. The HTML tokenizer would
        // keep the `/` of an XHTML-style `<meta charset=utf-8/>`, but this scanner only
        // ever reads `<meta>` attributes (charset/content/http-equiv/name — never URLs),
        // so treating `/` as a terminator is safe and returns the real label.
        while (cursor < markup.length && !/[\s/>]/u.test(markup[cursor] as string)) {
          value += markup[cursor++] as string;
        }
      }
      i = cursor;
    }
    // HTML: the FIRST occurrence of a duplicated attribute wins.
    const key = name.toLowerCase();
    if (!attributes.has(key)) attributes.set(key, value);
  }
  return attributes;
}

/**
 * Sniff a charset declaration from the first {@link SNIFF_BYTES} bytes of a document.
 *
 * The bytes are decoded as latin1 first — ASCII is a subset of latin1, so this is
 * lossless for the markup we scan, and it never throws on invalid UTF-8.
 *
 * Only two forms are honoured, matching the HTML standard:
 * a) a `charset` attribute on a real `<meta>` element (unquoted or quoted, any
 *    attribute order);
 * b) a `charset=` inside the `content` value of `<meta http-equiv="Content-Type">`.
 *
 * Prose that merely mentions `charset=` (`<meta name="description" content="Set
 * charset=utf-8 in your head">`) is not a declaration and is ignored.
 *
 * @param bytes Raw document bytes (only the first 1024 are inspected).
 * @returns The lowercased charset label, or `null` when no declaration is present.
 */
export function sniffCharset(bytes: Uint8Array): string | null {
  const head = bytes.subarray(0, SNIFF_BYTES);
  if (head.length === 0) return null;
  const scannable = LATIN1.decode(head).replace(RAW_TEXT_RE, "");

  for (const match of scannable.matchAll(META_OPEN_RE)) {
    const attributes = readMetaAttributes(scannable, (match.index ?? 0) + "<meta".length);

    const direct = normalizeLabel(attributes.get("charset"));
    if (direct !== null) return direct;

    const httpEquiv = attributes.get("http-equiv")?.trim().toLowerCase();
    if (httpEquiv === "content-type") {
      const declared = normalizeLabel(
        META_CONTENT_CHARSET_RE.exec(attributes.get("content") ?? "")?.[1],
      );
      if (declared !== null) return declared;
    }
  }
  return null;
}

/**
 * Decode a response body to a string.
 *
 * Resolution order:
 * 1. A BOM always wins — a BOM is proof of the actual encoding, whereas headers and
 *    `<meta>` declarations are frequently lying.
 * 2. The `charset` parameter of the `Content-Type` header.
 * 3. A `<meta charset>` / `<meta http-equiv="Content-Type" … charset=…>` declaration
 *    sniffed from the first 1024 bytes.
 * 4. UTF-8.
 *
 * An unknown label (`charset=wtf-8`) makes `new TextDecoder(label)` throw a
 * `RangeError`; that is caught and the body is decoded as UTF-8 instead. A scraper
 * must never crash because a server sent a bogus charset.
 *
 * @param bytes Raw response body.
 * @param contentType Raw `Content-Type` header value, or `null` when there was none.
 * @returns The decoded text. An empty body decodes to `""`.
 */
export function decodeBody(bytes: Uint8Array, contentType?: string | null): string {
  if (bytes.length === 0) return "";

  let body = bytes;
  let label: string | null = null;

  if (startsWith(bytes, UTF8_BOM)) {
    body = bytes.subarray(UTF8_BOM.length);
    label = "utf-8";
  } else if (startsWith(bytes, UTF32LE_BOM) || startsWith(bytes, UTF32BE_BOM)) {
    body = bytes.subarray(4);
    label = null; // Unsupported encoding — see UTF32LE_BOM.
  } else if (startsWith(bytes, UTF16LE_BOM)) {
    body = bytes.subarray(UTF16LE_BOM.length);
    label = "utf-16le";
  } else if (startsWith(bytes, UTF16BE_BOM)) {
    body = bytes.subarray(UTF16BE_BOM.length);
    label = "utf-16be";
  } else {
    label = charsetFromContentType(contentType) ?? sniffCharset(body);
  }

  return createDecoder(label).decode(body);
}

/**
 * Build a `TextDecoder` for `label`, falling back to UTF-8 for labels Node does not
 * know. `null` means "no declaration, assume UTF-8".
 */
function createDecoder(label: string | null): TextDecoder {
  if (label === null) return new TextDecoder();
  try {
    return new TextDecoder(label);
  } catch {
    return new TextDecoder();
  }
}
