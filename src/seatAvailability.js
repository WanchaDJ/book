function reservationTime(value) {
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const numeric = Number(value);
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function hasSeatReservationConflict(device, segment) {
  if (!Array.isArray(device.resvInfo)) return false;
  const begin = new Date(`${segment.date}T${segment.begin}:00`).getTime();
  const end = new Date(`${segment.date}T${segment.end}:00`).getTime();
  if (!Number.isFinite(begin) || !Number.isFinite(end)) return false;
  const freezingMs = Math.max(0, Number(device.resvRule?.freezingTime || 0)) * 60000;

  return device.resvInfo.some((reservation) => {
    if ((Number(reservation.resvStatus || 0) & 128) > 0) return false;
    const reservedStart = reservationTime(reservation.startTime);
    const reservedEnd = reservationTime(reservation.endTime);
    if (reservedStart == null || reservedEnd == null) return false;
    return begin < reservedEnd + freezingMs && end > reservedStart - freezingMs;
  });
}
