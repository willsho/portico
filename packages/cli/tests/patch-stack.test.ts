import { test } from "node:test";
import assert from "node:assert/strict";
import { computeApplyOrder } from "../src/commands/patch-stack.ts";

test("computeApplyOrder sorts runs by descending changed-file count, breaking ties by id", () => {
  const runs = [
    { id: "run_b", changedFiles: ["1"] },
    { id: "run_a", changedFiles: ["1", "2"] },
    { id: "run_c", changedFiles: ["1"] },
  ];
  assert.deepEqual(computeApplyOrder(runs), ["run_a", "run_b", "run_c"]);
});
