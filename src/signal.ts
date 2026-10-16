/**
 * Fuse an internal abort signal with an optional external (caller-supplied) one:
 * whichever fires first wins.
 *
 * `AbortSignal.any` is used when present (Node 22 has it); a manual controller
 * is the fallback so neither signal is silently dropped. The fallback attaches
 * `{ once: true }` listeners to BOTH inputs — a long-lived caller signal reused
 * across many requests would otherwise accumulate them until Node emits
 * `MaxListenersExceededWarning`. Call {@link FusedSignal.release} in a `finally`
 * once the fused signal is no longer needed to remove the fallback listeners.
 */
export interface FusedSignal {
  /** The signal to hand to `fetch`. */
  readonly signal: AbortSignal;
  /** Remove any listeners the manual fallback installed. Safe to call always. */
  release(): void;
}

export function fuseSignal(internal: AbortSignal, external: AbortSignal | undefined): FusedSignal {
  if (external === undefined) {
    return { signal: internal, release: () => undefined };
  }
  if (internal.aborted) {
    // Already aborted — the internal signal IS the fused one; nothing to clean up.
    // (AbortSignal.any handles this itself, but the manual fallback below would
    // silently produce a never-aborting signal without this guard.)
    return { signal: internal, release: () => undefined };
  }
  type AnyCapable = { any?: (signals: AbortSignal[]) => AbortSignal };
  const anyFn = (AbortSignal as AnyCapable).any;
  if (typeof anyFn === "function") {
    // `AbortSignal.any` manages its own listeners and releases them when the
    // composed signal aborts — no manual cleanup needed.
    return { signal: anyFn.call(AbortSignal, [internal, external]), release: () => undefined };
  }
  if (external.aborted) {
    // Already aborted — the external signal IS the fused one; nothing to clean up.
    return { signal: external, release: () => undefined };
  }
  const controller = new AbortController();
  const onInternal = (): void => {
    if (!controller.signal.aborted) controller.abort(internal.reason);
  };
  const onExternal = (): void => {
    if (!controller.signal.aborted) controller.abort(external.reason);
  };
  internal.addEventListener("abort", onInternal, { once: true });
  external.addEventListener("abort", onExternal, { once: true });
  const release = (): void => {
    internal.removeEventListener("abort", onInternal);
    external.removeEventListener("abort", onExternal);
  };
  return { signal: controller.signal, release };
}
