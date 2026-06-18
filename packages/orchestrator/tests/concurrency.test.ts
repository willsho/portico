import { test } from "node:test";
import assert from "node:assert/strict";
import { createSemaphore, mergeAsyncIterables } from "../src/concurrency.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A single-unit source that tracks how many sources are live at once. */
function trackedSource(value: number, counters: { live: number; peak: number }, delayMs = 10) {
  return async function* () {
    counters.live++;
    counters.peak = Math.max(counters.peak, counters.live);
    try {
      await sleep(delayMs);
      yield value;
    } finally {
      counters.live--;
    }
  };
}

test("mergeAsyncIterables yields every value from every source", async () => {
  const sources = [
    async function* () {
      yield 1;
      yield 2;
    },
    async function* () {
      yield 3;
    },
  ];
  const out: number[] = [];
  for await (const v of mergeAsyncIterables(sources)) out.push(v);
  assert.deepEqual(out.sort((a, b) => a - b), [1, 2, 3]);
});

test("mergeAsyncIterables with concurrency 1 never runs two sources at once", async () => {
  const counters = { live: 0, peak: 0 };
  const sources = [1, 2, 3].map((v) => trackedSource(v, counters));
  const out: number[] = [];
  for await (const v of mergeAsyncIterables(sources, { concurrency: 1 })) out.push(v);
  assert.equal(counters.peak, 1);
  assert.deepEqual(out.sort((a, b) => a - b), [1, 2, 3]);
});

test("mergeAsyncIterables caps concurrent sources at the configured bound", async () => {
  const counters = { live: 0, peak: 0 };
  const sources = [1, 2, 3, 4, 5].map((v) => trackedSource(v, counters));
  const out: number[] = [];
  for await (const v of mergeAsyncIterables(sources, { concurrency: 2 })) out.push(v);
  assert.equal(counters.peak, 2);
  assert.equal(out.length, 5);
});

test("mergeAsyncIterables drops a throwing source without aborting the others", async () => {
  const sources = [
    async function* () {
      yield "a";
      throw new Error("boom");
    },
    async function* () {
      yield "b";
      yield "c";
    },
  ];
  const out: string[] = [];
  for await (const v of mergeAsyncIterables(sources)) out.push(v);
  // The thrower still surfaced "a"; the healthy source completed fully.
  assert.ok(out.includes("b") && out.includes("c"));
  assert.ok(out.includes("a"));
});

test("mergeAsyncIterables returns active sources when the consumer breaks early", async () => {
  let cleanedUp = false;
  const source = async function* () {
    try {
      yield 1;
      yield 2;
    } finally {
      cleanedUp = true;
    }
  };
  for await (const _ of mergeAsyncIterables([source])) {
    break; // abandon the stream after the first value
  }
  assert.equal(cleanedUp, true);
});

test("createSemaphore with limit 1 behaves as a mutex", async () => {
  const sem = createSemaphore(1);
  await sem.acquire();
  let secondAcquired = false;
  const second = sem.acquire().then(() => {
    secondAcquired = true;
  });
  await sleep(10);
  assert.equal(secondAcquired, false, "second acquire must block while the slot is held");
  sem.release();
  await second;
  assert.equal(secondAcquired, true);
});

test("createSemaphore allows up to `limit` concurrent holders", async () => {
  const sem = createSemaphore(2);
  await sem.acquire();
  await sem.acquire();
  let thirdAcquired = false;
  const third = sem.acquire().then(() => {
    thirdAcquired = true;
  });
  await sleep(10);
  assert.equal(thirdAcquired, false);
  sem.release();
  await third;
  assert.equal(thirdAcquired, true);
});
