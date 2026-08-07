import assert from "node:assert/strict";
import fs from "node:fs";

import * as B from "./sim/ballistics.js";
import * as Match from "./sim/match.js";
import * as T from "./sim/terrain.js";
import * as Trig from "./sim/trig.js";

Trig.loadTrig(fs.readFileSync(new URL("../../tables/trig.bin", import.meta.url)));

const records = fs.readFileSync(new URL("../../tests/replays/match.jsonl", import.meta.url), "utf8")
  .trim().split("\n").map((line) => JSON.parse(line));
const metadata = records.shift();

Object.assign(T.CFG, {
  slideSandQ8: metadata.cfg.slideSandQ8,
  slideSoilQ8: metadata.cfg.slideSoilQ8,
  slideScreeQ8: metadata.cfg.slideScreeQ8,
  slideGateStatic: metadata.cfg.slideGateStatic,
  bothDirections: metadata.cfg.bothDirections,
  blastResistQ8: metadata.cfg.blastResistQ8,
});
Object.assign(B.CFG, metadata.ballistics);

const made = Match.createMatch(metadata.mapSeed, metadata.specs);
const state = made.state;
assert.deepEqual(made.initialSettle, metadata.initialSettle);

function hex8(value) {
  return value.toString(16).toUpperCase().padStart(8, "0");
}

function assertPlayers(expected) {
  const keys = [
    "slot", "x", "y", "hp", "alive", "buried", "angle10", "power", "gold",
    "weaponId", "score", "kills", "damageDone", "shieldUp",
  ];
  for (let index = 0; index < expected.length; index++) {
    const actual = state.players[index];
    for (const key of keys) assert.equal(actual[key], expected[index][key], `slot ${index} ${key}`);
    assert.deepEqual(actual.ammo, expected[index].ammo, `slot ${index} ammo`);
    assert.deepEqual(actual.items, expected[index].items, `slot ${index} items`);
  }
}

for (const record of records) {
  if (record.record === "turn") {
    assert.equal(state.activeSlot, record.activeSlot);
    const result = Match.resolveMatchTurn(state, record.intent);
    assert.equal(result.turnNo, record.turnNo);
    assert.equal(result.turnSeed, record.turnSeed);
    assert.equal(hex8(result.checksum), record.checksum);
    assert.equal(result.mass, record.mass);
    assert.equal(state.phase, record.phase);
    assertPlayers(record.players);
  } else if (record.record === "shop") {
    for (const purchase of record.purchases) {
      const player = state.players[purchase.slot];
      const ok = purchase.kind === "weapon"
        ? Match.buyWeapon(player, purchase.weaponId)
        : Match.buyItem(player, purchase.key);
      assert.equal(ok, purchase.ok);
    }
    Match.startNextRound(state);
    assert.equal(hex8(T.checksum()), record.checksum);
    assert.equal(T.massCount(), record.mass);
    assert.equal(state.roundNo, record.roundNo);
    assert.equal(state.activeSlot, record.activeSlot);
    assertPlayers(record.players);
  }
}

const animated = Match.createMatch(metadata.mapSeed, metadata.specs).state;
for (const record of records) {
  if (record.record === "turn") {
    const turnWind = animated.wind;
    animated.turnNo++;
    animated.roundTurn++;
    T.CFG.seed = Match.deriveTurnSeed(animated.mapSeed, animated.turnNo);
    for (const player of animated.players) player.intent = null;
    Match.setIntent(animated.players[animated.activeSlot], record.intent);
    const resolved = Match.resolveTurn(animated.players, turnWind);
    Match.applyDetonations(animated.players, resolved.dets);
    T.setStep(0);
    let steps = 0;
    let connectivityRounds = 0;
    while (steps < Match.RULES.maxSettleSteps) {
      steps++;
      if (T.step().mobile !== 0) continue;
      if (T.connectivity() === 0) break;
      connectivityRounds++;
      if (connectivityRounds >= Match.RULES.connectivityMaxRounds) break;
    }
    const owner = resolved.dets.length ? resolved.dets[resolved.dets.length - 1].owner : null;
    Match.applyPhase(animated.players, owner);
    const outcome = Match.roundOutcome(animated.players, animated.roundTurn);
    if (outcome.over) {
      Match.closeRound(animated.players, outcome);
      animated.phase = animated.roundNo >= Match.RULES.rounds ? "done" : "shop";
      animated.over = animated.phase === "done";
    } else {
      animated.activeSlot = Match.nextAliveSlot(animated.players, animated.activeSlot);
      animated.wind = Match.deriveWind(animated.mapSeed, animated.turnNo + 1, turnWind);
      animated.phase = "aim";
    }
    assert.equal(hex8(T.checksum()), record.checksum, `animated turn ${record.turnNo}`);
  } else if (record.record === "shop") {
    for (const purchase of record.purchases) {
      const player = animated.players[purchase.slot];
      if (purchase.kind === "weapon") Match.buyWeapon(player, purchase.weaponId);
      else Match.buyItem(player, purchase.key);
    }
    Match.startNextRound(animated);
    assert.equal(hex8(T.checksum()), record.checksum, "animated round start");
  }
}

console.log(`canvas lockstep mirror ok turns=${state.turnNo} animated=${animated.turnNo}`);
