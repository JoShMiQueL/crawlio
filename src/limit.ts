/**
 * Concurrency semaphore: `limit(fn)` starts `fn` while fewer than
 * `concurrency` tasks are active, otherwise FIFO-queues it until a slot
 * frees. Task bodies always start on a microtask — never synchronously inside
 * `limit()`. Only `limit(fn)` exists; the `p-limit` package's
 * `activeCount`/`pendingCount`/`clearQueue`/`map` surface was unused.
 *
 * Internal (not part of the public API).
 */
export function pLimit(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError(`\`concurrency\` must be a positive integer, got ${concurrency}`);
  }
  let active = 0;
  const queue: Array<() => void> = [];
  const pump = (): void => {
    while (active < concurrency && queue.length > 0) {
      active++;
      const run = queue.shift();
      if (run !== undefined) run();
    }
  };
  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = async (): Promise<void> => {
        await Promise.resolve();
        try {
          resolve(await fn());
        } catch (error) {
          reject(error);
        } finally {
          active--;
          pump();
        }
      };
      queue.push(() => void run());
      pump();
    });
  };
}
