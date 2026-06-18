/**
 * Concurrency primitives for fan-out delegation: a bounded async-iterator merge
 * and a counting semaphore. Both are plain Promise/AsyncIterable code with no
 * runtime dependencies, so they type-strip directly under Node's native loader.
 */

export interface Semaphore {
  /** Wait for a slot. Resolves once a slot is held by the caller. */
  acquire(): Promise<void>;
  /** Return a slot. Wakes the longest-waiting `acquire`, if any. */
  release(): void;
}

/**
 * A counting semaphore. With `limit: 1` it behaves as a mutual-exclusion lock.
 *
 * The decrement happens inside `acquire` (after any wait resolves), so accounting
 * stays consistent even when a waiter is woken: `release` does +1, the woken
 * `acquire` does -1, netting the slot transfer.
 */
export function createSemaphore(limit: number): Semaphore {
  let available = limit;
  const waiters: Array<() => void> = [];
  return {
    async acquire() {
      if (available > 0) {
        available--;
        return;
      }
      await new Promise<void>((resolve) => waiters.push(resolve));
      available--;
    },
    release() {
      available++;
      const next = waiters.shift();
      if (next) next();
    },
  };
}

export interface MergeOptions {
  /** Maximum number of sources active at once. Defaults to the number of sources. */
  concurrency?: number;
}

interface PumpResult<T> {
  iterator: AsyncIterator<T>;
  result?: IteratorResult<T>;
}

/**
 * Merge several lazy async-iterable sources into one stream, yielding values as
 * they arrive, with at most `concurrency` sources active concurrently.
 *
 * Sources are thunks: a source is only invoked (and so only starts doing work)
 * once it is granted a concurrency slot. As each source drains, the next queued
 * source starts. A source that throws is dropped without aborting the others.
 *
 * If the consumer stops early (breaks the for-await), the `finally` block calls
 * `return()` on every still-active source iterator so they can clean up.
 */
export async function* mergeAsyncIterables<T>(
  sources: Array<() => AsyncIterable<T>>,
  options: MergeOptions = {},
): AsyncIterable<T> {
  const concurrency = Math.max(1, options.concurrency ?? sources.length);
  const queue = [...sources];
  const active = new Map<AsyncIterator<T>, Promise<PumpResult<T>>>();

  const pump = (iterator: AsyncIterator<T>): Promise<PumpResult<T>> =>
    Promise.resolve(iterator.next()).then(
      (result) => ({ iterator, result }),
      () => ({ iterator }), // a source threw: surface as "no result" and drop it
    );

  const startMore = (): void => {
    while (active.size < concurrency && queue.length > 0) {
      const make = queue.shift()!;
      const iterator = make()[Symbol.asyncIterator]();
      active.set(iterator, pump(iterator));
    }
  };

  try {
    startMore();
    while (active.size > 0) {
      const { iterator, result } = await Promise.race(active.values());
      if (result === undefined || result.done) {
        active.delete(iterator);
        startMore();
        continue;
      }
      active.set(iterator, pump(iterator));
      yield result.value;
    }
  } finally {
    await Promise.allSettled(
      [...active.keys()].map((iterator) => (iterator.return ? iterator.return() : undefined)),
    );
  }
}
