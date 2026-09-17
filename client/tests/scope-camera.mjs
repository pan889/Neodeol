import assert from "node:assert/strict";
import { test } from "node:test";
import { IMPACT_HOLD_MS, sampleFlightTrack, scopeCamera } from "../../tools/prototype/scope-camera.js";
import { nuclearCloudBounds, nuclearCloudDuration } from "../../tools/prototype/nuclear-art.js";

function track(points, start = 0, kind = "main", slot = 0) {
  return { start, duration: Math.max(1, points.length - 1),
    leg: { kind, slot, pts: points.map(([horizontal, vertical]) => ({ x: horizontal * 32, y: vertical * 32 })) } };
}

function scene(overrides = {}) {
  return { player: { x: 320 * 32, y: 180 * 32, slot: 0 }, phase: "AIM", tracks: [], tick: 0,
    impacts: [], impactAt: 0, now: 1000, cell: 32, mapWidth: 960, mapHeight: 540, ...overrides };
}

function contains(camera, horizontal, vertical) {
  assert.ok(horizontal >= camera.left && horizontal <= camera.left + camera.width);
  assert.ok(vertical >= camera.top && vertical <= camera.top + camera.height);
}

test("flight samples match the drawn interpolation and exclude inactive legs", () => {
  const flight = track([[100, 180], [120, 160], [140, 150]], 3);
  assert.equal(sampleFlightTrack(flight, 2), null);
  assert.equal(sampleFlightTrack(flight, 6), null);
  assert.deepEqual(sampleFlightTrack(flight, 3.5), { x: 110 * 32, y: 170 * 32, upto: 0, blend: .5 });
  assert.deepEqual(sampleFlightTrack(flight, 5), { x: 140 * 32, y: 150 * 32, upto: 2, blend: 0 });
  assert.equal(sampleFlightTrack(track([]), 0), null);
});

test("aim view retains the original four-times framing and clips to the map", () => {
  const camera = scopeCamera(scene());
  assert.equal(camera.mode, "aim");
  assert.equal(camera.width, 52.5);
  assert.equal(camera.height, 28.5);
  assert.equal(camera.top, 180 - 22);
  contains(camera, 320, 180);
  const edge = scopeCamera(scene({ player: { x: 0, y: 10 * 32, slot: 1 } }));
  assert.equal(edge.left, 0);
  assert.equal(edge.top, 0);
  assert.equal(scopeCamera(scene({ player: null })), null);
});

test("flight follows only the current sample, never the future path or impact", () => {
  const flight = track([[100, 180], [120, 160], [300, 180]]);
  const state = scene({ phase: "RESOLVE", tracks: [flight], tick: .5, impactAt: 999 });
  const camera = scopeCamera(state);
  assert.equal(camera.mode, "flight");
  assert.equal(camera.width, 105);
  assert.equal(camera.left + camera.width / 2, 110);
  assert.equal(camera.top + camera.height / 2, 170);
  flight.leg.pts[2] = { x: 900 * 32, y: 500 * 32 };
  state.impacts = new Proxy([], { get() { throw new Error("future impact must not be inspected"); } });
  assert.deepEqual(scopeCamera(state), camera);
});

test("split projectiles stay framed together and finished legs are dropped", () => {
  const flights = [track([[100, 180], [200, 100]]),
    track([[200, 100], [140, 130], [100, 190]], 1, "split"),
    track([[200, 100], [260, 130], [300, 190]], 1, "split")];
  const camera = scopeCamera(scene({ phase: "RESOLVE", tracks: flights, tick: 2 }));
  assert.equal(camera.count, 2);
  assert.ok(camera.width > 105);
  contains(camera, 140, 130);
  contains(camera, 260, 130);
  assert.equal(camera.left + camera.width / 2, 200);
});

test("rolling and drilling legs use the same current-position tracking", () => {
  for (const kind of ["roll", "drill"]) {
    const camera = scopeCamera(scene({ phase: "RESOLVE", tick: 2.5,
      tracks: [track([[100, 180], [120, 170]]), track([[120, 170], [125, 180], [130, 195]], 1, kind)] }));
    assert.equal(camera.mode, "flight");
    assert.equal(camera.count, 1);
    contains(camera, 127.5, 187.5);
  }
});

test("a projectile above or beyond the battlefield remains inside the scope", () => {
  for (const [horizontal, vertical] of [[500, -100], [-80, 200], [1100, 200]]) {
    const camera = scopeCamera(scene({ phase: "RESOLVE", tracks: [track([[horizontal, vertical]])] }));
    assert.equal(camera.outside, true);
    contains(camera, horizontal, vertical);
    assert.equal(camera.projectiles[0].x, horizontal);
    assert.equal(camera.projectiles[0].y, vertical);
  }
});

test("impact view holds through settlement and briefly into the next aim", () => {
  const state = scene({ phase: "IMPACT", tracks: [track([[100, 180], [600, 200]])], impactAt: 1000,
    impacts: [{ x: 600 * 32, y: 200 * 32, weapon: { carveCells: 45 } }] });
  const camera = scopeCamera(state);
  assert.equal(camera.mode, "impact");
  contains(camera, 555, 155);
  contains(camera, 645, 245);
  assert.equal(scopeCamera({ ...state, phase: "SETTLE", now: 8000 }).mode, "impact");
  assert.equal(scopeCamera({ ...state, phase: "AIM", now: 1000 + IMPACT_HOLD_MS - 1 }).mode, "impact");
  assert.equal(scopeCamera({ ...state, phase: "AIM", now: 1000 + IMPACT_HOLD_MS }).mode, "aim");
  assert.equal(scopeCamera({ ...state, phase: "RESOLVE", now: 1100 }).mode, "flight");
});

test("a miss holds the exit point, and a fresh match cannot show stale impacts", () => {
  const state = scene({ phase: "AIM", tracks: [track([[800, 180], [1000, 150]])], impactAt: 900 });
  const camera = scopeCamera(state);
  assert.equal(camera.mode, "exit");
  contains(camera, 1000, 150);
  assert.equal(scopeCamera({ ...state, tracks: [] }).mode, "aim");
});

test("scope framing never mutates match or projectile data", () => {
  const flight = track([[100, 180], [120, 160]], 0, "main", 1);
  for (const point of flight.leg.pts) Object.freeze(point);
  Object.freeze(flight.leg.pts); Object.freeze(flight.leg); Object.freeze(flight);
  const state = Object.freeze(scene({ phase: "RESOLVE", tracks: Object.freeze([flight]), tick: .5 }));
  const snapshot = JSON.stringify(state);
  assert.equal(scopeCamera(state).slot, 1);
  assert.equal(JSON.stringify(state), snapshot);
});

test("nuclear scope frames the entire mushroom beyond map edges without growth jitter", () => {
  for (const [horizontal, vertical] of [[20, 180], [480, 360], [950, 530]]) {
    const state = scene({ phase: "AIM", impactAt: 1000, tracks: [track([[horizontal, vertical]])],
      impacts: [{ x: horizontal * 32, y: vertical * 32, weapon: { id: 7, carveCells: 128 } }] });
    const camera = scopeCamera({ ...state, now: 1600 });
    const bounds = nuclearCloudBounds({ x: horizontal, y: vertical, size: 128 });
    assert.equal(camera.mode, "impact");
    contains(camera, bounds.left, bounds.top); contains(camera, bounds.right, bounds.bottom);
    assert.deepEqual(scopeCamera({ ...state, now: 5800 }), camera);
    assert.equal(scopeCamera({ ...state, now: 1000 + nuclearCloudDuration() - 1 }).mode, "impact");
    assert.equal(scopeCamera({ ...state, now: 1000 + nuclearCloudDuration() }).mode, "aim");
    assert.equal(scopeCamera({ ...state, now: 2500, reducedMotion: true }).mode, "aim");
    assert.equal(scopeCamera({ ...state, now: 1800, phase: "RESOLVE" }).mode, "flight");
  }
});
