import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as Terrain from "../../tools/multiplayer/sim/terrain.js";
import * as Ballistics from "../../tools/multiplayer/sim/ballistics.js";
import * as Match from "../../tools/multiplayer/sim/match.js";
import * as Trig from "../../tools/multiplayer/sim/trig.js";
import { aiIntent } from "../../tools/prototype/ai.js";

Trig.loadTrig(readFileSync(new URL("../../tables/trig.bin", import.meta.url)));

function roster() {
  Terrain.grid.fill(Terrain.EMPTY);
  Terrain.grid.fill(Terrain.ROCK, 300 * Terrain.W);
  return [180, 600].map((cell, slot) => Match.makePlayer(slot, `Tank ${slot}`, slot === 1, cell * Ballistics.CELL_SUBPX));
}

test("difficulty intents are deterministic, bounded and leave players untouched", () => {
  const players = roster();
  const before = structuredClone(players);
  for (const difficulty of ["easy", "normal", "hard"]) {
    for (let seed = 0; seed < 32; seed++) {
      const intent = aiIntent(players, players[1], -4, 21, seed, difficulty);
      assert.deepEqual(intent, aiIntent(players, players[1], -4, 21, seed, difficulty));
      assert.ok(Number.isInteger(intent.angle10) && intent.angle10 >= 0 && intent.angle10 <= 1800);
      assert.ok(Number.isInteger(intent.power) && intent.power >= 0 && intent.power <= Ballistics.MAX_POWER);
    }
  }
  assert.deepEqual(players, before);
});

test("easy and normal get standard-ammo warmups again in later rounds", () => {
  const players = roster();
  for (let seed = 0; seed < 32; seed++) {
    for (const [difficulty, lastTurn] of [["easy", 4], ["normal", 2]]) {
      for (let roundTurn = 1; roundTurn <= lastTurn; roundTurn++) {
        assert.equal(aiIntent(players, players[1], 0, 100 + roundTurn, seed, difficulty, roundTurn).weaponId, 0);
      }
    }
  }
});

test("special-ammo pressure increases with difficulty and easy never chooses the finisher", () => {
  const players = roster();
  players[0].hp = 30;
  const counts = {};
  for (const difficulty of ["easy", "normal", "hard"]) {
    let specials = 0;
    const weapons = new Set();
    for (let seed = 0; seed < 256; seed++) {
      const intent = aiIntent(players, players[1], 0, 17, seed, difficulty);
      specials += Number(intent.weaponId !== 0);
      weapons.add(intent.weaponId);
    }
    counts[difficulty] = specials;
    assert.ok(weapons.size > 2);
    if (difficulty === "easy") assert.equal(weapons.has(5), false);
    else assert.equal(weapons.has(5), true);
  }
  assert.ok(counts.easy < counts.normal && counts.normal < counts.hard, JSON.stringify(counts));
  assert.ok(counts.easy < 256 / 4, JSON.stringify(counts));
});

test("easy misses noticeably more than normal and hard in seeded flat-ground shots", (context) => {
  const players = roster();
  const summary = {};
  for (const difficulty of ["easy", "normal", "hard"]) {
    let totalError = 0;
    let closeHits = 0;
    for (let seed = 0; seed < 128; seed++) {
      const actor = players[1];
      const intent = aiIntent(players, actor, 0, 17, seed, difficulty);
      const pose = Ballistics.shotPose(actor, intent.angle10);
      const shot = Ballistics.simulateShot(pose.x, pose.y, pose.angle10, intent.power, 0, actor.slot, players, null);
      const error = Math.abs(shot.hitX - players[0].x) / Ballistics.CELL_SUBPX;
      totalError += error;
      closeHits += Number(error <= 12);
    }
    summary[difficulty] = { meanErrorCells: totalError / 128, closeHits };
  }
  context.diagnostic(JSON.stringify(summary));
  assert.ok(summary.easy.meanErrorCells > summary.normal.meanErrorCells * 1.4);
  assert.ok(summary.normal.meanErrorCells > summary.hard.meanErrorCells * 2);
  assert.ok(summary.easy.closeHits < summary.normal.closeHits);
  assert.ok(summary.normal.closeHits < summary.hard.closeHits);
});
