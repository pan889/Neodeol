import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as Ballistics from "../../tools/multiplayer/sim/ballistics.js";
import * as Match from "../../tools/multiplayer/sim/match.js";
import * as Terrain from "../../tools/multiplayer/sim/terrain.js";
import { hash32 } from "../../tools/multiplayer/sim/intmath.js";
import { ruleHash } from "../../tools/multiplayer/sim/rules.js";
import { loadTrig } from "../../tools/multiplayer/sim/trig.js";

loadTrig(readFileSync(new URL("../../tables/trig.bin", import.meta.url)));

test("wind retains fractional force, stays symmetric and has no accumulation drift", () => {
  assert.equal(Ballistics.CFG.windScaleQ8, 192);
  assert.deepEqual([0, 1, 2, 3].map((tick) => Ballistics.windAcceleration(1, tick)), [0, 1, 1, 1]);
  for (let wind = 1; wind <= Ballistics.CFG.windMax; wind++) {
    let accumulated = 0;
    for (let tick = 0; tick < Ballistics.CFG.maxFlightTicks; tick++) {
      const acceleration = Ballistics.windAcceleration(wind, tick);
      assert.ok(Number.isInteger(acceleration));
      assert.equal(Ballistics.windAcceleration(-wind, tick), -acceleration);
      assert.equal(Ballistics.windAcceleration(0, tick), 0);
      accumulated += acceleration;
      assert.equal(accumulated, (wind * 192 * (tick + 1)) >> 8);
    }
  }
});

test("same-wind deflection is roughly 25 percent smaller at normal and high angles", () => {
  const originalScale = Ballistics.CFG.windScaleQ8;
  try {
    for (const angle of [450, 700, 800]) {
      for (const wind of [-4, -2, -1, 1, 2, 4]) {
        Ballistics.CFG.windScaleQ8 = 192;
        const baseline = Ballistics.flatRangePx(angle, 1000, 0);
        const softened = Ballistics.flatRangePx(angle, 1000, wind) - baseline;
        Ballistics.CFG.windScaleQ8 = 256;
        assert.equal(Ballistics.flatRangePx(angle, 1000, 0), baseline);
        const original = Ballistics.flatRangePx(angle, 1000, wind) - baseline;
        assert.ok(softened * original > 0);
        assert.ok(Math.abs(softened) / Math.abs(original) >= .7);
        assert.ok(Math.abs(softened) / Math.abs(original) <= .78);
      }
    }
  } finally { Ballistics.CFG.windScaleQ8 = originalScale; }
});

test("primary and continued projectiles both use the reduced cumulative acceleration", () => {
  const originalGrid = Terrain.grid.slice(), originalTicks = Ballistics.CFG.maxFlightTicks;
  try {
    Terrain.grid.fill(0); Ballistics.CFG.maxFlightTicks = 16;
    for (const wind of [-4, -1, 0, 1, 4]) {
      let displacement = 0;
      for (let tick = 0; tick < 16; tick++) displacement += Ballistics.windAcceleration(wind, tick) * (16 - tick);
      const primary = Ballistics.simulateShot(10000, 10000, 900, 200, wind, -1, null, false);
      assert.equal(primary.hit, "timeout"); assert.equal(primary.n, 16);
      assert.equal(primary.hitX, 10000 + displacement);
      const child = Ballistics.continueShot(10000, 10000, 0, -120, wind, -1, null);
      assert.equal(child.hit, "timeout"); assert.equal(child.hitX, 10000 + displacement);
    }
  } finally { Terrain.grid.set(originalGrid); Ballistics.CFG.maxFlightTicks = originalTicks; }
});

test("wind transitions retain 60 percent and take at most one step through calm", () => {
  let unchanged = 0, total = 0;
  const seen = new Set();
  for (let seed = 1; seed <= 64; seed++) {
    let wind = 0;
    for (let turn = 1; turn <= 256; turn++) {
      const following = Match.deriveWind(seed, turn, wind);
      assert.equal(following, Match.deriveWind(seed, turn, wind));
      assert.ok(Math.abs(following - wind) <= 1);
      assert.ok(following * wind >= 0);
      assert.ok(Math.abs(following) <= Ballistics.CFG.windMax);
      unchanged += following === wind ? 1 : 0;
      total++; seen.add(following); wind = following;
    }
  }
  assert.equal(seen.size, 9);
  assert.ok(unchanged / total >= .6 && unchanged / total <= .7);
});

test("all twenty roll buckets match the documented distribution and clamp at the edges", () => {
  const rolls = new Set();
  for (let previous = -4; previous <= 4; previous++) {
    for (let turn = 1; turn <= 256; turn++) {
      const roll = hash32(85 ^ 0x5715, turn, previous, 0) % 20;
      rolls.add(roll);
      const delta = roll < 4 ? -1 : roll >= 16 ? 1 : 0;
      assert.equal(Match.deriveWind(85, turn, previous), Math.max(-4, Math.min(4, previous + delta)));
    }
  }
  assert.equal(rolls.size, 20);
});

test("disabled and small wind ranges cannot overflow or jump across zero", () => {
  const originalMax = Ballistics.CFG.windMax;
  try {
    for (const maximum of [0, 1, 2, 4]) {
      Ballistics.CFG.windMax = maximum;
      let wind = 0;
      for (let turn = 1; turn <= 512; turn++) {
        const following = Match.deriveWind(149, turn, wind);
        assert.ok(Math.abs(following) <= maximum);
        assert.ok(Math.abs(following - wind) <= 1);
        assert.ok(following * wind >= 0);
        wind = following;
      }
    }
  } finally { Ballistics.CFG.windMax = originalMax; }
});

test("the wind coefficient participates in independent network rule fingerprints", () => {
  const originalScale = Ballistics.CFG.windScaleQ8, originalHash = ruleHash();
  try {
    Ballistics.CFG.windScaleQ8 = 256;
    assert.notEqual(ruleHash(), originalHash);
  } finally { Ballistics.CFG.windScaleQ8 = originalScale; }
  assert.equal(ruleHash(), originalHash);
});

test("local turn generation and the forecast use the canonical match function", () => {
  const source = readFileSync(new URL("../../tools/prototype/index.html", import.meta.url), "utf8");
  assert.match(source, /G\.wind = M\.deriveWind\(G\.seed, G\.turnNo, previous\)/);
  assert.match(source, /const forecast = M\.deriveWind\(G\.seed, G\.turnNo \+ 1, G\.wind\)/);
  assert.doesNotMatch(source, /function nextWindValue/);
});
