import test from "node:test";
import assert from "node:assert/strict";
import { hasSeatReservationConflict } from "../src/seatAvailability.js";

const segment = { date: "2026-07-29", begin: "08:00", end: "11:00" };

test("treats a seat without reservations as available", () => {
  assert.equal(hasSeatReservationConflict({}, segment), false);
});

test("detects an active reservation overlapping the requested segment", () => {
  const device = {
    resvInfo: [{ startTime: "2026-07-29T09:00:00", endTime: "2026-07-29T10:00:00", resvStatus: 4 }],
  };
  assert.equal(hasSeatReservationConflict(device, segment), true);
});

test("allows a reservation ending when the requested segment begins", () => {
  const device = {
    resvInfo: [{ startTime: "2026-07-29T07:00:00", endTime: "2026-07-29T08:00:00", resvStatus: 4 }],
  };
  assert.equal(hasSeatReservationConflict(device, segment), false);
});

test("ignores reservations carrying the official ended status bit", () => {
  const device = {
    resvInfo: [{ startTime: "2026-07-29T09:00:00", endTime: "2026-07-29T10:00:00", resvStatus: 128 }],
  };
  assert.equal(hasSeatReservationConflict(device, segment), false);
});

test("honors the seat freezing interval around another reservation", () => {
  const device = {
    resvRule: { freezingTime: 15 },
    resvInfo: [{ startTime: "2026-07-29T11:10:00", endTime: "2026-07-29T12:00:00", resvStatus: 2 }],
  };
  assert.equal(hasSeatReservationConflict(device, segment), true);
});

test("accepts numeric timestamps returned as strings", () => {
  const device = {
    resvInfo: [{
      startTime: String(new Date("2026-07-29T09:00:00").getTime()),
      endTime: String(new Date("2026-07-29T10:00:00").getTime()),
      resvStatus: 4,
    }],
  };
  assert.equal(hasSeatReservationConflict(device, segment), true);
});
