import { expandSeatRange } from "./seatRange.js";

export const MAX_CUSTOM_FALLBACK_SEATS = 20;

export function fallbackSeatKey(value) {
  return String(value ?? "").replace(/\s+/g, "").toUpperCase();
}

export function normalizeFallbackMode(value) {
  return value === "custom" ? "custom" : "range";
}

export function parseFallbackCustomSeats(value) {
  const rawValues = Array.isArray(value) ? value : [value];
  const lines = rawValues.flatMap((item) => String(item ?? "").split(/\r?\n/));
  const seats = [];
  const duplicates = [];
  const seen = new Set();

  for (const line of lines) {
    const seat = line.trim();
    if (!seat) continue;
    const key = fallbackSeatKey(seat);
    if (seen.has(key)) {
      duplicates.push(seat);
      continue;
    }
    seen.add(key);
    seats.push(seat);
  }

  return { seats, duplicates, count: seats.length + duplicates.length };
}

export function validateFallbackCustomSeats(value, { required = true } = {}) {
  const parsed = parseFallbackCustomSeats(value);
  const errors = [];
  if (required && !parsed.count) errors.push("超强自定义模式至少需要填写一个座位");
  if (parsed.count > MAX_CUSTOM_FALLBACK_SEATS) {
    errors.push(`超强自定义座位最多允许 ${MAX_CUSTOM_FALLBACK_SEATS} 个`);
  }
  if (parsed.duplicates.length) {
    errors.push(`超强自定义座位不能重复：${[...new Set(parsed.duplicates)].join("、")}`);
  }
  return { ...parsed, errors };
}

export function remainingFallbackRangeSeats(start, end, attemptedSeats = []) {
  const attemptedKeys = new Set(attemptedSeats.map(fallbackSeatKey));
  return expandSeatRange(start, end).filter((seat) => !attemptedKeys.has(fallbackSeatKey(seat)));
}
