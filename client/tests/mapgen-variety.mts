import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as Mapgen from "../src/sim/mapgen.ts";
import * as Terrain from "../src/sim/terrain.ts";
import * as Match from "../src/sim/match.ts";
import { loadTrig } from "../src/sim/trig.ts";

loadTrig(new Uint8Array(readFileSync(new URL("../../tables/trig.bin", import.meta.url))));
const seeds = [...Array.from({ length: 32 }, (_value, index) => index * 7919 + 4096), 0, 1, 85, 149, 221, 0xdeadbeef, 0xffffffff];
const specs = Array.from({ length: 6 }, (_value, slot) => ({ name: `Player ${slot}`, isAI: slot > 0 }));

test("mountains survive settlement and all six starting tanks have safe ground", () => {
  let maxSteps = 0;
  for (const seed of seeds) {
    const { state, initialSettle } = Match.createMatch(seed, specs);
    assert.equal(initialSettle.forced, false);
    maxSteps = Math.max(maxSteps, initialSettle.steps);
    const surface = Array.from({ length: Terrain.W }, (_value, column) => Mapgen.surfaceCellY(Terrain.grid, column));
    const heightDifference = Math.max(...surface.slice(2, -2)) - Math.min(...surface.slice(2, -2));
    assert.ok(heightDifference >= 130, `${seed}: mountain relief ${heightDifference}`);
    assert.deepEqual(state.spawnCells, Mapgen.chooseSpawnCells(Terrain.grid, 6, seed));
    for (const [index, column] of state.spawnCells.entries()) {
      assert.ok(column >= 20 && column < Terrain.W - 20);
      assert.ok(surface[column] < Terrain.H - 12);
      const relief = Math.abs(surface[column - 6] - surface[column]) + Math.abs(surface[column + 6] - surface[column]);
      assert.ok(relief <= Mapgen.SPAWN_MAX_RELIEF, `${seed}: unsafe slope ${relief}`);
      for (const other of state.spawnCells.slice(index + 1)) assert.ok(Math.abs(column - other) >= Mapgen.SPAWN_MIN_GAP);
    }
  }
  assert.ok(maxSteps <= 120, `initial settlement ${maxSteps} steps exceeds startup budget`);
  console.log(`mountain startup: ${seeds.length} seeds, max ${maxSteps} steps`);
});

test("seeded spawning includes close and distant fights and changes the human side", () => {
  const grid = Mapgen.buildMap(85);
  const snapshot = grid.slice();
  let closest = Terrain.W, farthest = 0, humanLeft = 0, humanRight = 0;
  const layouts = new Set();
  for (let seed = 0; seed < 128; seed++) {
    const cells = Mapgen.chooseSpawnCells(grid, 2, seed);
    assert.deepEqual(cells, Mapgen.chooseSpawnCells(grid, 2, seed));
    const gap = Math.abs(cells[0] - cells[1]);
    closest = Math.min(closest, gap); farthest = Math.max(farthest, gap);
    if (cells[0] < cells[1]) humanLeft++; else humanRight++;
    layouts.add(cells.join(","));
  }
  assert.ok(closest <= 72 && closest >= Mapgen.SPAWN_MIN_GAP);
  assert.ok(farthest >= 700);
  assert.ok(humanLeft > 30 && humanRight > 30);
  assert.ok(layouts.size > 100);
  assert.deepEqual(grid, snapshot);
});

test("spawning refuses a map with no ground instead of returning overlapping positions", () => {
  assert.throws(() => Mapgen.chooseSpawnCells(new Uint8Array(Terrain.N), 2, 85), /ground/);
});
