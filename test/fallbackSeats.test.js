import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeFallbackMode,
  parseFallbackCustomSeats,
  remainingFallbackRangeSeats,
  shuffleFallbackSeats,
  validateFallbackCustomSeats,
} from "../src/fallbackSeats.js";

test("preserves the entered order of custom fallback seats", () => {
  const parsed = parseFallbackCustomSeats("2F-018\n2F-003\n2F-011");
  assert.deepEqual(parsed.seats, ["2F-018", "2F-003", "2F-011"]);
});

test("accepts exactly 20 custom fallback seats", () => {
  const seats = Array.from({ length: 20 }, (_, index) => `2F-${String(index + 1).padStart(3, "0")}`);
  assert.deepEqual(validateFallbackCustomSeats(seats).errors, []);
});

test("rejects more than 20 custom fallback seats", () => {
  const seats = Array.from({ length: 21 }, (_, index) => `2F-${String(index + 1).padStart(3, "0")}`);
  assert.match(validateFallbackCustomSeats(seats).errors.join("；"), /最多允许 20 个/);
});

test("rejects duplicate custom fallback seats without changing order", () => {
  const result = validateFallbackCustomSeats(["2F-015", " 2f-015 ", "2F-020"]);
  assert.deepEqual(result.seats, ["2F-015", "2F-020"]);
  assert.match(result.errors.join("；"), /不能重复/);
});

test("final range excludes explicit and custom seats already attempted", () => {
  assert.deepEqual(
    remainingFallbackRangeSeats("2F-001", "2F-006", ["2F-001", "2F-003", "2f-005"]),
    ["2F-002", "2F-004", "2F-006"],
  );
});

test("old fallback tasks default to blind-box range mode", () => {
  assert.equal(normalizeFallbackMode(undefined), "range");
  assert.equal(normalizeFallbackMode("custom"), "custom");
});

test("blind-box mode shuffles a copy of the fallback range", () => {
  const seats = ["2F-001", "2F-002", "2F-003", "2F-004"];
  assert.deepEqual(shuffleFallbackSeats(seats, () => 0), ["2F-002", "2F-003", "2F-004", "2F-001"]);
  assert.deepEqual(seats, ["2F-001", "2F-002", "2F-003", "2F-004"]);
});
