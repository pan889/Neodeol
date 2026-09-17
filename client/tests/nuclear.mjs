import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as Ballistics from "../../tools/multiplayer/sim/ballistics.js";
import * as Match from "../../tools/multiplayer/sim/match.js";
import * as Mapgen from "../../tools/multiplayer/sim/mapgen.js";
import * as Terrain from "../../tools/multiplayer/sim/terrain.js";
import { byId, NUCLEAR_WEAPON_ID, applyDetonation } from "../../tools/multiplayer/sim/weapons.js";
import { loadTrig } from "../../tools/multiplayer/sim/trig.js";

loadTrig(readFileSync(new URL("../../tables/trig.bin", import.meta.url)));
const nuclear = byId(NUCLEAR_WEAPON_ID);

test("nuclear damage reaches 200 at the center and falls off over 512 physical pixels", () => {
  assert.equal(nuclear.maxDamage, 200);
  assert.equal(nuclear.blastRadius, 8192);
  assert.equal(nuclear.carveCells, 128);
  const distances = [0, 2048, 4096, 6144, 8191, 8192, 8193];
  const tanks = distances.map((distance, slot) => ({ ...Ballistics.makeTank(slot, 12000 + distance),
    y: 8000 + (Ballistics.TANK_H >> 1) }));
  const hits = Ballistics.computeDamage(12000, 8000, nuclear, tanks);
  assert.deepEqual(hits.map((hit) => hit.dmg), [200, 150, 100, 50, 0]);
  assert.deepEqual(hits.map((hit) => hit.idx), [0, 1, 2, 3, 4]);
});

test("one costly purchase buys exactly one nuclear shot and empty ammo falls back", () => {
  Terrain.grid.fill(Terrain.EMPTY);
  const player = Match.makePlayer(0, "Alpha", false, 5000);
  player.y = 8000;
  assert.equal(nuclear.price, 4800);
  assert.equal(Match.canFire(player, nuclear.id), false);
  player.gold = nuclear.price;
  assert.equal(Match.buyWeapon(player, nuclear.id), true);
  assert.equal(player.gold, 0);
  assert.equal(Match.ammoOf(player, nuclear.id), 1);
  Match.setIntent(player, { angle10: 450, power: 800, weaponId: nuclear.id, moveDx: 0, useShield: false });
  assert.ok(Match.resolveTurn([player, Match.makePlayer(1, "Bravo", false, 24000)], 0).legs.length > 0);
  assert.equal(player.weaponId, nuclear.id);
  assert.equal(Match.ammoOf(player, nuclear.id), 0);
  assert.equal(Match.normalizeIntent(player, player.intent).weaponId, 0);
});

test("nuclear blasts hurt their owner but a shield still blocks the direct blast", () => {
  Terrain.grid.fill(Terrain.EMPTY);
  const players = [0, 1].map((slot) => Match.makePlayer(slot, `Player ${slot}`, false, 12000));
  for (const player of players) player.y = 8000 + (Ballistics.TANK_H >> 1);
  players[1].shieldUp = true;
  const result = Match.applyDetonations(players, [{ x: 12000, y: 8000, weapon: nuclear, owner: 0 }]);
  assert.equal(players[0].hp, Ballistics.MAX_HP - 200);
  assert.equal(players[1].hp, Ballistics.MAX_HP);
  assert.equal(players[1].shieldUp, false);
  assert.ok(result.events.some((event) => event.t === "blocked" && event.slot === 1));
});

test("the larger nuclear crater preserves bedrock and settles without losing uncarved mass", () => {
  for (const [seed, horizontal, vertical] of [[85, 480, 360], [221, 2, 430], [149, 958, 535]]) {
    Terrain.CFG.seed = seed;
    Terrain.grid.set(Mapgen.buildMap(seed)); Terrain.markAll(); Match.settleTerrain();
    const before = Terrain.grid.slice(), beforeMass = Terrain.massCount();
    const impact = { x: horizontal * 32, y: vertical * 32, weapon: nuclear };
    const previous = applyDetonation({ ...impact, weapon: { ...nuclear, carveCells: 80 } });
    Terrain.grid.set(before); Terrain.markAll();
    const result = applyDetonation(impact);
    assert.ok(result.removed >= previous.removed, `seed ${seed}: larger crater cannot remove less material`);
    if (horizontal === 480) assert.ok(result.removed > previous.removed);
    assert.equal(result.filled, 0);
    Terrain.connectivity();
    const settled = Match.settleTerrain();
    assert.equal(settled.forced, false, `seed ${seed}: settlement must terminate naturally`);
    assert.equal(Terrain.massCount(), beforeMass - result.removed);
    for (let index = 0; index < before.length; index++) {
      if (before[index] === Terrain.BEDROCK) assert.equal(Terrain.grid[index], Terrain.BEDROCK);
    }
  }
});
