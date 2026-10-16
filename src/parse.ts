import { type CheerioAPI, load } from "cheerio";
import { ParseError } from "./errors.js";
import type { ParseOptions } from "./types.js";

/**
 * Parse an HTML document into a cheerio root.
 *
 * Pure and offline: this performs no I/O of any kind.
 *
 * Malformed-markup recovery is unconditional. cheerio 1.x dropped the old
 * `parseNoneClosedTags` switch because both of its parsers (parse5 and
 * htmlparser2 v10) now auto-close unclosed tags themselves — which is exactly the
 * safety net scraped HTML needs, since real pages are full of `<li>` without a
 * closing tag.
 *
 * @param html The document markup.
 * @param options Pass-through parser options.
 * @returns A cheerio root bound to the parsed document.
 * @throws {ParseError} If cheerio cannot build a tree from `html`.
 */
export function parseHtml(html: string, options?: ParseOptions): CheerioAPI {
  try {
    return load(html, options);
  } catch (cause) {
    throw new ParseError("Failed to parse HTML document", { cause });
  }
}
