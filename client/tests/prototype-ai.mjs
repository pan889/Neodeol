/* ═══════════════════════════════════════════════════════════════════════════
   프로토타입 AI 경로 — 브라우저 없이도 잡히게

     node client/tests/prototype-ai.mjs

   **왜 이 검사가 있나.** AI 를 `tools/prototype/ai.js` 로 분리할 때 `match.js` 클로저
   안의 헬퍼(`ammoOf`·`buyItem`·`buyWeapon`)를 `M.*` 로 안 바꿔서 `ReferenceError` 가 났다.
   슬롯 1 이 AI 이므로 **플레이어가 한 발 쏜 직후 판이 멈췄다.**

   pytest 도 `verify-stack` 도 이걸 못 잡는다 — Chrome E2E 는 네트워크 모드만 열고,
   그 모드에는 AI 가 없다. 로컬 핫시트를 사람이 열어보기 전까지 아무도 모른다.
   그래서 **생성 사본 위에서 AI 를 직접 돌리는** 검사를 둔다. rAF 와 무관하다.
   ═══════════════════════════════════════════════════════════════════════════ */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const R = "\x1b[31m", G = "\x1b[32m", D = "\x1b[2m", X = "\x1b[0m";
let failures = 0;

function check(pass, label, detail = "") {
  if (pass) console.log(`  ${G}PASS${X}  ${label}${detail ? `  ${D}${detail}${X}` : ""}`);
  else { failures++; console.log(`  ${R}FAIL${X}  ${label}${detail ? `  ${detail}` : ""}`); }
}

const sim = (name) => path.join(ROOT, "tools", "multiplayer", "sim", name);
const T = await import(sim("terrain.js"));
const P = await import(sim("ballistics.js"));
const M = await import(sim("match.js"));
const Mg = await import(sim("mapgen.js"));
const Trig = await import(sim("trig.js"));
const { hash32 } = await import(sim("intmath.js"));
const AI = await import(path.join(ROOT, "tools", "prototype", "ai.js"));

Trig.loadTrig(new Uint8Array(fs.readFileSync(path.join(ROOT, "tables", "trig.bin"))));

console.log(`\n프로토타입 AI — 생성 사본 위에서 직접 돌린다`);

/* 로컬 핫시트가 하는 것과 같은 초기화 (index.html newMatch) */
const seed = 0x55;
T.CFG.seed = seed;
T.grid.set(Mg.buildMap(seed));
T.connectivity();
T.markAll();
T.setStep(0);
let settled = false;
for (let s = 0; s < 40000; s++) if (T.step().mobile === 0) { settled = true; break; }
check(settled, "정규 맵 생성기 지형이 정착한다");

const cells = Mg.chooseSpawnCells(T.grid, 2);
const players = cells.map((c, i) => M.makePlayer(i, `P${i}`, i === 1, c * P.CELL_SUBPX));
M.beginRound(players, cells, 0);
check(players.length === 2 && players.every((p) => p.alive), "스폰과 라운드 시작");

/* ── AI intent — 여기가 터지면 AI 턴에서 판이 멈춘다 ───────────────────── */
let threw = null;
const intents = [];
try {
  for (let turn = 1; turn <= 8; turn++) {
    intents.push(AI.aiIntent(players, players[1], turn % 3 - 1, turn, seed, 2));
  }
} catch (error) {
  threw = error;
}
check(threw === null, "aiIntent 가 8턴 연속 예외 없이 intent 를 만든다",
  threw ? `${threw.constructor.name}: ${threw.message}` : "");

if (threw === null) {
  const valid = intents.every((it) =>
    Number.isInteger(it.angle10) && it.angle10 >= 0 && it.angle10 <= 1800
    && Number.isInteger(it.power) && it.power >= 0 && it.power <= 1000
    && Number.isInteger(it.weaponId) && it.weaponId >= 0);
  check(valid, "intent 가 전부 정규 범위 안의 정수다");
  /* 무기를 골라 쓰는지 — 항상 0번만 쏘면 `ammoOf` 가 죽어 있어도 통과할 수 있다 */
  const weapons = new Set(intents.map((it) => it.weaponId));
  check(weapons.size >= 2, "AI 가 무기를 골라 쓴다 (`ammoOf` 가 살아 있다)",
    `사용 ${[...weapons].sort().join(",")}`);
}

/* ── aiShop — `buyWeapon`·`buyItem` 이 살아 있는가 ────────────────────── */
let shopThrew = null;
let bought = [];
try {
  players[1].gold = 5000;
  bought = AI.aiShop(players[1], seed, 1);
} catch (error) {
  shopThrew = error;
}
check(shopThrew === null, "aiShop 이 예외 없이 돈다",
  shopThrew ? `${shopThrew.constructor.name}: ${shopThrew.message}` : "");
check(shopThrew === null && bought.length > 0, "AI 가 실제로 무언가를 산다",
  bought.length ? bought.join(" · ") : "");

/* ── AI 턴을 실제로 해결한다 — 발사부터 정착까지 ──────────────────────── */
let turnThrew = null;
try {
  players[1].intent = AI.aiIntent(players, players[1], 0, 1, seed, 2);
  players[0].intent = null;
  const resolved = M.resolveTurn(players, 0);
  M.applyDetonations(players, resolved.dets);
  for (let s = 0; s < 40000; s++) if (T.step().mobile === 0) break;
  M.applyPhase(players, resolved.dets.length ? resolved.dets.at(-1).owner : null);
} catch (error) {
  turnThrew = error;
}
check(turnThrew === null, "AI 턴이 발사→폭발→정착→재배치까지 완주한다",
  turnThrew ? `${turnThrew.constructor.name}: ${turnThrew.message}` : "");

/* ── 전체 게임 완주 — index.html 의 턴 순서를 그대로 따른다 ─────────────
   `beginTurn → resolveTurn → applyDetonations → 정착 → applyPhase → roundOutcome`
   그리고 라운드 경계에서 `closeRound → aiShop → chooseSpawnCells → beginRound`.
   rAF 와 타이머만 빼면 이게 로컬 핫시트의 전부다. **한 발 쏘고 멈추면 여기서 잡힌다.** */
const MAP_SEED = 0x77;
const SLOTS = 4;
const CONN_MAX = 8;

function nextWind(mapSeed, turnNo, previousWind) {
  const maxWind = P.CFG.windMax;
  if (maxWind <= 0) return 0;
  const roll = hash32(mapSeed ^ 0x5715, turnNo, previousWind, 0) % 20;
  const delta = roll === 0 ? -3 : roll === 19 ? 3 : roll < 8 ? -1 : roll < 12 ? 0 : 1;
  const candidate = previousWind + delta;
  if (candidate > maxWind) return maxWind - (candidate - maxWind);
  if (candidate < -maxWind) return -maxWind + (-maxWind - candidate);
  return Math.max(-maxWind, Math.min(maxWind, candidate));
}

function settleAll() {
  let steps = 0;
  let conn = 0;
  for (;;) {
    if (steps >= 12000) { T.clearActive(); return { steps, forced: true }; }
    const r = T.step();
    steps++;
    if (r.mobile !== 0) continue;
    const filled = T.connectivity();
    if (filled === 0) return { steps, forced: false };
    if (++conn >= CONN_MAX) { T.clearActive(); return { steps, forced: true }; }
  }
}

const game = { turnNo: 0, wind: 0, turns: 0, rounds: 0, shots: 0, kills: 0, forced: 0 };
let gameThrew = null;
try {
  T.CFG.seed = MAP_SEED;
  T.grid.set(Mg.buildMap(MAP_SEED));
  T.connectivity(); T.markAll(); T.setStep(0);
  settleAll();

  let spawnCells = Mg.chooseSpawnCells(T.grid, SLOTS);
  /* 슬롯 0 만 사람 — 사람 턴 뒤 AI 턴이 오는 게 사용자가 본 그 순서다 */
  const roster = spawnCells.map((c, i) => M.makePlayer(i, `P${i}`, i > 0, c * P.CELL_SUBPX));
  M.beginRound(roster, spawnCells, 0);

  let round = 1;
  let roundTurn = 0;
  let cur = 0;

  const nextAlive = (from) => {
    for (let o = 1; o <= roster.length; o++) {
      const slot = (from + o) % roster.length;
      if (roster[slot].alive) return slot;
    }
    return from;
  };

  for (let guard = 0; guard < 4000 && round <= M.RULES.rounds; guard++) {
    /* beginTurn */
    game.turnNo++; roundTurn++; game.turns++;
    T.CFG.seed = hash32(MAP_SEED, game.turnNo, 0, 0);
    game.wind = nextWind(MAP_SEED, game.turnNo, game.wind);
    for (const pl of roster) pl.intent = null;
    if (!roster[cur].alive) cur = nextAlive(cur);
    const actor = roster[cur];
    /* 사람이든 AI 든 여기서는 AI 가 대신 조준한다 — 사람 쪽 UI 만 빠진 것 */
    actor.intent = AI.aiIntent(roster, actor, game.wind, game.turnNo, MAP_SEED, 2);

    /* resolve */
    const r = M.resolveTurn(roster, game.wind);
    game.shots += r.legs.length;
    const before = roster.filter((p) => p.alive).length;
    M.applyDetonations(roster, r.dets);
    T.setStep(0);
    const settle = settleAll();
    if (settle.forced) game.forced++;
    M.applyPhase(roster, r.dets.length ? r.dets[r.dets.length - 1].owner : null);
    game.kills += before - roster.filter((p) => p.alive).length;

    const out = M.roundOutcome(roster, roundTurn);
    if (!out.over) { cur = nextAlive(cur); continue; }

    /* endRound */
    M.closeRound(roster, out);
    game.rounds++;
    if (round >= M.RULES.rounds) break;
    for (const pl of roster) if (pl.isAI) AI.aiShop(pl, MAP_SEED, round);
    round++;
    spawnCells = Mg.chooseSpawnCells(T.grid, roster.length);
    M.beginRound(roster, spawnCells, round - 1);
    roundTurn = 0;
    cur = (round - 1) % roster.length;
  }
} catch (error) {
  gameThrew = error;
}

check(gameThrew === null, "4인 5라운드 게임이 예외 없이 완주한다",
  gameThrew ? `${gameThrew.constructor.name}: ${gameThrew.message}` : `턴 ${game.turns} · 발사 ${game.shots} · 격추 ${game.kills}`);
check(gameThrew === null && game.rounds === M.RULES.rounds,
  `${M.RULES.rounds} 라운드가 전부 종료된다`, `종료 ${game.rounds}`);
check(gameThrew === null && game.turns > SLOTS,
  "한 발에서 멈추지 않고 턴이 계속 넘어간다", `턴 ${game.turns}`);
check(gameThrew === null && game.kills > 0,
  "실제로 격추가 일어난다 (피해가 0 이 아니다)", `격추 ${game.kills}`);
check(gameThrew === null && game.forced === 0,
  "정착이 강제 종료 없이 수렴한다", `강제 ${game.forced}회`);

console.log();
if (failures === 0) console.log(`${G}전부 통과.${X}`);
else console.log(`${R}${failures}건 실패.${X}`);
process.exit(failures === 0 ? 0 : 1);
