import type { Cheerio, CheerioAPI } from "cheerio";
import { ConfigError, ParseError } from "./errors.js";
import type { ExtractOptions, ExtractResult, FieldSpec, FieldSpecRecord } from "./types.js";

/**
 * The DOM node type behind a cheerio selection, derived from cheerio's own public
 * types so scrape-sdk never has to reach for `domhandler` directly.
 */
type ScopeNode = ReturnType<CheerioAPI>[number];

/**
 * Attributes whose values are single URLs, and the only ones resolved against
 * {@link ExtractOptions.baseUrl} automatically. Everything else (`content`, `alt`,
 * `title`, `srcset`, `data-*`, …) is returned verbatim unless a field opts in via
 * `FieldSpec.resolve`.
 *
 * `srcset` is deliberately absent even though it looks like a URL attribute: its value
 * is a comma-separated candidate LIST (`"a.jpg 1x, b.jpg 2x"`), which `new URL()`
 * happily turns into a single bogus absolute path. Resolving it as one URL is always
 * wrong, so callers who want that must ask for it with `resolve: true`. No
 * srcset-aware parsing happens here — the raw value is returned.
 */
const URL_ATTRIBUTES: ReadonlySet<string> = new Set([
  "href",
  "src",
  "action",
  "poster",
  "cite",
  "data",
  "formaction",
]);

/** A {@link FieldSpec} after normalisation: the bare-string form is expanded. */
interface NormalizedSpec {
  selector: string;
  attr: string | undefined;
  all: boolean;
  transform: ((raw: string) => unknown) | undefined;
  resolve: boolean | undefined;
}

/** A validated field, ready to be read against any number of scopes. */
interface NormalizedField {
  name: string;
  spec: NormalizedSpec;
}

/** Collapse runs of whitespace and trim, so `'  a\n  b '` yields `'a b'`. */
function collapse(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** Expand and validate every field once, up front. Throws {@link ConfigError}. */
function normalizeFields(fields: FieldSpecRecord): NormalizedField[] {
  if (typeof fields !== "object" || fields === null) {
    throw new ConfigError(`The extraction spec must be an object, got ${typeof fields}`);
  }
  return Object.entries(fields).map(([name, spec]) => ({ name, spec: normalizeSpec(name, spec) }));
}

/** Expand and validate a spec. Throws {@link ConfigError} for a malformed spec. */
function normalizeSpec(field: string, spec: FieldSpec): NormalizedSpec {
  if (typeof spec === "string") {
    return {
      selector: checkSelector(field, spec),
      attr: undefined,
      all: false,
      transform: undefined,
      resolve: undefined,
    };
  }
  if (typeof spec !== "object" || spec === null) {
    throw new ConfigError(
      `Field "${field}" must be a CSS selector string or a field spec object, got ${typeof spec}`,
    );
  }
  return {
    selector: checkSelector(field, spec.selector),
    attr: checkAttr(field, spec.attr),
    all: spec.all === true,
    transform: checkTransform(field, spec.transform),
    resolve: checkResolve(field, spec.resolve),
  };
}

function checkSelector(field: string, selector: unknown): string {
  if (typeof selector !== "string" || selector.trim() === "") {
    throw new ConfigError(`Field "${field}" needs a non-empty CSS selector string`);
  }
  return selector;
}

function checkAttr(field: string, attr: unknown): string | undefined {
  if (attr === undefined) return undefined;
  if (typeof attr !== "string" || attr.trim() === "") {
    throw new ConfigError(`Field "${field}" has an invalid attr: expected a non-empty string`);
  }
  return attr;
}

function checkTransform(field: string, transform: unknown): ((raw: string) => unknown) | undefined {
  if (transform === undefined) return undefined;
  if (typeof transform !== "function") {
    throw new ConfigError(`Field "${field}" has an invalid transform: expected a function`);
  }
  return transform as (raw: string) => unknown;
}

function checkResolve(field: string, resolve: unknown): boolean | undefined {
  if (resolve === undefined) return undefined;
  if (typeof resolve !== "boolean") {
    throw new ConfigError(`Field "${field}" has an invalid resolve: expected a boolean`);
  }
  return resolve;
}

/** Decide whether this field's value should be resolved against `baseUrl`. */
function shouldResolve(spec: NormalizedSpec): boolean {
  if (spec.resolve !== undefined) return spec.resolve;
  return spec.attr !== undefined && URL_ATTRIBUTES.has(spec.attr.toLowerCase());
}

/**
 * Resolve a URL-ish value against `options.baseUrl`.
 *
 * Already-absolute values are returned untouched; a blank value is returned as-is
 * (a whitespace-only `href` must not silently become the base URL); unresolvable
 * values fall back to the raw string rather than throwing — a broken `href` is data,
 * not a crash.
 */
function resolveValue(raw: string, baseUrl: string | URL): string {
  if (raw.trim() === "") return raw;
  if (URL.canParse(raw)) return raw;
  if (!URL.canParse(raw, baseUrl)) return raw;
  return new URL(raw, baseUrl).toString();
}

/**
 * Call the user's transform.
 *
 * The call is always made with exactly one argument: passing a bare function
 * reference to `Array#map` would leak `(value, index, array)` into it, which
 * `tsc` cannot catch (`Number.parseInt` turns "512" into 512 and "8" into NaN).
 *
 * A throw from the callback becomes a {@link ConfigError} naming the field — never
 * the scraped value, which may be sensitive — with the original error as `cause`.
 */
function applyTransform(field: string, transform: (raw: string) => unknown, raw: string): unknown {
  try {
    return transform(raw);
  } catch (cause) {
    throw new ConfigError(`Transform for field "${field}" threw`, { cause });
  }
}

/** Run a selector, turning cheerio's selector-compilation failures into `ScrapeError`s. */
function selectMatches<T extends ScopeNode>(scope: Cheerio<T>, selector: string) {
  try {
    return scope.find(selector);
  } catch (cause) {
    throw new ParseError(`Invalid CSS selector: \`${selector}\``, { cause });
  }
}

/** Read every match in `scope` as a string, applying `attr`, collapsing and base resolution. */
function readValues<T extends ScopeNode>(
  root: CheerioAPI,
  scope: Cheerio<T>,
  field: NormalizedField,
  options: ExtractOptions,
): string[] {
  const { spec } = field;
  const resolve = shouldResolve(spec);
  const baseUrl = options.baseUrl;
  const values: string[] = [];

  selectMatches(scope, spec.selector).each((_index, element) => {
    const node = root(element);
    if (spec.attr !== undefined) {
      const attrValue = node.attr(spec.attr);
      // A missing attribute contributes no value at all.
      if (attrValue === undefined) return;
      values.push(resolve && baseUrl !== undefined ? resolveValue(attrValue, baseUrl) : attrValue);
      return;
    }
    values.push(collapse(node.text()));
  });
  return values;
}

/** Apply one normalised field to a scope, honouring `all` and `transform`. */
function readField<T extends ScopeNode>(
  root: CheerioAPI,
  scope: Cheerio<T>,
  field: NormalizedField,
  options: ExtractOptions,
): unknown {
  const { spec } = field;
  const { transform } = spec;
  const values = readValues(root, scope, field, options);

  if (spec.all) {
    // `all` always produces an array — an empty one when nothing matched.
    if (transform === undefined) return values;
    return values.map((value) => applyTransform(field.name, transform, value));
  }

  const first = values[0];
  // No match: hand back `undefined` and do NOT call the transform.
  if (first === undefined) return undefined;
  if (transform === undefined) return first;
  return applyTransform(field.name, transform, first);
}

function extractRecord<T extends ScopeNode>(
  root: CheerioAPI,
  scope: Cheerio<T>,
  fields: NormalizedField[],
  options: ExtractOptions,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    result[field.name] = readField(root, scope, field, options);
  }
  return result;
}

/**
 * Extract one record from a parsed document.
 *
 * Pure and offline: selectors are resolved within `root` and nothing is fetched.
 *
 * - A bare string spec is shorthand for `{ selector: <string> }`.
 * - Default: first match, text content with runs of whitespace collapsed and
 *   trimmed, or `undefined` when nothing matched. Whitespace-only text collapses to
 *   `""`, which is NOT the same as "no match".
 * - `attr` reads the attribute instead; a missing attribute yields `undefined`, an
 *   empty attribute (`href=""`) yields `""`.
 * - `all: true` returns every match, as an array (empty when none).
 * - `transform` maps the raw string with exactly one argument, and is never called
 *   when there is no match.
 * - `options.baseUrl` resolves relative URL-ish attribute values; see
 *   {@link ExtractOptions.baseUrl} and {@link FieldSpec} `resolve`.
 *
 * Selectors use `.find()` semantics against the document root: they search
 * descendants, so a selector never matches the scope root element itself.
 *
 * @param root A cheerio root from {@link parseHtml}.
 * @param fields The extraction spec.
 * @param options Extraction options.
 * @returns One key per declared field, typed by {@link FieldValue}.
 * @throws {ConfigError} If the spec is malformed, or a `transform` callback throws.
 * @throws {ParseError} If a selector cannot be compiled.
 */
export function extract<S extends FieldSpecRecord>(
  root: CheerioAPI,
  fields: S,
  options: ExtractOptions = {},
): ExtractResult<S> {
  // Normalise once — not per field per scope.
  const normalized = normalizeFields(fields);
  return extractRecord(root, root.root(), normalized, options) as unknown as ExtractResult<S>;
}

/**
 * Extract one record per match of `container`.
 *
 * Each record is extracted strictly INSIDE its container, so field selectors
 * cannot leak in from a sibling container or from the surrounding page. Field
 * selectors use `.find()` semantics, so a selector that matches only the
 * container element itself yields `undefined` — use {@link extract} when you
 * want attributes of the container itself.
 *
 * The spec is validated and normalised once, before the loop: a 10 000-item
 * listing costs 10 000 extractions, not 10 000 × fields validations.
 *
 * @param root A cheerio root from {@link parseHtml}.
 * @param container CSS selector for the repeating element.
 * @param fields The extraction spec, applied within each container.
 * @param options Extraction options.
 * @returns One result per container match, in document order.
 * @throws {ConfigError} If the spec is malformed, or a `transform` callback throws.
 * @throws {ParseError} If a selector cannot be compiled.
 */
export function extractAll<S extends FieldSpecRecord>(
  root: CheerioAPI,
  container: string,
  fields: S,
  options: ExtractOptions = {},
): Array<ExtractResult<S>> {
  if (typeof container !== "string" || container.trim() === "") {
    throw new ConfigError("The container selector must be a non-empty string");
  }
  const normalized = normalizeFields(fields);
  const records: Array<Record<string, unknown>> = [];
  selectMatches(root.root(), container).each((_index, element) => {
    records.push(extractRecord(root, root(element), normalized, options));
  });
  return records as unknown as Array<ExtractResult<S>>;
}
