import assert from "node:assert/strict";
import { test } from "node:test";
import { OPERATIONS, PROFILE_KEY, loadProfile, normalizeProfile, recordResult, saveProfile } from "../../tools/prototype/operations.js";

function memoryStorage(initial) {
  const values = new Map(initial ? [[PROFILE_KEY, initial]] : []);
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

const blockedStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };

test("operations reuse supported AI levels and canonical map seeds", () => {
  assert.equal(OPERATIONS.length, 3);
  assert.equal(new Set(OPERATIONS.map((operation) => operation.id)).size, 3);
  for (const operation of OPERATIONS) {
    assert.ok(["easy", "normal", "hard"].includes(operation.level));
    assert.ok(operation.players >= 2 && operation.players <= 6);
    assert.ok(Number.isInteger(operation.seed) && operation.seed >= 0 && operation.seed <= 255);
  }
});

test("empty storage initializes a versioned profile", () => {
  const storage = memoryStorage();
  const loaded = loadProfile(storage);
  assert.equal(loaded.persistent, true);
  assert.deepEqual(loaded.profile, normalizeProfile(null));
  assert.equal(JSON.parse(storage.getItem(PROFILE_KEY)).version, 1);
});

test("unavailable and corrupt storage cannot prevent playing", () => {
  assert.equal(loadProfile(blockedStorage).persistent, false);
  assert.deepEqual(loadProfile(memoryStorage("not json")).profile, normalizeProfile(null));
  assert.equal(saveProfile(blockedStorage, normalizeProfile(null)), false);
});

test("untrusted records are normalized and unsupported versions are discarded", () => {
  const malformed = normalizeProfile({ version: 1, operations: { "first-light": { completed: 2, wins: 500, bestScore: "<script>" } } });
  assert.deepEqual(malformed.operations["first-light"], { completed: 2, wins: 2, bestScore: 0 });
  assert.deepEqual(normalizeProfile({ version: 999, operations: { "first-light": { completed: 5 } } }), normalizeProfile(null));
  assert.deepEqual(normalizeProfile({ version: 1, operations: { "first-light": { completed: -1, wins: Infinity, bestScore: NaN } } }), normalizeProfile(null));
});

test("wins, losses and ties are recorded without mutating the previous profile", () => {
  const initial = normalizeProfile(null);
  const players = [{ slot: 0, isAI: false, score: 300 }, { slot: 1, isAI: true, score: 150 }];
  const victory = recordResult(initial, "first-light", players);
  assert.deepEqual(victory.operations["first-light"], { completed: 1, wins: 1, bestScore: 300 });
  assert.equal(initial.operations["first-light"].completed, 0);
  players[1].score = 300;
  const tied = recordResult(victory, "first-light", players);
  assert.deepEqual(tied.operations["first-light"], { completed: 2, wins: 1, bestScore: 300 });
  players[1].score = 500;
  const lost = recordResult(tied, "first-light", players);
  assert.deepEqual(lost.operations["first-light"], { completed: 3, wins: 1, bestScore: 300 });
});

test("custom matches and incomplete results do not create operation records", () => {
  const initial = normalizeProfile(null);
  assert.deepEqual(recordResult(initial, "unknown", []), initial);
  assert.deepEqual(recordResult(initial, "first-light", [{ slot: 0, isAI: false, score: 50 }]), initial);
  assert.deepEqual(recordResult(initial, "first-light", [{ slot: 0, isAI: true, score: 50 }, { slot: 1, isAI: true, score: 20 }]), initial);
});

test("completed results survive a storage round trip", () => {
  const storage = memoryStorage();
  const result = recordResult(normalizeProfile(null), "fault-line", [{ slot: 0, isAI: false, score: 450 }, { slot: 1, isAI: true, score: 0 }]);
  assert.equal(saveProfile(storage, result), true);
  assert.deepEqual(loadProfile(storage).profile, result);
});
