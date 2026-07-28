import test from "node:test";
import assert from "node:assert/strict";
import { expandSeatRange } from "../src/seatRange.js";

test("expands a prefixed, zero-padded seat range", () => {
  assert.deepEqual(expandSeatRange("2F-001", "2F-004"), ["2F-001", "2F-002", "2F-003", "2F-004"]);
});

test("preserves the widest numeric width", () => {
  assert.deepEqual(expandSeatRange("98号", "101号"), ["098号", "099号", "100号", "101号"]);
});

test("rejects mismatched seat prefixes", () => {
  assert.throws(() => expandSeatRange("2F-001", "3F-067"), /相同前缀和后缀/);
});

test("rejects a descending range", () => {
  assert.throws(() => expandSeatRange("2F-067", "2F-001"), /结束编号不能小于开始编号/);
});

test("enforces the configured range limit", () => {
  assert.throws(() => expandSeatRange("001", "301"), /最多允许 300 个座位/);
});
