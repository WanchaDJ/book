export const MAX_FALLBACK_SEATS = 300;

function parseSeatRangeEdge(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(.*?)(\d+)(\D*)$/);
  if (!match) throw new Error(`座位号“${text || "空"}”必须包含数字编号`);

  const number = Number(match[2]);
  if (!Number.isSafeInteger(number)) throw new Error(`座位号“${text}”的数字编号无效`);
  return {
    text,
    prefix: match[1],
    digits: match[2],
    number,
    suffix: match[3],
  };
}

function comparableAffix(value) {
  return value.replace(/\s+/g, "").toUpperCase();
}

export function expandSeatRange(startValue, endValue, limit = MAX_FALLBACK_SEATS) {
  const start = parseSeatRangeEdge(startValue);
  const end = parseSeatRangeEdge(endValue);
  if (
    comparableAffix(start.prefix) !== comparableAffix(end.prefix)
    || comparableAffix(start.suffix) !== comparableAffix(end.suffix)
  ) {
    throw new Error("兜底座位起止值必须使用相同前缀和后缀，例如 2F-001 至 2F-067");
  }
  if (start.number > end.number) throw new Error("兜底座位结束编号不能小于开始编号");

  const count = end.number - start.number + 1;
  if (count > limit) throw new Error(`兜底座位区间最多允许 ${limit} 个座位`);
  const width = Math.max(start.digits.length, end.digits.length);
  return Array.from(
    { length: count },
    (_, index) => `${start.prefix}${String(start.number + index).padStart(width, "0")}${start.suffix}`,
  );
}
