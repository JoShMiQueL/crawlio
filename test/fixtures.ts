import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Absolute path of a recorded HTML fixture under `test/fixtures/`. */
export function fixturePath(name: string): string {
  return join(import.meta.dirname, "fixtures", name);
}

/** Read a recorded HTML fixture as text (UTF-8 decoding — see `latin1.html`). */
export function readFixture(name: string): string {
  return readFileSync(fixturePath(name), "utf8");
}

/** Read a recorded HTML fixture as raw bytes, exactly as it arrived over the wire. */
export function readFixtureBytes(name: string): Uint8Array {
  return readFileSync(fixturePath(name));
}
