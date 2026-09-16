/* Neodeol — 탄도 상수 검산기
 *
 *   node tools/ballistics-check.mjs
 *   node tools/ballistics-check.mjs --wind
 *   node tools/ballistics-check.mjs --sweep
 *
 * `docs/simulation.md` §8.1·§8.2 의 표를 재생성한다.
 * 상수를 바꾸면 이걸 돌려 문서 표를 갱신한다.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 왜 닫힌형이 아니라 적분인가.
 *   사거리 = v0² sin(2θ)/g 로 계산하면 45°·POWER_SCALE=320 에서 504 px 이 나오는데,
 *   실제 정수 적분은 491 px 이다. §4.3 의 서브스텝 절단과 §4.2 의 semi-implicit Euler
 *   때문이다. lockstep 에서 진실은 적분 결과이므로 문서에는 이 값을 적는다.
 *
 * 이 파일은 [TOOL] 이다. Phase 2 에서 client/src/sim/ballistics.ts 로 이식되는 것은
 * `simulate()` 안의 적분 루프뿐이며, 그때 float 는 전부 제거된다
 * (여기서 float 는 표 출력과 목표치 판정에만 쓴다).
 */
const SUBPX = 16, TICK_HZ = 60, MAP_W_PX = 1920;
const MAX_FLIGHT_TICKS = 1800;

/* Q12 삼각함수 표 — Phase 2 의 tables/trig.bin 과 같은 정의 (simulation.md §3) */
const SIN = new Int16Array(1801), COS = new Int16Array(1801);
for (let d = 0; d <= 1800; d++) {
  const r = (d / 10) * Math.PI / 180;
  SIN[d] = Math.round(Math.sin(r) * 4096);
  COS[d] = Math.round(Math.cos(r) * 4096);
}

/* docs/simulation.md §4.2 적분 + §4.3 충돌 세분화.
   지형은 없다고 보고 "발사 높이로 되돌아온 순간"을 착탄으로 삼는다 (평지 사거리). */
function simulate({ power, deg10, gravity, powerScale, wind = 0, drag = 0 }) {
  const v0 = (power * powerScale) >> 10;
  let vx = (v0 * COS[deg10]) >> 12;
  let vy = -((v0 * SIN[deg10]) >> 12);
  let x = 0, y = 0, t = 0, apexY = 0;

  while (t < MAX_FLIGHT_TICKS) {
    vx += wind;                                  // 1) 수평 등가속도
    vy += gravity;                               // 2)
    if (drag !== 0) vx -= (vx * drag) >> 16;     // 3)

    /* 4) 이동 + 충돌 판정. 절대 위치 누적으로 잔차를 없앤다 (§4.3) */
    const L = Math.abs(vx) + Math.abs(vy);
    const steps = Math.max(1, L >> 5);
    const sx = x, sy = y;
    let landed = false;
    for (let k = 1; k <= steps; k++) {
      x = sx + Math.floor((vx * k) / steps);
      y = sy + Math.floor((vy * k) / steps);
      if (y < apexY) apexY = y;
      if (y >= 0 && vy > 0) { landed = true; break; }
      }
    t++;
    if (landed) break;
  }
  return {
    v0, rangeSubpx: x, rangePx: x / SUBPX, ticks: t,
    apexPx: -apexY / SUBPX,
    pctOfMap: (x / SUBPX) / MAP_W_PX * 100,
  };
}

const C = { g: "\x1b[32m", y: "\x1b[33m", c: "\x1b[36m", d: "\x1b[2m", x: "\x1b[0m" };
const args = process.argv.slice(2);
const only = (f) => args.length === 0 || args.includes(f);
const head = (s) => console.log(`\n${C.c}${s}${C.x}`);

/* 목표: 최대 파워 · 45° 에서 사거리 = 맵 폭의 100% ± 5%  (simulation.md §8.1, decisions.md B12) */
const TARGET_PCT = 100, TOLERANCE = 5;   // decisions.md B12 — 맵 전체가 교전 범위

if (only("--range")) {
  head("사거리 — 목표: 최대 파워 45° 에서 맵 폭의 100% ± 5% (decisions.md B12)");
  console.log(`  ${C.d}GRAVITY 단위 검산: 12 subpx/tick² = ${12 / SUBPX * TICK_HZ * TICK_HZ} px/s²${C.x}`);
  console.log();
  console.log(`  ${C.d}POWER_SCALE  GRAVITY   v0   사거리    체공   정점    맵폭대비${C.x}`);
  for (const [ps, gr] of [[320, 12], [448, 12], [576, 12], [624, 12], [640, 12]]) {
    const r = simulate({ power: 1000, deg10: 450, gravity: gr, powerScale: ps });
    const hit = Math.abs(r.pctOfMap - TARGET_PCT) <= TOLERANCE;
    console.log(`  ${String(ps).padStart(11)} ${String(gr).padStart(8)} ${String(r.v0).padStart(5)} `
      + `${(r.rangePx.toFixed(0) + "px").padStart(8)} ${(r.ticks + "t").padStart(6)} `
      + `${(r.apexPx.toFixed(0) + "px").padStart(7)}  ${r.pctOfMap.toFixed(1).padStart(6)}%`
      + (hit ? `  ${C.g}← 목표 충족${C.x}` : ""));
  }
}

if (only("--wind")) {
  head("바람 편차 — 수평 편차 / 사거리 비는 정확히 w/g 다");
  console.log(`  ${C.d}POWER_SCALE=320, GRAVITY=12${C.x}`);
  console.log();
  console.log(`  ${C.d}각도   사거리   WIND_MAX=1        =2                =6${C.x}`);
  for (const deg of [300, 450, 600, 700, 800]) {
    const base = simulate({ power: 1000, deg10: deg, gravity: 12, powerScale: 320 });
    const cells = [1, 2, 6].map((w) => {
      const d = simulate({ power: 1000, deg10: deg, gravity: 12, powerScale: 320, wind: w }).rangePx - base.rangePx;
      const pct = d / base.rangePx * 100;
      const s = `${d.toFixed(0)}px (${pct.toFixed(0)}%)`;
      return (pct > 30 ? C.y + s + C.x : s).padEnd(26);
    });
    console.log(`  ${(deg / 10).toFixed(0).padStart(3)}°  ${(base.rangePx.toFixed(0) + "px").padStart(7)}  ${cells.join("")}`);
  }
  console.log(`\n  ${C.d}고각은 체공이 길고 사거리가 짧아 편차 비율이 폭주한다.`);
  console.log(`  상수만으로 해결되지 않는다 — decisions.md C4 의 편차 클램프 결정이 필요하다.${C.x}`);
}

if (args.includes("--sweep")) {
  head("POWER_SCALE 스윕 (GRAVITY=12, 45°, 최대 파워)");
  console.log(`  ${C.d}PS    v0   사거리   맵폭대비${C.x}`);
  for (let ps = 448; ps <= 704; ps += 32) {
    const r = simulate({ power: 1000, deg10: 450, gravity: 12, powerScale: ps });
    const hit = Math.abs(r.pctOfMap - TARGET_PCT) <= TOLERANCE;
    console.log(`  ${String(ps).padStart(3)} ${String(r.v0).padStart(5)} ${(r.rangePx.toFixed(0) + "px").padStart(8)}`
      + `  ${r.pctOfMap.toFixed(1).padStart(6)}%` + (hit ? `  ${C.g}←${C.x}` : ""));
  }
  head("파워 → 사거리 선형성 (POWER_SCALE=448, 45°) — 항력 0 이므로 제곱 관계여야 한다");
  console.log(`  ${C.d}power  사거리   비율(power=1000 기준)${C.x}`);
  const full = simulate({ power: 1000, deg10: 450, gravity: 12, powerScale: 448 }).rangePx;
  for (const p of [250, 500, 750, 1000]) {
    const r = simulate({ power: p, deg10: 450, gravity: 12, powerScale: 448 });
    console.log(`  ${String(p).padStart(5)} ${(r.rangePx.toFixed(0) + "px").padStart(8)}`
      + `  ${(r.rangePx / full * 100).toFixed(1).padStart(6)}%   ${C.d}(제곱 예측 ${((p / 1000) ** 2 * 100).toFixed(1)}%)${C.x}`);
  }
}

console.log();
console.log(`${C.d}상수 출처: docs/simulation.md §8. 확정값이 아니다 — docs/decisions.md C3·C4.${C.x}`);
