/**
 * Shared browser lifecycle for the engine adapters.
 *
 * The underlying browser is a shared, expensive resource: it launches lazily
 * on the first `render` call and is reused across calls, while each render
 * gets its own ephemeral context + page (the adapters own that part). A
 * FAILED launch is not cached, so a later render may retry (e.g. the peer
 * dep got installed). `close` drains a still-in-flight launch and is safe
 * to call before any launch and more than once.
 */
export function lazyBrowser<B extends { close(): Promise<void> }>(
  doLaunch: () => Promise<B>,
): {
  launch(): Promise<B>;
  close(): Promise<void>;
} {
  let browserPromise: Promise<B> | undefined;
  return {
    launch() {
      if (browserPromise !== undefined) return browserPromise;
      const mine = doLaunch().catch((error: unknown) => {
        // Clear only when this attempt is still the tracked one — `close()`
        // may have drained it and a newer launch already taken the slot;
        // clearing unconditionally would orphan that newer browser.
        if (browserPromise === mine) browserPromise = undefined;
        throw error;
      });
      browserPromise = mine;
      return mine;
    },
    async close() {
      const pending = browserPromise;
      browserPromise = undefined;
      if (pending === undefined) return;
      // A still-in-flight launch is closed once it resolves; a rejected
      // launch has nothing to close.
      const browser = await pending.catch(() => undefined);
      await browser?.close();
    },
  };
}
