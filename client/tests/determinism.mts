/* ═══════════════════════════════════════════════════════════════════════════
   Phase 2 결정론 게이트   docs/roadmap.md Phase 2 완료 조건

     node --experimental-strip-types client/tests/determinism.mts

   1. 같은 시드 + 같은 입력을 **100회** 재생해 체크섬이 전부 같다
   2. 순회 순서(정순/역순/짝홀)를 바꿔도 체크섬이 같다 — 절대 규칙 3
   3. 우선순위 동점 0건
   4. 활성 행이 이동 가능한 셀을 굶기지 않는다
   5. `tables/trig.bin` 이 고정 해시와 일치한다
   6. ★ **TS 이식이 Phase 0 의 JS 참조 구현과 같은 체크섬을 낸다** ★

   6번이 이 파일의 핵심이다. Phase 2 완료 조건 "Phase 1 과 체감이 동일하다"를
   주관적 판단이 아니라 **비트 단위 비교**로 판정한다. 같은 초기 격자에 같은 스텝을
   돌려 체크섬이 다르면 이식이 잘못된 것이다.
   ═══════════════════════════════════════════════════════════════════════════ */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import * as Terrain from "../src/sim/terrain.ts";
import { loadTrig, TRIG_BYTES } from "../src/sim/trig.ts";
import { hex8, isqrt, floorDiv, hash32 } from "../src/sim/intmath.ts";
import * as B from "../src/sim/ballistics.ts";
import * as Match from "../src/sim/match.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const require = createRequire(import.meta.url);

const G = "\x1b[32m", R = "\x1b[31m", C = "\x1b[36m", D = "\x1b[2m", X = "\x1b[0m";
let failures = 0;
const head = (s: string) => console.log(`\n${C}${s}${X}`);
const line = (s: string) => console.log(`  ${D}${s}${X}`);
function check(pass: boolean, label: string, detail = ""): void {
  if (!pass) failures++;
  console.log(`  ${pass ? G + "PASS" : R + "FAIL"}${X}  ${label}${detail ? "  " + D + detail + X : ""}`);
}

/* ── trig.bin ─────────────────────────────────────────────────────────── */
const TRIG_SHA = "100aa8d037821279b236d69f632f87c43c74e8b700d503e881672e35b6a0a61b";
const trigPath = path.join(ROOT, "tables", "trig.bin");
const trigBytes = new Uint8Array(fs.readFileSync(trigPath));
loadTrig(trigBytes);

head("1. tables/trig.bin");
{
  const { createHash } = require("node:crypto");
  const sha = createHash("sha256").update(trigBytes).digest("hex");
  check(trigBytes.length === TRIG_BYTES, "크기 7,204 바이트", `${trigBytes.length}`);
  check(sha === TRIG_SHA, "sha256 고정값 일치", sha.slice(0, 16) + "…");
  line("의도적으로 바꿨다면 커밋 메시지에 이유를 적고 이 파일의 TRIG_SHA 를 갱신한다");
}

/* ── 정수 헬퍼 ─────────────────────────────────────────────────────────── */
head("2. 정수 헬퍼 (simulation.md §2.2 · §5.1)");
{
  check(floorDiv(-7, 2) === -4, "floorDiv(-7,2) === -4 (JS 의 (-7/2)|0 은 -3)", `${floorDiv(-7, 2)}`);
  check(floorDiv(7, 2) === 3 && floorDiv(-8, 2) === -4 && floorDiv(0, 3) === 0, "floorDiv 경계값");
  let ok = true;
  for (let n = 0; n < 20000; n++) {
    const r = isqrt(n);
    if (r * r > n || (r + 1) * (r + 1) <= n) { ok = false; break; }
  }
  check(ok, "isqrt 가 floor(sqrt(n)) 이다 (n = 0..19999)");
  check(isqrt(1024 * 1024) === 1024, "isqrt(1048576) === 1024");
  /* 해시 품질 — bit0 이 입력 비트의 XOR 패리티면 안 된다 (terrain.md §7.1.1) */
  const par = (a: number) => (a ^ (a >>> 8) ^ (a >>> 16) ^ (a >>> 24)) & 1;
  let linear = 0;
  const SAMPLES = 200000;
  for (let t = 0; t < SAMPLES; t++) {
    const x = (t * 37) % 960, y = (t * 53) % 540;
    const v = (0x55 ^ Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77) ^ Math.imul(t, 0xc2b2ae3d)) >>> 0;
    if ((hash32(0x55, x, y, t) & 1) === (1 ^ par(v))) linear++;
  }
  const rate = linear / SAMPLES;
  check(rate > 0.48 && rate < 0.52, "해시 bit0 이 입력 패리티로 예측되지 않는다",
        `선형예측 ${(rate * 100).toFixed(2)}% (1.0 이면 확산 단계 누락)`);
}

/* ── 시나리오 빌더 ──────────────────────────────────────────────────────
   테스트 안에서 직접 만든다. `lab.js` 프리셋은 [TOOL] 이라 sim 이 의존하면 안 된다.
   JS 참조 구현과 **같은 격자**를 만들어야 하므로 순수 정수 절차로 짠다. */
const { W, H, EMPTY, SAND, SOIL, SCREE, ROCK, BEDROCK } = Terrain;

function buildScenario(target: Uint8Array, seed: number): void {
  target.fill(EMPTY);
  const bands: Array<[number, number]> = [
    [SAND, 16], [SOIL, 30], [SAND, 10], [SCREE, 14], [SOIL, 44], [ROCK, 26],
  ];
  for (let x = 0; x < W; x++) {
    /* 정수 값노이즈 — hash32 를 재사용한다 (decisions.md B1 추천안과 같은 방식) */
    const i = x >> 7, f = x - (i << 7);
    const a = hash32(seed, i, 11, 0) & 0xffff;
    const b = hash32(seed, i + 1, 11, 0) & 0xffff;
    const nz = a + (((b - a) * f) >> 7);
    let y = 180 + (((nz - 32768) * 70) >> 16);
    if (y < 20) y = 20;
    for (const [m, t] of bands) {
      for (let k = 0; k < t && y < H; k++, y++) target[y * W + x] = m;
    }
    for (; y < H; y++) target[y * W + x] = y >= 522 ? BEDROCK : ROCK;
  }
  /* 좌우 경계 봉인 — terrain.md §1.1. 없으면 최외곽 열이 매 스텝 유출된다 */
  for (const x of [0, 1, W - 2, W - 1]) {
    const ref = x < 2 ? 2 : W - 3;
    let top = H;
    for (let y = 0; y < H; y++) if (target[y * W + ref] !== EMPTY) { top = y; break; }
    for (let y = top; y < H; y++) target[y * W + x] = BEDROCK;
  }
  /* 구덩이 몇 개 — 붕괴가 실제로 일어나게 만든다 */
  for (const [cx, cy, r] of [[240, 210, 34], [520, 190, 46], [760, 220, 28]]) {
    for (let y = cy - r; y <= cy + r; y++) {
      if (y < 0 || y >= H) continue;
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || x >= W) continue;
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r * r && target[y * W + x] !== BEDROCK) target[y * W + x] = EMPTY;
      }
    }
  }
}

function loadScenario(seed: number): void {
  buildScenario(Terrain.grid, seed);
  Terrain.connectivity();
  Terrain.markAll();
  Terrain.setStep(0);
}

function runN(n: number): number {
  for (let k = 0; k < n; k++) Terrain.step();
  return Terrain.checksum();
}

/* ── 3. 100회 재생 재현성 ─────────────────────────────────────────────── */
head("3. 재현성 — 같은 시드 + 같은 입력 100회 (roadmap Phase 2 완료 조건)");
{
  const STEPS = 120, TRIALS = 100;
  loadScenario(0x55);
  const snap = Terrain.snapshot();
  const first = runN(STEPS);
  const mass0 = Terrain.massCount();
  let same = 0, massSame = 0;
  for (let t = 0; t < TRIALS; t++) {
    Terrain.restore(snap);
    if (runN(STEPS) === first) same++;
    if (Terrain.massCount() === mass0) massSame++;
  }
  check(same === TRIALS, `체크섬 ${TRIALS}회 전부 동일`, `${hex8(first)} · ${same}/${TRIALS}`);
  check(massSame === TRIALS, "질량도 전부 동일", `${mass0.toLocaleString()}셀`);
}

/* ── 4. 순서 독립성 · 동점 · 활성 행 ──────────────────────────────────── */
head("4. 절대 규칙 3 — 순서 독립성 · 동점 · 활성 행 무결성");
for (const seed of [0x11, 0x55, 0xa3]) {
  loadScenario(seed);
  runN(30);
  const snap = Terrain.snapshot();

  Terrain.setOrder(Terrain.ORD_FWD, true);   const a = runN(150); Terrain.restore(snap);
  Terrain.setOrder(Terrain.ORD_REV, false);  const b = runN(150); Terrain.restore(snap);
  Terrain.setOrder(Terrain.ORD_SPLIT, true); const c = runN(150); Terrain.restore(snap);
  Terrain.setOrder(Terrain.ORD_FWD, true);

  Terrain.setTieWatch(true);
  runN(150);
  Terrain.setTieWatch(false);
  const ties = Terrain.getTieCount();
  Terrain.restore(snap);

  /* 활성 행 무결성 — step().mobile 은 **이동 전** 격자를 센 값이므로
     전체 스캔도 이동 전에 해야 한다 */
  let bad = 0;
  for (let k = 0; k < 80; k++) {
    const full = Terrain.countMobile().total;
    const r = Terrain.step();
    if (r.mobile !== full) bad++;
  }
  Terrain.restore(snap);

  const pass = a === b && a === c && ties === 0 && bad === 0;
  check(pass, `시드 0x${seed.toString(16)}`,
        `정순 ${hex8(a)} / 역순 ${hex8(b)} / 짝홀 ${hex8(c)} · 동점 ${ties} · 활성행 불일치 ${bad}`);
}

/* ── 5. 정착이 수렴한다 ───────────────────────────────────────────────── */
head("5. 정착 — 가동 셀 0 으로 수렴하고, 강제 활성화해도 안 움직인다");
{
  loadScenario(0x55);
  let steps = 0, conv = 0;
  for (;;) {
    let done = false;
    while (steps < 60000) {
      const r = Terrain.step();
      steps++;
      if (r.mobile === 0) { done = true; break; }
    }
    if (!done) break;
    const cv = Terrain.connectivity();
    conv += cv;
    if (cv === 0 || ++conv > 8) break;
  }
  check(steps < 60000, "정착이 수렴한다", `${steps.toLocaleString()}스텝`);
  Terrain.markAll();
  const after = Terrain.step();
  check(after.moved === 0 && after.mobile === 0, "전 행 강제 활성 → 이동 0 (거짓 정착 없음)",
        `이동 ${after.moved} 가동 ${after.mobile}`);
}

/* ── 6. ★ JS 참조 구현과 비트 단위 대조 ★ ─────────────────────────────── */
head("6. TS 이식 ↔ Phase 0 JS 참조 구현 (Phase 2 완료 조건: 체감 동일)");
{
  require(path.join(ROOT, "tools", "sandbox", "automaton.js"));
  const JS = (globalThis as Record<string, any>).NeodeolSim;

  /* 두 구현의 CFG 를 같게 맞춘다 */
  JS.CFG.slideSandQ8 = Terrain.CFG.slideSandQ8;
  JS.CFG.slideSoilQ8 = Terrain.CFG.slideSoilQ8;
  JS.CFG.slideScreeQ8 = Terrain.CFG.slideScreeQ8;
  JS.CFG.slideGateStatic = Terrain.CFG.slideGateStatic;
  JS.CFG.bothDirections = Terrain.CFG.bothDirections;

  let allSame = true;
  for (const seed of [0x11, 0x55, 0xa3, 0xf0]) {
    Terrain.CFG.seed = seed;
    JS.CFG.seed = seed;

    buildScenario(Terrain.grid, seed);
    Terrain.connectivity(); Terrain.markAll(); Terrain.setStep(0);

    buildScenario(JS.grid, seed);
    JS.connectivity(); JS.markAll(); JS.setStep(0);

    if (Terrain.checksum() !== JS.checksum()) {
      check(false, `시드 0x${seed.toString(16)} 초기 격자`, "빌더가 다른 격자를 만들었다");
      allSame = false;
      continue;
    }

    /* 매 스텝 체크섬을 비교한다 — 어느 스텝에서 갈라지는지 잡으려면 이렇게 해야 한다 */
    let divergedAt = -1;
    for (let k = 0; k < 300; k++) {
      Terrain.step();
      JS.step();
      if (Terrain.checksum() !== JS.checksum()) { divergedAt = k; break; }
    }
    const ok = divergedAt < 0;
    if (!ok) allSame = false;
    check(ok, `시드 0x${seed.toString(16)} × 300스텝`,
          ok ? `체크섬 ${hex8(Terrain.checksum())}` : `스텝 ${divergedAt} 에서 갈라졌다`);
  }

  /* 폭발·적층·연결성도 대조한다 */
  Terrain.CFG.seed = 0x55; JS.CFG.seed = 0x55;
  buildScenario(Terrain.grid, 0x55); Terrain.connectivity(); Terrain.markAll(); Terrain.setStep(0);
  buildScenario(JS.grid, 0x55); JS.connectivity(); JS.markAll(); JS.setStep(0);
  const cT = Terrain.carve(480, 300, 40), cJ = JS.carve(480, 300, 40);
  /* 크레이터(240,210) 안에 쌓는다 — EMPTY 가 있어야 deposit 이 실제로 동작한다 */
  const dT = Terrain.deposit(240, 210, 24, SOIL), dJ = JS.deposit(240, 210, 24, SOIL);
  const opSame = cT.removed === cJ.removed && cT.conv === cJ.conv && dT === dJ && dT > 0
                 && cT.removed > 0 && Terrain.checksum() === JS.checksum();
  if (!opSame) allSame = false;
  check(opSame, "carve · deposit · connectivity 결과 동일",
        `제거 ${cT.removed}/${cJ.removed} · 변환 ${cT.conv}/${cJ.conv} · 적층 ${dT}/${dJ}`);

  if (allSame) line("이식이 비트 단위로 충실하다 — Phase 0 의 실측 검증이 그대로 유효하다");
}

/* ── 7. 탄도가 문서 표와 일치한다 ─────────────────────────────────────── */
head("7. 탄도 — simulation.md §8.1 표와 일치하는가");
{
  const r624 = B.flatRangePx(450, 1000, 0);
  const pct = (r624 * 1000) / 1920; // ‰ (정수 유지)
  check(r624 === 1900 || r624 === 1899, "POWER_SCALE 624 → 사거리 1,899~1,900 px", `${r624} px`);
  check(pct > 950 && pct < 1050, "맵 폭의 100% ± 5%", `${(pct / 10).toFixed(1)}%`);
  const save = B.CFG.powerScale;
  B.CFG.powerScale = 320;
  check(B.flatRangePx(450, 1000, 0) === 491, "POWER_SCALE 320 → 491 px (표 검산)",
        `${B.flatRangePx(450, 1000, 0)} px`);
  B.CFG.powerScale = save;
  /* 파워 → 사거리 제곱 관계 (DRAG=0) */
  const full = B.flatRangePx(450, 1000, 0);
  const half = B.flatRangePx(450, 500, 0);
  const ratio = (half * 1000) / full;
  check(ratio > 235 && ratio < 265, "파워 절반 → 사거리 1/4 (항력 0 이므로 제곱 관계)",
        `${(ratio / 10).toFixed(1)}%`);
}

/* ── 8. 경사 차체가 실제 탄도각을 바꾼다 ─────────────────────────────── */
head("8. 경사 발사 — 차체 상대각이 실제 월드 궤적에 반영되는가");
{
  const center = W >> 1;
  const buildSlope = (direction: number): B.Tank => {
    Terrain.grid.fill(EMPTY);
    for (let x = 0; x < W; x++) {
      let offset = floorDiv(x - center, 5);
      if (offset < -20) offset = -20;
      else if (offset > 20) offset = 20;
      const top = 400 + direction * offset;
      for (let y = top; y < H; y++) Terrain.grid[y * W + x] = ROCK;
    }
    return B.makeTank(0, center * B.CELL_SUBPX, direction > 0 ? "downhill" : "uphill");
  };

  const downhill = buildSlope(1);
  const downhillPose = B.shotPose(downhill, 450);
  const downhillShot = B.simulateShot(
    downhillPose.x, downhillPose.y, downhillPose.angle10, 700, 0, 0, [downhill], false,
  );
  const downhillFirstX = downhillShot.xs[0];
  const downhillFirstY = downhillShot.ys[0];
  const uprightShot = B.simulateShot(
    downhillPose.x, downhillPose.y, 450, 700, 0, 0, [downhill], false,
  );
  check(
    downhillPose.tilt10 > 0 && downhillPose.angle10 === 450 - downhillPose.tilt10,
    "오른쪽 내리막은 실제 발사각을 낮춘다",
    `차체 ${(downhillPose.tilt10 / 10).toFixed(1)}° · 월드 ${(downhillPose.angle10 / 10).toFixed(1)}°`,
  );
  check(
    downhillShot.n > 0 && uprightShot.n > 0
      && (downhillFirstX !== uprightShot.xs[0] || downhillFirstY !== uprightShot.ys[0]),
    "경사 보정 전후의 첫 궤적 좌표가 다르다",
  );

  const uphill = buildSlope(-1);
  const uphillPose = B.shotPose(uphill, 450);
  check(
    uphillPose.tilt10 < 0 && uphillPose.angle10 === 450 - uphillPose.tilt10,
    "오른쪽 오르막은 실제 발사각을 높인다",
    `차체 ${(uphillPose.tilt10 / 10).toFixed(1)}° · 월드 ${(uphillPose.angle10 / 10).toFixed(1)}°`,
  );
}

head("9. 턴 경계 불변식 — sim 상태는 격자 하나뿐이다 (terrain.md §5.2)");
{
  /* 활성 행 마스크는 격자 스냅샷에 안 들어간다. 서버는 매 턴 격자를 바이트에서
     복원하며 마스크를 비우고(room/simulation.py `_restore_grid`), 클라이언트는
     메모리에 그대로 이어간다. 턴 경계에서 마스크가 비어 있지 않으면 **두 쪽이
     다음 턴부터 다른 지형을 시뮬레이션한다.**

     실제로 그랬다: 강제 종료(`forced`) 경로가 마스크를 안 비웠고, 교차 검증 골든은
     `forced` 를 한 번도 안 밟아서 잡지 못했다. */
  const T = Terrain;

  function unstable(seed: number): void {
    T.CFG.seed = seed;
    T.grid.fill(T.EMPTY);
    for (let y = 200; y < 460; y++) {
      for (let x = 200; x < 760; x++) {
        const h = hash32(seed, x, y, 0);
        T.grid[y * T.W + x] = (h >>> 9) % 3 !== 0 ? ((h % 4) + 1) : T.EMPTY;
      }
    }
    for (let y = 522; y < T.H; y++) for (let x = 0; x < T.W; x++) T.grid[y * T.W + x] = T.BEDROCK;
    T.connectivity();
    T.markAll();
    T.setStep(0);
  }

  unstable(0x91);
  const forced = Match.settleTerrain(40, 8);
  check(forced.forced, "상한 40 스텝이면 강제 종료된다", `${forced.steps} 스텝`);
  check(
    T.activeRowCount() === 0,
    "강제 종료도 활성 행 마스크를 비운다",
    `활성 ${T.activeRowCount()} 행`,
  );

  unstable(0x92);
  const natural = Match.settleTerrain();
  check(!natural.forced && T.activeRowCount() === 0,
    "정상 종료도 활성 행이 0 이다", `${natural.steps} 스텝`);

  /* 강제 종료 뒤 격자 바이트만으로 다음 스텝이 재현되는가 —
     서버가 하는 복원(clearActive)과 클라이언트의 메모리 유지가 같은 결과를 내야 한다 */
  unstable(0x93);
  Match.settleTerrain(40, 8);
  const snapshot = T.grid.slice();
  const keepStep = () => { for (let i = 0; i < 200; i++) T.step(); return hex8(T.checksum()); };

  const memoryPath = keepStep();
  T.grid.set(snapshot);
  T.clearActive();
  T.setStep(0);
  const restorePath = keepStep();
  check(
    memoryPath === restorePath,
    "강제 종료 다음 진행이 메모리 유지 · 바이트 복원에서 같다",
    `${memoryPath} vs ${restorePath}`,
  );
}

console.log();
if (failures === 0) console.log(`${G}전부 통과.${X}`);
else console.log(`${R}${failures}건 실패.${X}`);
process.exit(failures === 0 ? 0 : 1);
