import assert from "node:assert/strict";
import { test } from "node:test";
import { SHELL_STYLES, shellStyle, projectilePose, drawProjectile, createEffectSprites,
  drawFlightTrail, drawMuzzleFlash, drawImpact, drawCombatParticle, sampleSurface, drawWindField } from "../../tools/prototype/combat-art.js";
import { TANK_VISUAL_SCALE } from "../../tools/prototype/battlefield-art.js";
import { WEAPONS } from "../../tools/multiplayer/sim/weapons.js";

function recorder() {
  const calls = [], stack = [], target = { globalAlpha: 1, globalCompositeOperation: "source-over" };
  const gradient = { addColorStop(position, color) {
    assert.ok(Number.isFinite(position) && position >= 0 && position <= 1);
    assert.match(color, /^#[0-9a-f]{6}([0-9a-f]{2})?$/i);
    calls.push(["stop", position, color]);
  } };
  const context = new Proxy(target, {
    get(object, key) {
      if (key in object) return object[key];
      if (key === "save") return () => stack.push({ ...object });
      if (key === "restore") return () => { assert.ok(stack.length > 0); Object.assign(object, stack.pop()); };
      if (String(key).startsWith("create")) return (...values) => {
        assert.ok(values.every(Number.isFinite)); calls.push([key, ...values]); return gradient;
      };
      return (...values) => {
        for (const value of values) if (typeof value === "number") assert.ok(Number.isFinite(value), `${String(key)} contains a non-finite coordinate`);
        if (key === "arc") assert.ok(values[2] >= 0);
        if (key === "ellipse") assert.ok(values[2] >= 0 && values[3] >= 0);
        calls.push([key, ...values]);
      };
    },
    set(object, key, value) {
      if (key === "globalAlpha") assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `invalid opacity ${value}`);
      object[key] = value; return true;
    },
  });
  return { context, calls, verify() {
    assert.equal(stack.length, 0); assert.equal(target.globalAlpha, 1); assert.equal(target.globalCompositeOperation, "source-over");
  } };
}

const sprites = { smoke: { name: "smoke" }, dust: { name: "dust" }, fire: { name: "fire" } };
function flight(points = [[20, 60], [30, 30], [40, 20]], kind = "main", weaponId = 0) {
  return Object.freeze({ start: 3, duration: Math.max(1, points.length - 1), weaponId,
    leg: Object.freeze({ kind, slot: 0, pts: Object.freeze(points.map(([horizontal, vertical]) => Object.freeze({ x: horizontal * 32, y: vertical * 32 }))) }) });
}

test("all weapons have distinct immutable shell silhouettes and a safe fallback", () => {
  assert.equal(TANK_VISUAL_SCALE, 1.12);
  assert.equal(SHELL_STYLES.length, WEAPONS.length);
  assert.equal(new Set(SHELL_STYLES.map((style) => style.shape)).size, WEAPONS.length);
  assert.equal(shellStyle(-1), SHELL_STYLES[0]);
  assert.equal(shellStyle(200), SHELL_STYLES[0]);
  for (const weapon of WEAPONS) assert.ok(Object.isFrozen(shellStyle(weapon.id)));
});

test("projectile position matches interpolation and tangent rotation follows its actual leg", () => {
  const track = flight();
  const pose = projectilePose(track, 3.5, 32);
  assert.equal(pose.horizontal, 25); assert.equal(pose.vertical, 45);
  assert.equal(pose.angle, Math.atan2(-30, 10));
  assert.equal(projectilePose(track, 5, 32).angle, Math.atan2(-10, 10));
  assert.equal(projectilePose(track, 2, 32), null);
  assert.equal(projectilePose(track, 6, 32), null);
  assert.equal(projectilePose(flight([]), 3, 32), null);
  for (const points of [[[10, 10]], [[10, 10], [10, 10]], [[10, 10], [10, 10], [10, 20]]]) {
    assert.ok(Number.isFinite(projectilePose(flight(points), 3, 32).angle));
  }
  assert.equal(projectilePose(flight([[2, 4], [2, 8]], "burrow", 3), 3.5, 32).angle, Math.PI / 2);
  assert.equal(projectilePose(flight([[8, 4], [2, 4]], "roll", 4), 3.5, 32).angle, Math.PI);
  assert.equal(projectilePose(flight(undefined, "main", 7), 4, 32).weaponId, 7);
});

test("every shell draws unique geometry with balanced Canvas state, including split children", () => {
  const signatures = new Set();
  for (const weapon of WEAPONS) {
    const output = recorder();
    const options = Object.freeze({ horizontal: 30, vertical: 40, weaponId: weapon.id, now: 1500, angle: -.7 });
    drawProjectile(output.context, options); output.verify();
    signatures.add(JSON.stringify(output.calls));
    for (const kind of ["main", "split", "burrow", "roll"]) {
      for (const reducedMotion of [false, true]) {
        const child = recorder(); drawProjectile(child.context, { ...options, kind, reducedMotion }); child.verify();
      }
    }
  }
  assert.equal(signatures.size, WEAPONS.length);
});

test("particle textures are generated once on reusable canvases", () => {
  const contexts = [];
  const textures = createEffectSprites(() => {
    const output = recorder(); contexts.push(output);
    return { getContext: () => output.context };
  });
  assert.equal(contexts.length, 3);
  for (const texture of Object.values(textures)) { assert.equal(texture.width, 96); assert.equal(texture.height, 96); }
  for (const output of contexts) output.verify();
});

test("impact stages, deposit and shield effects remain finite and restore Canvas state", () => {
  for (const weapon of WEAPONS) {
    const effect = Object.freeze({ x: 100, y: 200, size: weapon.carveCells || 30, weaponId: weapon.id,
      deposit: weapon.kind === "deposit", nuclear: weapon.id === 7, at: 1000 });
    for (const age of [-1, 0, 1, 80, 200, 520, 800, 1150, 2200, 3499, 4000]) {
      for (const reducedMotion of [false, true]) {
        const output = recorder();
        drawImpact(output.context, effect, 1000 + age, { wind: -5, sprites, reducedMotion }); output.verify();
      }
    }
  }
  const output = recorder();
  drawImpact(output.context, { x: 0, y: 0, size: 18, shield: true, at: 0 }, 100, { sprites }); output.verify();
});

test("reduced motion disables muzzle flashes, particle motion and screen-blended fire", () => {
  const output = recorder();
  drawMuzzleFlash(output.context, { x: 1, y: 2, dx: 1, dy: 0, at: 0 }, 100, true);
  drawCombatParticle(output.context, { kind: "spark" }, sprites, true);
  assert.equal(output.calls.length, 0);
  drawImpact(output.context, { x: 1, y: 2, size: 80, nuclear: true, weaponId: 7, at: 0 }, 100, { sprites, reducedMotion: true });
  assert.equal(output.calls.some(([name]) => name === "drawImage" || String(name).startsWith("create")), false);
  output.verify();
});

test("flight trails, contact debris and muzzle flashes never mutate tracks", () => {
  for (const kind of ["main", "split", "burrow", "roll"]) {
    const track = flight(undefined, kind, 3), original = JSON.stringify(track), output = recorder();
    const pose = projectilePose(track, 4.5, 32);
    drawFlightTrail(output.context, track, pose, 32, { now: 1800, wind: 4, sprites });
    drawMuzzleFlash(output.context, { x: 10, y: 20, dx: -1, dy: 0, weaponId: 3, at: 1000 }, 1080, false);
    output.verify(); assert.equal(JSON.stringify(track), original);
  }
  for (const kind of ["smoke", "dust", "spark", "debris"]) {
    const output = recorder();
    drawCombatParticle(output.context, Object.freeze({ x: 30, y: 30, vx: 2, vy: -10, size: 2, life: .3, max: 1, kind, color: "#e9b271" }), sprites);
    output.verify();
  }
});

test("wind surface sampling follows destroyed terrain without changing material cells", () => {
  const width = 100, height = 80, grid = new Uint8Array(width * height);
  grid.fill(4, 45 * width);
  const before = grid.slice(), surface = sampleSurface(grid, width, height);
  assert.ok(surface.every((point) => point.vertical === 45));
  assert.deepEqual(sampleSurface(new Uint8Array(width * height), width, height), []);
  assert.deepEqual(sampleSurface(new Uint8Array(1), 1, 1), []);
  for (const wind of [-5, 0, 5]) {
    for (const reducedMotion of [false, true]) {
      const output = recorder();
      drawWindField(output.context, { width, height, grid, surface, wind, now: 2500, seed: 85, sprites, reducedMotion }); output.verify();
    }
  }
  assert.deepEqual(grid, before);
  grid.fill(0, 45 * width, 50 * width);
  assert.ok(sampleSurface(grid, width, height).every((point) => point.vertical === 50));
});

test("reduced-motion wind scenery is time-invariant and calm wind emits no flow ribbons", () => {
  const grid = new Uint8Array(100 * 80), surface = sampleSurface(grid, 100, 80);
  const options = { width: 100, height: 80, grid, surface, wind: 5, seed: 10, sprites, reducedMotion: true };
  const first = recorder(), second = recorder();
  drawWindField(first.context, { ...options, now: 1000 });
  drawWindField(second.context, { ...options, now: 9000 });
  assert.deepEqual(first.calls, second.calls); first.verify(); second.verify();
  const calm = recorder();
  drawWindField(calm.context, { ...options, now: 1000, wind: 0, reducedMotion: false });
  assert.equal(calm.calls.some(([name]) => name === "bezierCurveTo" || name === "drawImage"), false); calm.verify();
});
