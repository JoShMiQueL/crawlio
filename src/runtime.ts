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

    /** What `Bun.serve` returns — the running HTTP server handle. */
    interface Server {
      /** The bound port — an ephemeral `port: 0` input resolves to the real one. */
      port: number;
      /**
       * Stop accepting connections; `closeActiveConnections` also drops
       * sockets already open (long-lived SSE streams would otherwise keep
       * the server — and the process — alive).
       */
      stop(closeActiveConnections?: boolean): Promise<void>;
    }

    /** The `Bun.serve` options crawlio consumes — a fetch-style handler. */
    interface ServeOptions {
      port?: number;
      hostname?: string;
      fetch(req: Request): Response | Promise<Response>;
    }

    /** The fetch-style HTTP server — the dual-runtime swap for `node:http`. */
    function serve(options: ServeOptions): Server;

    /** Constructor options for {@link FetchSession}. */
    interface FetchSessionOptions {
      /**
       * Proxy URL every request on the session exits through — same
       * credentials-in-URL convention as the `proxy` fetch option.
       */
      proxy?: string;
    }

    /**
     * A pooled HTTP client session (Bun ≥1.4.3): a dedicated
     * keep-alive/TLS/proxy connection pool with an explicit `close()` —
     * the Bun-side counterpart of a per-URL undici `ProxyAgent` (proxy.ts).
     */
    class FetchSession {
      constructor(options?: FetchSessionOptions);
      fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
      /** Drain the session's pools; a later `fetch` reopens them lazily. */
      close(): void;
    }
  }
}

/**
 * `true` under Bun, `false` under Node — the guard every Bun-native
 * branch keys on. `typeof`-guarded because `Bun` does not exist at
 * runtime under Node: the check itself can never throw.
 */
export const isBun: boolean = typeof Bun !== "undefined";
