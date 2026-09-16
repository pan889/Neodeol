import assert from "node:assert/strict";
import { test } from "node:test";
import { ENTITY_SCALE, buildGeology, terrainRelief, drawBackdrop, drawArtillery } from "../../tools/prototype/battlefield-art.js";

function recordingContext() {
  const calls = [];
  let depth = 0;
  const gradient = { addColorStop(position, color) { assert.ok(position >= 0 && position <= 1); assert.equal(typeof color, "string"); } };
  const context = new Proxy({}, {
    get(_target, key) {
      if (key === "save") return () => { depth++; };
      if (key === "restore") return () => { depth--; assert.ok(depth >= 0); };
      if (String(key).startsWith("create")) return () => gradient;
      return (...args) => {
        for (const argument of args) if (typeof argument === "number") assert.ok(Number.isFinite(argument), `${String(key)} nonfinite coordinate`);
        calls.push([key, ...args]);
      };
    },
  });
  return { context, calls, balanced: () => depth === 0 };
}

test("geology cache is reproducible, seed-dependent and material-specific", () => {
  const first = buildGeology(85, 64, 48);
  assert.deepEqual(first, buildGeology(85, 64, 48));
  assert.notDeepEqual(first.textures[4], buildGeology(149, 64, 48).textures[4]);
  assert.equal(first.grain.length, 64 * 48);
  assert.equal(first.textures.length, 6);
  for (let material = 1; material <= 5; material++) {
    assert.equal(first.textures[material].length, 64 * 48);
    assert.ok(new Set(first.textures[material]).size > 20);
    for (let other = 1; other < material; other++) assert.notDeepEqual(first.textures[material], first.textures[other]);
  }
});

test("relief reads the grid without changing material or mass", () => {
  const width = 40, height = 40;
  const grid = new Uint8Array(width * height);
  grid.fill(4, 10 * width);
  const original = grid.slice();
  assert.ok(terrainRelief(grid, width, height, 20, 10) > terrainRelief(grid, width, height, 20, 30));
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) assert.ok(Number.isFinite(terrainRelief(grid, width, height, column, row)));
  }
  assert.deepEqual(grid, original);
  assert.equal(terrainRelief(grid, width, height, 20, 0), 0);
});

test("relief invalidation fits the twelve-row dirty halo after destruction and deposit", () => {
  const width = 40, height = 60, changedRow = 27;
  const before = new Uint8Array(width * height).fill(4);
  const after = before.slice();
  after[changedRow * width + 20] = 0;
  for (let row = 0; row < height; row++) {
    if (Math.abs(row - changedRow) <= 12) continue;
    for (let column = 0; column < width; column++) {
      assert.equal(terrainRelief(before, width, height, column, row), terrainRelief(after, width, height, column, row));
    }
  }
});

test("tiny maps and map edges produce bounded texture values", () => {
  for (const [width, height] of [[1, 1], [1, 17], [17, 1], [31, 24]]) {
    const geology = buildGeology(0xffffffff, width, height);
    assert.equal(geology.grain.length, width * height);
    for (const material of geology.textures) assert.ok(material.every((value) => value >= -127 && value <= 127));
  }
});

test("backdrop restores Canvas state and uses finite coordinates", () => {
  const recorder = recordingContext();
  drawBackdrop(recorder.context, 960, 540, 85);
  assert.equal(recorder.balanced(), true);
  assert.ok(recorder.calls.length > 500);
});

test("artillery muzzle stays at the supplied physical pivot and barrel length", () => {
  assert.equal(ENTITY_SCALE, 2);
  for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI]) {
    for (const tilt of [-.244, 0, .244]) {
      const recorder = recordingContext();
      const options = Object.freeze({ horizontal: 120, vertical: 150, width: 17.04, height: 8,
        barrelLength: 5, angle, tilt, team: "#3DDCFF", slot: 0, now: 1500, recoil: 0 });
      const muzzle = drawArtillery(recorder.context, options);
      assert.ok(Math.abs(muzzle.muzzleX - (120 + Math.sin(tilt) * 8 + Math.cos(angle) * 5)) < 1e-10);
      assert.ok(Math.abs(muzzle.muzzleY - (150 - Math.cos(tilt) * 8 - Math.sin(angle) * 5)) < 1e-10);
      assert.ok(recorder.calls.length > 100);
      assert.equal(recorder.balanced(), true);
    }
  }
});

test("a supplied simulation muzzle stays exact while the chassis tilt is interpolated", () => {
  const muzzle = Object.freeze({ x: 123.03125, y: 142.96875 });
  const angle = .8, barrelLength = 5;
  const recorder = recordingContext();
  const result = drawArtillery(recorder.context, { horizontal: 120, vertical: 150,
    width: 17.04, height: 8, barrelLength, angle, tilt: -.1, muzzle,
    team: "#3DDCFF", slot: 0 });
  assert.deepEqual(result, { muzzleX: muzzle.x, muzzleY: muzzle.y });
  const pivot = recorder.calls.filter(([name]) => name === "translate")[1];
  assert.deepEqual(pivot, ["translate", muzzle.x - Math.cos(angle) * barrelLength, muzzle.y + Math.sin(angle) * barrelLength]);
  assert.equal(recorder.balanced(), true);
});

test("damage, destruction, recoil and reduced motion do not alter pose inputs", () => {
  for (const alive of [true, false]) {
    for (const reducedMotion of [true, false]) {
      const recorder = recordingContext();
      const options = Object.freeze({ horizontal: 15, vertical: 30, width: 17.04, height: 8,
        barrelLength: 5, angle: Math.PI, tilt: 0, team: "#B4FF3D", slot: 1,
        now: 10000, recoil: 1, health: alive ? 20 : 0, alive, reducedMotion });
      const result = drawArtillery(recorder.context, options);
      assert.equal(result.muzzleX, 10);
      assert.equal(result.muzzleY, 22);
      assert.equal(recorder.balanced(), true);
    }
  }
});
