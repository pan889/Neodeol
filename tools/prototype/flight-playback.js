export const FLIGHT_TICKS_PER_SECOND = 48;

export function buildFlightTimeline(legs) {
  const mainEnd = new Map();
  const tracks = [];
  for (const leg of legs) {
    const duration = Math.max(1, leg.pts.length - 1);
    const start = leg.kind === "main" ? 0 : mainEnd.get(leg.slot) || 0;
    if (leg.kind === "main") mainEnd.set(leg.slot, duration);
    tracks.push({ leg, start, end: start + duration, duration });
  }
  return tracks;
}

export function flightTickAt(elapsedMs, endTick, fast = false) {
  return Math.min(endTick, Math.max(0, elapsedMs) * FLIGHT_TICKS_PER_SECOND * (fast ? 8 : 1) / 1000);
}
