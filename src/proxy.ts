import { ProxyAgent } from "undici";
import { ConfigError, scrubUrl } from "./errors.js";
import { isBun } from "./runtime.js";
import type { ProxyRotation } from "./types.js";

type FetchImpl = typeof globalThis.fetch;

/**
 * Builds the fetch implementation that serves requests through `proxyUrl`.
 * The default wraps the global `fetch` with the runtime's proxy mechanism
 * (see {@link proxyRequestInit}); tests inject stubs here so all
 * rotation/health logic runs without network.
 */
export type ProxyFetchFactory = (proxyUrl: string) => FetchImpl;

/**
 * The one runtime-dependent branch in proxying: extend `init` so the
 * request exits through `proxyUrl`. Under Bun, `fetch` takes a `proxy`
 * URL string natively (per-request, credentials in the URL exactly like
 * the `proxies` config already passes them); under Node there is no such
 * option, so an undici `dispatcher` does the routing. Neither key is part
 * of the standard `RequestInit` — both are runtime extensions, hence the
 * cast. Exported for tests: `bun` is injectable so BOTH lanes are
 * verifiable on either runtime.
 */
export function proxyRequestInit(
  init: RequestInit | undefined,
  proxyUrl: string,
  options: { dispatcher?: ProxyAgent; bun?: boolean } = {},
): RequestInit {
  if (options.bun ?? isBun) {
    return { ...init, proxy: proxyUrl } as RequestInit;
  }
  return { ...init, dispatcher: options.dispatcher } as RequestInit;
}

/**
 * Options for {@link ProxyPool}.
 *
 * `fetchFactory`, `now`, `banThreshold` and `cooldownMs` exist so every piece
 * of rotation/health behaviour is deterministic in tests; production callers
 * should only ever set `proxies` and `rotation`.
 */
export interface ProxyPoolOptions {
  /**
   * Proxy URLs, `http://[user:pass@]host:port` (https proxies accepted).
   * Credentials live ONLY in the URL — typically composed from environment
   * variables — and are never logged; every error message scrubs them via
   * `scrubUrl`. SOCKS schemes (`socks:`/`socks4:`/`socks5:`/…) are rejected
   * in v1 — undici's `ProxyAgent` can drive SOCKS natively, but enabling it
   * needs real SOCKS-server coverage first. Inject a SOCKS-capable client
   * via the `fetch` option instead.
   */
  proxies: readonly string[];
  /** Rotation strategy — see {@link ProxyRotation}. Default `"per-origin"`. */
  rotation?: ProxyRotation;
  /**
   * Builds the per-proxy fetch. Default: `fetch` + native `proxy` under
   * Bun, undici `ProxyAgent` dispatcher under Node (see
   * {@link proxyRequestInit}).
   */
  fetchFactory?: ProxyFetchFactory;
  /** Monotonic clock for cooldown bookkeeping. Default `performance.now`. */
  now?: () => number;
  /** Consecutive ban signals before a proxy is quarantined. Default `3`. */
  banThreshold?: number;
  /** Quarantine duration in milliseconds. Default `300_000` (5 minutes). */
  cooldownMs?: number;
}

/**
 * Statuses that read as the proxy — not the target — being refused: auth
 * demanded of the proxy itself, a hard block, or explicit rate-limiting.
 * (503 is deliberately absent: an unmarked 503 is a target failure, not a
 * ban — 503 challenge pages are caught by `reportBan` + challenge detection.)
 */
const BAN_STATUSES: ReadonlySet<number> = new Set([407, 403, 429]);

/**
 * `proxy`/`proxies` + an injected `fetch` is always a config error — shared
 * by every level that can raise it (pool consumers validate their own layer).
 */
export const PROXY_FETCH_CONFLICT =
  "`proxy`/`proxies` cannot be combined with an injected `fetch` — a custom fetch cannot be routed through a proxy dispatcher; pass a proxy-aware `fetch` (e.g. built on undici's ProxyAgent) instead";

/** Consecutive ban signals before a proxy is quarantined. */
const DEFAULT_BAN_THRESHOLD = 3;
/** How long a quarantined proxy is skipped, in milliseconds. */
const DEFAULT_COOLDOWN_MS = 300_000;
/** The legal {@link ProxyRotation} values, for runtime validation. */
const ROTATIONS: ReadonlySet<ProxyRotation> = new Set(["per-origin", "per-request", "on-ban"]);

interface ProxyState {
  /** The proxy URL as configured (credentials may be embedded — never log it). */
  url: string;
  consecutiveFailures: number;
  /** `now()` timestamp at which the quarantine lifts; 0 when not cooling. */
  cooldownUntil: number;
}

/**
 * Attribution record for the most recent request served on an origin:
 * `reportBan` uses it to charge ban signals only the caller can see (a
 * detected challenge page) to the proxy that actually served, and `banned`
 * makes that report idempotent against the pool's own status/transport
 * recording of the same response.
 */
interface ServeRecord {
  proxyUrl: string;
  banned: boolean;
}

/**
 * A {@link ProxyFetchFactory} that can release its resources — only the
 * default factory carries this: undici `ProxyAgent`s hold sockets open, so a
 * pool being discarded should close them. Custom factories own their own
 * resource lifecycle.
 */
interface CloseableFetchFactory extends ProxyFetchFactory {
  /** Close every dispatcher the factory created. */
  close(): Promise<void>;
}

/**
 * The default {@link ProxyFetchFactory}: `fetch` routed through the
 * proxy — natively via the `proxy` option under Bun, through an undici
 * {@link ProxyAgent} (one agent cached per proxy URL) under Node. See
 * {@link proxyRequestInit} for the shared init seam.
 */
function defaultFetchFactory(): CloseableFetchFactory {
  const agents = new Map<string, ProxyAgent>();
  const dispatcherFor = (proxyUrl: string): ProxyAgent => {
    let agent = agents.get(proxyUrl);
    if (agent === undefined) {
      agent = new ProxyAgent(proxyUrl);
      agents.set(proxyUrl, agent);
    }
    return agent;
  };
  return Object.assign(
    (proxyUrl: string): FetchImpl => {
      // Resolve the runtime once per binding: under Bun no `ProxyAgent`
      // is ever allocated — the native `proxy` option owns the routing
      // and its sockets.
      const dispatcher = isBun ? undefined : dispatcherFor(proxyUrl);
      return ((input: Parameters<FetchImpl>[0], init?: RequestInit) =>
        fetch(input, proxyRequestInit(init, proxyUrl, { dispatcher }))) as FetchImpl;
    },
    {
      close: async (): Promise<void> => {
        // Clear first: a pool still used after close() recreates fresh
        // agents lazily rather than re-serving closed ones. (Under Bun
        // the map stays empty — native `proxy` holds no dispatchers.)
        const cached = [...agents.values()];
        agents.clear();
        await Promise.all(cached.map((agent) => agent.close()));
      },
    },
  );
}

/**
 * Routes requests through a pool of proxies and tracks their health.
 *
 * One pool is held per scraper when `proxies` is configured at instance level
 * (bindings and health survive across calls); a per-call `proxies` override
 * builds a fresh, stateless pool for that request.
 *
 * Rotation semantics (see {@link ProxyRotation}):
 * - `per-origin` — each target origin binds to one proxy on first touch and
 *   keeps it: session/cookie consistency (a `cf_clearance` is bound to the
 *   issuing IP) outweighs reacting to proxy failures.
 * - `per-request` — round-robin on every wire request. Breaks session
 *   consistency; useful only for stateless fan-out.
 * - `on-ban` — `per-origin` plus health: the origin's proxy is reassigned on
 *   ban signals (transport failure, HTTP 407/403/429, a detected challenge
 *   page via {@link ProxyPool.reportBan}, or a timeout reported by the
 *   scraper).
 *
 * Health: a proxy accumulating {@link ProxyPoolOptions.banThreshold}
 * consecutive ban signals is quarantined for `cooldownMs` and skipped at
 * selection time. If every proxy is quarantined, the earliest-expiring one
 * serves anyway — a fully dead pool still tries, silently (proxy URLs may
 * carry credentials, so nothing about selection is ever logged).
 */
export class ProxyPool {
  private readonly states: ProxyState[];
  private readonly stateByUrl: Map<string, ProxyState>;
  private readonly rotation: ProxyRotation;
  private readonly fetchFactory: ProxyFetchFactory;
  private readonly now: () => number;
  private readonly banThreshold: number;
  private readonly cooldownMs: number;
  /** Round-robin cursor — index of the next proxy to try. */
  private cursor = 0;
  /**
   * Origin → bound proxy (`per-origin`/`on-ban`). Like the scraper's own
   * per-origin maps this grows by one entry per origin seen and is never
   * evicted — acceptable for v1.
   */
  private readonly boundByOrigin = new Map<string, string>();
  private readonly currentByOrigin = new Map<string, ServeRecord>();
  /**
   * Origin → stable fetch wrapper. Stability matters: the scraper keys its
   * robots.txt cache on fetch identity, so one wrapper per origin keeps that
   * cache coherent while rotation still happens inside the wrapper.
   */
  private readonly implByOrigin = new Map<string, FetchImpl>();
  /** Releases the default factory's dispatchers; unset for custom factories. */
  private readonly closeAgents?: () => Promise<void>;

  constructor(options: ProxyPoolOptions) {
    if (!Array.isArray(options.proxies) || options.proxies.length === 0) {
      throw new ConfigError("`proxies` must be a non-empty array of proxy URLs");
    }
    const rotation = options.rotation ?? "per-origin";
    if (!ROTATIONS.has(rotation)) {
      throw new ConfigError(
        `\`proxyRotation\` must be one of "per-origin" | "per-request" | "on-ban", got ${String(
          rotation,
        )}`,
      );
    }
    this.rotation = rotation;
    // Duplicate entries are collapsed: health state is keyed by URL
    // (`stateByUrl` last-wins while `states` iterates every entry), so a
    // repeated proxy URL would otherwise corrupt failure tracking.
    this.states = [...new Set(options.proxies)].map((raw) => {
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch (cause) {
        throw new ConfigError(`Invalid proxy URL ${scrubUrl(String(raw))}`, { cause });
      }
      if (parsed.protocol.startsWith("socks")) {
        throw new ConfigError(
          `SOCKS proxies are not supported in v1 (${scrubUrl(raw)}) — inject a SOCKS-capable client via \`fetch\` instead (\`fetch\` and \`proxy\`/\`proxies\` cannot be combined)`,
        );
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new ConfigError(
          `\`proxy\`/\`proxies\` only support http(s) proxy URLs, got ${scrubUrl(raw)}`,
        );
      }
      return { url: raw, consecutiveFailures: 0, cooldownUntil: 0 };
    });
    this.stateByUrl = new Map(this.states.map((state) => [state.url, state]));
    if (options.fetchFactory === undefined) {
      const factory = defaultFetchFactory();
      this.fetchFactory = factory;
      this.closeAgents = () => factory.close();
    } else {
      // A custom factory owns its own resources — `close()` is then a no-op.
      this.fetchFactory = options.fetchFactory;
    }
    this.now = options.now ?? (() => performance.now());
    this.banThreshold = options.banThreshold ?? DEFAULT_BAN_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  /**
   * The fetch implementation that serves `origin` through the pool. The
   * returned wrapper is stable per origin (so fetch-identity caches like
   * robots.txt stay coherent); rotation is evaluated inside it on every wire
   * request, and transport failures plus ban statuses are recorded where the
   * proxy that served is known for certain.
   */
  fetchFor(origin: string): FetchImpl {
    let impl = this.implByOrigin.get(origin);
    if (impl === undefined) {
      impl = (async (input: Parameters<FetchImpl>[0], init?: RequestInit): Promise<Response> => {
        const proxyUrl = this.pickFor(origin);
        const serve: ServeRecord = { proxyUrl, banned: false };
        this.currentByOrigin.set(origin, serve);
        try {
          const response = await this.fetchFactory(proxyUrl)(input, init);
          if (BAN_STATUSES.has(response.status)) {
            serve.banned = true;
            this.recordBan(origin, proxyUrl);
          } else if (response.ok) {
            // Only a clean response clears the streak. A non-OK status that
            // is not a ban signal (404, 5xx — including 503 challenge pages)
            // says nothing about proxy health, and a challenge would
            // otherwise reset the streak moments before the scraper's
            // reportBan charges the same response.
            this.recordSuccess(proxyUrl);
          }
          return response;
        } catch (cause) {
          // AbortError is the caller's timeout/abort racing in: a deliberate
          // abort must never penalize a proxy, and the timeout case is
          // reported by the scraper as a TimeoutError — it can tell the two
          // apart, this layer cannot.
          if (!(cause instanceof DOMException && cause.name === "AbortError")) {
            serve.banned = true;
            this.recordBan(origin, proxyUrl);
          }
          throw cause;
        }
      }) as FetchImpl;
      this.implByOrigin.set(origin, impl);
    }
    return impl;
  }

  /**
   * Charge a ban signal to the proxy that last served `origin` — for signals
   * only visible above the fetch layer (a detected challenge page, a
   * timeout). Idempotent per served request: a 403 challenge already counted
   * by the status path is not double-charged.
   *
   * Under concurrent same-origin requests (`serializePerOrigin: false`) the
   * attribution is to the MOST RECENT serve — exact for the bound rotations
   * (both requests ride the same proxy) and best-effort for `per-request`.
   */
  reportBan(origin: string): void {
    const serve = this.currentByOrigin.get(origin);
    if (serve === undefined || serve.banned) return;
    serve.banned = true;
    this.recordBan(origin, serve.proxyUrl);
  }

  /**
   * Close every dispatcher the pool created (one undici `ProxyAgent` per
   * proxy URL served so far — none under Bun, where routing is native).
   * With a custom
   * {@link ProxyPoolOptions.fetchFactory} this is a no-op — the factory owns
   * its own resources. The pool stays usable afterwards: agents are
   * recreated lazily on the next request.
   *
   * Coverage is partial in v1: `createScraper` exposes no disposal hook and
   * the stateless pools built per call inside `fetchHtmlOnce` are
   * unreachable, so both rely on undici's idle-timeout cleanup. Direct
   * `ProxyPool` users should call `close()` when done with the pool.
   */
  async close(): Promise<void> {
    await this.closeAgents?.();
  }

  /** Resolve which proxy serves this request. */
  private pickFor(origin: string): string {
    if (this.rotation === "per-request") return this.pickHealthy();
    const bound = this.boundByOrigin.get(origin);
    if (bound !== undefined) {
      // per-origin: the binding is sticky even across the proxy's own
      // cooldown — session consistency is the entire point of the mode.
      if (this.rotation === "per-origin") return bound;
      // on-ban: a quarantined binding is re-resolved — an origin never rides
      // a cooled proxy.
      if (!this.isCoolingDown(bound)) return bound;
      const next = this.pickHealthy(bound);
      this.boundByOrigin.set(origin, next);
      return next;
    }
    const chosen = this.pickHealthy();
    this.boundByOrigin.set(origin, chosen);
    return chosen;
  }

  /**
   * Round-robin over the pool, skipping quarantined proxies (and `exclude`,
   * the proxy that just failed, when others remain). Everything quarantined
   * → the earliest-expiring proxy serves; a single excluded proxy → itself.
   */
  private pickHealthy(exclude?: string): string {
    const now = this.now();
    const count = this.states.length;
    for (let i = 0; i < count; i++) {
      const index = (this.cursor + i) % count;
      const state = this.states[index];
      if (state === undefined || state.url === exclude) continue;
      if (state.cooldownUntil > now) continue;
      this.cursor = index + 1;
      return state.url;
    }
    let bestIndex = -1;
    let best: ProxyState | undefined;
    for (let i = 0; i < count; i++) {
      const state = this.states[i];
      if (state === undefined || state.url === exclude) continue;
      if (best === undefined || state.cooldownUntil < best.cooldownUntil) {
        best = state;
        bestIndex = i;
      }
    }
    if (best !== undefined) {
      this.cursor = bestIndex + 1;
      return best.url;
    }
    // Every proxy was excluded — a single-proxy pool serves itself anyway.
    if (exclude !== undefined) return exclude;
    const first = this.states[0];
    // Unreachable by constructor contract — kept for the type checker.
    if (first === undefined) {
      throw new ConfigError("`proxies` must be a non-empty array of proxy URLs");
    }
    return first.url;
  }

  private isCoolingDown(proxyUrl: string): boolean {
    const state = this.stateByUrl.get(proxyUrl);
    return state !== undefined && state.cooldownUntil > this.now();
  }

  /**
   * One more consecutive failure for `proxyUrl` (quarantining it at the
   * threshold) and — under `on-ban` — an immediate reassignment for `origin`
   * to a different healthy proxy.
   */
  private recordBan(origin: string, proxyUrl: string): void {
    const state = this.stateByUrl.get(proxyUrl);
    if (state === undefined) return;
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= this.banThreshold) {
      state.cooldownUntil = this.now() + this.cooldownMs;
    }
    if (this.rotation === "on-ban" && this.boundByOrigin.get(origin) === proxyUrl) {
      this.boundByOrigin.set(origin, this.pickHealthy(proxyUrl));
    }
  }

  /**
   * A clean response through `proxyUrl`: reset its failure streak and lift
   * any cooldown early — a proxy that just served successfully is healthy
   * (it can only have served while quarantined via the all-cooled fallback).
   */
  private recordSuccess(proxyUrl: string): void {
    const state = this.stateByUrl.get(proxyUrl);
    if (state === undefined) return;
    state.consecutiveFailures = 0;
    state.cooldownUntil = 0;
  }
}
