/**
 * crawlio — simple, typed web scraping for static HTML.
 *
 * @packageDocumentation
 */

export { charsetFromContentType, decodeBody, sniffCharset } from "./charset.js";
export type { ScrapeErrorCode, ScrapeErrorOptions } from "./errors.js";
export {
  ConfigError,
  FetchError,
  HttpError,
  ParseError,
  RobotsError,
  ScrapeError,
  TimeoutError,
} from "./errors.js";
export { extract, extractAll } from "./extract.js";
export { DEFAULT_RETRIES, DEFAULT_TIMEOUT, DEFAULT_USER_AGENT, fetchHtmlOnce } from "./fetch.js";
export { parseHtml } from "./parse.js";
export type { RobotsAgent } from "./robots.js";
export { fetchRobotsTxt, parseRobots, robotsAllowed, robotsUrlFor } from "./robots.js";
export {
  createScraper,
  fetchHtml,
  scrape,
  scrape as scrapeUrl,
  scrapeAll,
  scrapeMany,
  scrapeManySafe,
} from "./scraper.js";
export type {
  CaptchaChallenge,
  CaptchaSolution,
  CaptchaSolver,
  ExtractOptions,
  ExtractResult,
  FetchHtmlOptions,
  FetchHtmlResult,
  FieldSpec,
  FieldSpecRecord,
  FieldValue,
  ParseOptions,
  RequestDelay,
  ScrapeBatchItem,
  ScrapeOptions,
  Scraper,
  ScraperOptions,
  StealthOptions,
} from "./types.js";
export { VERSION } from "./version.js";
