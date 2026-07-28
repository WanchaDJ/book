import test from "node:test";
import assert from "node:assert/strict";
import { upsertLogEntry } from "../src/taskLogs.js";

test("replaces an existing progress log with the same key", () => {
  const logs = [{ logKey: "run-1:fallback", message: "1/65" }];
  const result = upsertLogEntry(logs, { logKey: "run-1:fallback", message: "15/65" });
  assert.equal(result.replaced, true);
  assert.deepEqual(logs, [{ logKey: "run-1:fallback", message: "15/65" }]);
});

test("keeps ordinary logs as separate history entries", () => {
  const logs = [{ message: "first" }];
  upsertLogEntry(logs, { message: "second" });
  assert.deepEqual(logs, [{ message: "first" }, { message: "second" }]);
});

test("keeps the configured maximum number of entries", () => {
  const logs = [{ message: "first" }, { message: "second" }];
  upsertLogEntry(logs, { message: "third" }, 2);
  assert.deepEqual(logs, [{ message: "second" }, { message: "third" }]);
});
