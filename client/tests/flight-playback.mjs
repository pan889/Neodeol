import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as Ballistics from "../../tools/multiplayer/sim/ballistics.js";
import * as Match from "../../tools/multiplayer/sim/match.js";
import * as Trig from "../../tools/multiplayer/sim/trig.js";
import { buildFlightTimeline, flightTickAt } from "../../tools/prototype/flight-playback.js";
import { sampleFlightTrack } from "../../tools/prototype/scope-camera.js";

Trig.loadTrig(readFileSync(new URL("../../tables/trig.bin", import.meta.url)));

function leg(kind, ticks, slot = 0) {
  return { kind, slot, pts: Array.from({ length: ticks + 1 }, (_, tick) => ({ x: tick * 32, y: 640 })) };
}

test("near and far trajectories advance at the same fixed tick rate", () => {
  assert.equal(flightTickAt(100, 12), 4.8);
  assert.equal(flightTickAt(100, 180), 4.8);
  assert.equal(flightTickAt(250, 12), 12);
  assert.equal(flightTickAt(250, 180), 12);
  assert.equal(flightTickAt(10000, 1800), 480);
  assert.equal(flightTickAt(-50, 12), 0);
});

test("fast playback uses the same multiplier for short and long shots", () => {
  assert.equal(flightTickAt(10, 12, true), flightTickAt(10, 180, true));
  assert.equal(flightTickAt(10, 180, true), flightTickAt(10, 180) * 8);
  assert.equal(flightTickAt(1000, 12, true), 12);
});

test("scope and battlefield interpolate the same position regardless of eventual impact time", () => {
  const short = buildFlightTimeline([leg("main", 12)])[0];
  const long = buildFlightTimeline([leg("main", 180)])[0];
  const shortSample = sampleFlightTrack(short, flightTickAt(125, short.end));
  const longSample = sampleFlightTrack(long, flightTickAt(125, long.end));
  assert.deepEqual(shortSample, longSample);
  assert.equal(shortSample.x, 192);
});

test("split, rolling and drilling legs start at the parent end without serializing siblings", () => {
  const legs = [leg("main", 30), leg("split", 20), leg("split", 45), leg("roll", 15), leg("burrow", 25)];
  const before = structuredClone(legs);
  const tracks = buildFlightTimeline(legs);
  assert.deepEqual(tracks.map(track => track.start), [0, 30, 30, 30, 30]);
  assert.equal(Math.max(...tracks.map(track => track.end)), 75);
  assert.equal(sampleFlightTrack(tracks[1], flightTickAt(600, 75)), null);
  assert.notEqual(sampleFlightTrack(tracks[1], flightTickAt(700, 75)), null);
  assert.deepEqual(legs, before);
});

test("maximum power clears the map width against maximum headwind without changing old shots", () => {
  assert.equal(Ballistics.MAX_POWER, 1500);
  assert.equal(Ballistics.flatRangePx(450, 1000, 0), 1899);
  assert.equal(Ballistics.flatRangePx(450, Ballistics.MAX_POWER, 0), 4307);
  assert.equal(Ballistics.flatRangePx(450, Ballistics.MAX_POWER, -Ballistics.CFG.windMax), 2871);
  assert.ok(Ballistics.flatRangePx(450, Ballistics.MAX_POWER, -Ballistics.CFG.windMax) > Ballistics.MAP_W_SUB / Ballistics.SUBPX);
});

test("canonical intent normalization accepts the entire expanded range and rejects excess", () => {
  const player = Match.makePlayer(0, "Player", false, 640);
  const intent = { angle10: 450, power: Ballistics.MAX_POWER, weaponId: 0, moveDx: 0, useShield: false };
  for (const power of [0, 1000, 1001, 1250, Ballistics.MAX_POWER]) {
    assert.equal(Match.normalizeIntent(player, { ...intent, power }).power, power);
  }
  for (const power of [-1, Ballistics.MAX_POWER + 1, 1250.5, NaN]) {
    assert.equal(Match.normalizeIntent(player, { ...intent, power }).power, player.power);
  }
});
