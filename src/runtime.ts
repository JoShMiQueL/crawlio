/**
 * The dual-runtime seam — the ONLY module allowed to know which runtime
 * crawlio is executing on.
 *
 * The rule (ROADMAP Phase 1): `node:*` APIs are the baseline — Bun
 * implements them, so anything built on them already runs on both
 * runtimes untouched. `Bun.*` APIs go behind {@link isBun} only where
 * they genuinely win: `fetch`'s native `proxy` option replacing undici's
 * dispatcher (see `proxy.ts`) and `Bun.sleep` replacing
 * `setTimeout`-promise sleeps (see `scraper.ts`) are the first.
 *
 * Typing strategy — ambient-minimal, NO `bun-types`/`@types/bun`
 * dependency: the full Bun types inject globals (fetch/RequestInit
 * overloads, timer return types, `process`) that fight `@types/node`
 * inside this single shared compilation, for zero gain at this surface
 * size. The `Bun` namespace below is declared global with ONLY the
 * members the SDK consumes — extend it member-by-member as later phases
 * adopt more `Bun.*` APIs. (`tsconfig.json`'s `"types": ["node"]` would
 * keep `bun-types` out of `tsc` regardless; the declaration here is what
 * actually types the global.)
 */

declare global {
  /**
   * The Bun runtime global, typed ONLY for the surface crawlio consumes.
   * It does not exist at runtime under Node — every read goes through
   * `typeof Bun !== "undefined"` (i.e. {@link isBun}) first; the declared
   * members may then be used without further narrowing.
   */
  // A namespace (not `var`) is the ambient value declaration that keeps
  // `Bun.x` accessible without a `Bun | undefined` union at every call
  // site — the `isBun` branch IS the undefined check.
  namespace Bun {
    /** `setTimeout`-free sleep — the dual-runtime swap for `await`ed delays. */
    function sleep(ms: number): Promise<void>;
  }
}

/**
 * `true` under Bun, `false` under Node — the guard every Bun-native
 * branch keys on. `typeof`-guarded because `Bun` does not exist at
 * runtime under Node: the check itself can never throw.
 */
export const isBun: boolean = typeof Bun !== "undefined";
