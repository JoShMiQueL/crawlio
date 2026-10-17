/**
 * Shared option validation for the render adapters (`playwright.ts`,
 * `puppeteer.ts`) — the settle options and the `executablePath`/`channel`
 * pair carry identical contracts on both engines, so each {@link
 * ConfigError} site lives here exactly once. Constructor options and
 * per-call `RenderCallOptions` go through the same checks.
 */
import { ConfigError } from "../errors.js";

/**
 * `waitForSelector` must be a non-empty CSS selector when set — a blank one
 * is a {@link ConfigError}, not a silent skip or a raw engine error.
 */
export function assertWaitForSelector(value: string | undefined): void {
  if (value !== undefined && value.trim() === "") {
    throw new ConfigError("`waitForSelector` must be a non-empty CSS selector");
  }
}

/**
 * `waitForTimeout` must be a finite, non-negative number of milliseconds
 * when set — NaN, infinities and negatives are a {@link ConfigError}.
 */
export function assertWaitForTimeout(value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new ConfigError(
      `\`waitForTimeout\` must be a non-negative finite number of milliseconds, got ${JSON.stringify(value)}`,
    );
  }
}

/**
 * `executablePath` and `channel` are mutually exclusive — pointing at a
 * binary AND naming a branded channel at once is a {@link ConfigError}.
 */
export function assertExecutablePathChannelExclusive(
  executablePath: string | undefined,
  channel: string | undefined,
): void {
  if (executablePath !== undefined && channel !== undefined) {
    throw new ConfigError("`executablePath` and `channel` are mutually exclusive — pick one");
  }
}
