/* Talus — Phase 0 헤드리스 검증 하네스
 *
 *   node tools/sandbox/harness.mjs
 *   node tools/sandbox/harness.mjs --repose      # 안식각만
 *   node tools/sandbox/harness.mjs --collapse    # 대형 붕괴만
 *   node tools/sandbox/harness.mjs --sweep       # slideChance 스윕 표
 *
 * 브라우저 없이 자동자를 검증한다. index.html 과 **같은** automaton.js / lab.js 를
 * 쓰므로 여기서 통과한 것은 샌드박스에서도 통과한다.
 *
 * 이 하네스가 답하는 질문은 docs/roadmap.md Phase 0 의 완료 조건이다.
 *   · 상수 실제값이 정해졌는가        → --sweep 표를 보고 사람이 정한다
 *   · 대형 붕괴가 3초 안에 정착하는가 → --collapse
 *   · 오버행과 아치가 유지되는가      → arch / overhang 시나리오
 * "재밌는가"는 여기서 답할 수 없다. 그건 브라우저에서 손으로 만져야 한다.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
require(path.join(here, "automaton.js"));
require(path.join(here, "lab.js"));

const S = globalThis.TalusSim;
const L = globalThis.TalusLab;

const args = process.argv.slice(2);
const only = (f) => args.length === 0 || args.includes(f);

/* ── 출력 헬퍼 ─────────────────────────────────────────────────────────── */
const C = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", c: "\x1b[36m", d: "\x1b[2m", x: "\x1b[0m" };
let failures = 0;
const head = (s) => console.log(`\n${C.c}${s}${C.x}`);
const line = (s) => console.log(`  ${C.d}${s}${C.x}`);
function check(pass, label, detail = "") {
  if (!pass) failures++;
  console.log(`  ${pass ? C.g + "PASS" : C.r + "FAIL"}${C.x}  ${label}${detail ? "  " + C.d + detail + C.x : ""}`);
}
const f1 = (v) => (v == null ? "—" : v.toFixed(1));
const pct = (v) => (v * 100).toFixed(2) + "%";
const hex = (u) => (u >>> 0).toString(16).toUpperCase().padStart(8, "0");

/* ══ 1. 해시 품질 ══════════════════════════════════════════════════════ */
if (only("--hash")) {
  head("1. 해시 품질 — 방향 선택이 무작위인가 (terrain.md §7.1)");
  const q = L.testHashQuality(200000);
  line(`bit0 선형예측 정확도  ${pct(q.linearPredictRate)}   (0.5 근처여야 한다)`);
  line(`bit0 1의 비율        ${pct(q.bit0OnesRate)}`);
  line(`step+1 방향 반전율    ${q.stepFlipRates.map((r) => r.toFixed(3)).join(" ")}   (전부 0.5 근처)`);
  line(`인접 x 동일 비율      ${pct(q.neighbourSameRate)}`);
  check(q.pass, "해시가 하위 비트까지 확산된다",
    q.pass ? "" : "확산 단계가 없으면 bit0 이 입력 비트의 XOR 패리티가 된다");
}

/* ══ 2. 결정론 ══════════════════════════════════════════════════════════ */
if (only("--determinism")) {
  head("2. 결정론 — 절대 규칙 3 (terrain.md §3, §7)");
  for (const preset of ["layers", "hills", "arch", "collapse"]) {
    L.loadPreset(preset);
    L.runN(40);                                    // 붕괴가 활발한 구간으로 진입
    const rp = L.testRepro(150);
    const or = L.testOrder(150);
    const ti = L.testTies(150);
    check(rp.pass && or.pass && ti.pass, `${preset}`,
      `재현 ${hex(rp.a)} · 순서 fwd ${hex(or.fwd)} rev ${hex(or.rev)} split ${hex(or.split)} · 동점 ${ti.ties}`);
    if (!rp.pass) line(`  재현성 실패: ${hex(rp.a)} vs ${hex(rp.b)} (질량 ${rp.massA}/${rp.massB})`);
    if (!or.pass) line(`  순서 의존 발견 — 해소 단계가 순회 순서를 탄다`);
    if (!ti.pass) line(`  우선순위 동점 ${ti.ties}건 — 질량이 사라진다`);
  }
}

/* ══ 3. 활성 행이 셀을 굶기지 않는가 ═══════════════════════════════════ */
if (only("--active")) {
  head("3. 활성 행 무결성 — §5.1 이 이동 가능한 셀을 놓치지 않는가");
  for (const preset of ["collapse", "arch"]) {
    L.loadPreset(preset);
    if (preset === "collapse") {
      L.fillRect(L.LEG.x0, L.LEG.y0, L.LEG.x1, L.LEG.y1, S.EMPTY);
      S.markAll(); S.connectivity();
    }
    const mc = L.testMobileConsistency(120);
    check(mc.pass, `${preset} — step().mobile == 전체 스캔`,
      mc.pass ? `${mc.steps}스텝` : `${mc.mismatchSteps}스텝 불일치, 최대 ${mc.worstGap}셀`
        + (mc.firstBad ? ` (첫 불일치 step ${mc.firstBad.step}: 스캔 ${mc.firstBad.scan} vs 집계 ${mc.firstBad.counted})` : ""));
  }
  /* 정착을 선언한 격자에 전 행을 강제로 켜도 정말 아무것도 안 움직이는가.
     굶주림(starvation)으로 인한 거짓 정착을 잡는 결정적 검사다. */
  L.loadPreset("arch");
  const stA = L.settleHeadless(200000);
  S.markAll();
  const afterA = S.step();
  check(!stA.forced && afterA.moved === 0 && afterA.mobile === 0,
    "정착 선언 후 전 행 강제 활성 → 이동 0 (거짓 정착 없음)",
    `정착 ${stA.steps}스텝, 강제 후 이동 ${afterA.moved} 가동 ${afterA.mobile}`);
}

/* ══ 4. 안식각 ═════════════════════════════════════════════════════════ */
function reposeOf(mat, cells, maxSteps = 60000) {
  const col = L.buildPile(mat, cells);
  const massBefore = S.massCount();          // 기둥 + BEDROCK 바닥
  const st = L.settleHeadless(maxSteps);
  const r = L.measureRepose();
  const massAfter = S.massCount();
  return { col, st, r, massBefore, massAfter, lost: massBefore - massAfter };
}

if (only("--repose")) {
  head("4. 안식각 — 문서 주장과 실측 (terrain.md §3.1, §4)");
  line("문서: 규칙 2 까지만 쓰면 45°, 규칙 3 이 2:1 경사를 만들어 ~26.5° 까지 완만해진다");
  console.log();
  console.log(`  ${C.d}재질     기둥      정착스텝   ms     사면(좌/우)   높이  최대낙차  질량보존${C.x}`);
  const rows = [];
  for (const [mat, label] of [[S.SCREE, "SCREE"], [S.SAND, "SAND"], [S.SOIL, "SOIL"]]) {
    const o = reposeOf(mat, 8000);
    /* 더미는 화면 가운데에 있고 최종 폭이 ~250셀이라 격자 밖으로 나갈 수 없다.
       유출이 있으면 경계 처리(§1)에 문제가 있다는 뜻이다. */
    const massOk = o.lost === 0;
    rows.push({ label, o, massOk });
    console.log(`  ${label.padEnd(8)} ${(o.col.w + "x" + o.col.h).padEnd(9)} `
      + `${String(o.st.steps).padStart(7)} ${String(Math.round(o.st.ms)).padStart(6)}  `
      + `${(f1(o.r.L && o.r.L.angle) + "/" + f1(o.r.R && o.r.R.angle)).padEnd(12)} `
      + `${String(o.r.maxH).padStart(4)}  ${String(o.r.maxDrop).padStart(6)}    ${massOk ? "ok" : "깨짐"}`);
  }
  console.log();
  const scree = rows.find((r) => r.label === "SCREE");
  // 규칙 1,2 만 쓰는 SCREE 는 이웃 열 낙차가 1 을 넘을 수 없다 → 사면 ≤ 45°
  check(scree.o.r.maxDrop <= 1, "SCREE 최대 열간 낙차 ≤ 1 (규칙 2 의 45° 상한)",
    `실측 ${scree.o.r.maxDrop}`);
  check(scree.o.r.angle <= 47, "SCREE 안식각 ≈ 45°", `실측 ${f1(scree.o.r.angle)}°`);
  const sand = rows.find((r) => r.label === "SAND");
  check(sand.o.r.angle < scree.o.r.angle, "SAND 가 SCREE 보다 완만하다 (규칙 3 이 작동한다)",
    `SAND ${f1(sand.o.r.angle)}° < SCREE ${f1(scree.o.r.angle)}°`);

  /* 정적 게이트가 확정되었으므로(decisions.md A1) 재질 3종이 실제로 다른 각도로
     쌓여야 한다. terrain.md §2 의 "지층 노출" 전제가 이 검사에 달려 있다. */
  const soil = rows.find((r) => r.label === "SOIL");
  check(soil.o.r.angle > sand.o.r.angle + 3, "SOIL 이 SAND 보다 급하다 (정적 게이트가 각도를 조절한다)",
    `SOIL ${f1(soil.o.r.angle)}° > SAND ${f1(sand.o.r.angle)}°`);
  check(scree.o.r.angle > soil.o.r.angle + 1, "SCREE 가 SOIL 보다 급하다 — 재질 3종이 구분된다",
    `SCREE ${f1(scree.o.r.angle)}° > SOIL ${f1(soil.o.r.angle)}° > SAND ${f1(sand.o.r.angle)}°`);
  for (const r of rows) check(r.massOk, `${r.label} 질량 보존`);
  for (const r of rows) check(!r.o.st.forced, `${r.label} 정착 수렴`, `${r.o.st.steps}스텝`);
}

/* ══ 5. slideChance 스윕 — 상수를 사람이 정하기 위한 표 ═════════════════ */
if (args.includes("--sweep")) {
  head("5. SLIDE_CHANCE 스윕 — 안식각 응답 곡선");
  line("이 표를 보고 SLIDE_CHANCE_SAND / SOIL 을 정한다. 값은 사람이 결정한다.");
  console.log();
  console.log(`  ${C.d}Q8    비율     안식각   정착스텝   최대낙차${C.x}`);
  const saveS = S.CFG.slideSandQ8;
  for (const q8 of [0, 8, 16, 32, 48, 64, 96, 128, 160, 192, 224, 256]) {
    S.CFG.slideSandQ8 = q8;
    const o = reposeOf(S.SAND, 8000);
    console.log(`  ${String(q8).padStart(3)}  ${(q8 / 256 * 100).toFixed(1).padStart(6)}%  `
      + `${f1(o.r.angle).padStart(6)}°  ${String(o.st.steps).padStart(8)}   ${String(o.r.maxDrop).padStart(6)}`
      + (o.st.forced ? `  ${C.y}미수렴${C.x}` : ""));
  }
  S.CFG.slideSandQ8 = saveS;
}

/* ══ 5.5 실전 규모 폭발 — SUBSTEPS 를 정하는 근거 (terrain.md §11.2) ════ */
if (only("--blast")) {
  head("5. 실전 규모 폭발 1발의 정착 비용 — SUBSTEPS 확정의 근거");
  line("layers 프리셋을 먼저 정착시킨 뒤 지표면에 명중시킨다.");
  console.log();
  console.log(`  ${C.d}반경  제거셀   정착스텝    sim ms   이동누적   SUB=4 초  3초에 필요한 SUB${C.x}`);
  let worst = null;
  for (const r of [12, 20, 30, 40, 60, 80]) {
    L.loadPreset("layers");
    L.settleHeadless(200000);                    // 초기 지형을 먼저 안정화
    let cy = 0;
    const cx = S.W >> 1;
    for (let y = 0; y < S.H; y++) if (S.grid[y * S.W + cx] !== S.EMPTY) { cy = y; break; }
    const cv = S.carve(cx, cy + (r >> 1), r);
    const st = L.settleHeadless(400000);
    const needSub = Math.ceil(st.steps / (3 * 60));
    if (r === 80) worst = { st, needSub, cv };
    console.log(`  ${String(r).padStart(4)}  ${String(cv.removed).padStart(6)}  `
      + `${String(st.steps).padStart(8)}  ${String(Math.round(st.ms)).padStart(7)}  `
      + `${String(st.moved).padStart(9)}  ${(st.steps / 4 / 60).toFixed(2).padStart(8)}  `
      + `${String(needSub).padStart(14)}` + (st.forced ? `  ${C.y}미수렴${C.x}` : ""));
  }
  console.log();
  /* roadmap.md Phase 0 이 판정 기준으로 삼은 것은 이 최대 무기 규모다. */
  check(!worst.st.forced, "최대 무기(반경 80)의 정착이 수렴한다", `${worst.st.steps.toLocaleString()}스텝`);
  check(worst.st.ms < 3000, "최대 무기의 순수 sim 시간 < 3초 (계산 비용)",
    `${Math.round(worst.st.ms)}ms`);
  line(`최대 무기를 3초 안에 보여주려면 SUBSTEPS ≥ ${worst.needSub}`);
  line(`MAX_SETTLE_STEPS 는 최소 ${worst.st.steps.toLocaleString()} 이상이어야 최대 무기가 잘리지 않는다`);
}

/* ══ 5.6 동시 턴 — 6발이 같은 틱에 터지면 정착 비용이 몇 배인가 ════════
   decisions.md B14. §11.2 실측은 전부 1발 기준인데 실제 규칙은 전원 동시 발사다
   (game-design.md §4.1). 활성 행이 겹치므로 6배보다 적을 것으로 예상되지만,
   추측으로 SUBSTEPS 를 정할 일이 아니다. */
if (only("--simultaneous")) {
  head("5.6 동시 폭발 — 인원수에 따른 정착 비용 (decisions.md B14)");
  line("반경 40 폭발을 지표면에 균등 간격으로 동시 적용한다. 슬롯 오름차순 carve (terrain.md §8).");
  console.log();
  console.log(`  ${C.d}발수  간격   제거셀   정착스텝   sim ms   1발 대비   SUB=26 초${C.x}`);
  let base = null;
  for (const n of [1, 2, 3, 4, 6]) {
    L.loadPreset("layers");
    L.settleHeadless(200000);
    /* 균등 간격 배치. 맵 폭 960 을 n+1 등분한 지점에 쏜다. */
    const gap = Math.floor(S.W / (n + 1));
    let removed = 0;
    for (let i = 1; i <= n; i++) {                 // 슬롯 오름차순
      const cx = gap * i;
      let cy = 0;
      for (let y = 0; y < S.H; y++) if (S.grid[y * S.W + cx] !== S.EMPTY) { cy = y; break; }
      removed += S.carve(cx, cy + 20, 40).removed;
    }
    const st = L.settleHeadless(400000);
    if (n === 1) base = st.steps;
    console.log(`  ${String(n).padStart(4)}  ${String(gap).padStart(4)}  ${String(removed).padStart(6)}  `
      + `${String(st.steps).padStart(8)}  ${String(Math.round(st.ms)).padStart(7)}   `
      + `${(st.steps / base).toFixed(2).padStart(6)}×   ${(st.steps / 26 / 60).toFixed(2).padStart(7)}`
      + (st.forced ? `  ${C.y}미수렴${C.x}` : ""));
    if (n === 6) {
      check(!st.forced, "6발 동시 폭발의 정착이 수렴한다", `${st.steps.toLocaleString()}스텝`);
      check(st.steps / base < 6, "동시 폭발 비용이 발수에 선형 비례하지 않는다 (활성 행이 겹친다)",
        `${(st.steps / base).toFixed(2)}× (선형이면 6.00×)`);
      line(`6발을 3초에 보여주려면 SUBSTEPS ≥ ${Math.ceil(st.steps / (3 * 60))}`);
      line(`MAX_SETTLE_STEPS 는 최소 ${st.steps.toLocaleString()} 이상이어야 6발 턴이 잘리지 않는다`);
    }
  }
}

/* ══ 6. 대형 붕괴 — 실전 규모가 아니므로 계측만 한다 ═══════════════════ */
if (only("--collapse")) {
  head("6. 대형 붕괴 — 화면 1/4 이 3초 안에 정착하는가 (roadmap Phase 0)");
  L.loadPreset("collapse");
  const massBefore = S.massCount();
  L.fillRect(L.LEG.x0, L.LEG.y0, L.LEG.x1, L.LEG.y1, S.EMPTY);
  S.markAll();
  const conv = S.connectivity();
  const st = L.settleHeadless(200000);
  const massAfter = S.massCount();
  line(`부유 흙        ${L.COLLAPSE_BLOCK_CELLS.toLocaleString()}셀 (격자의 ${(L.COLLAPSE_BLOCK_CELLS / S.N * 100).toFixed(1)}%)`);
  line(`ROCK→SCREE     ${conv.toLocaleString()}셀`);
  line(`정착            ${st.steps.toLocaleString()}스텝 / ${Math.round(st.ms)}ms 순수 sim`);
  line(`이동 누적       ${st.moved.toLocaleString()}회`);
  line(`ms/스텝         ${(st.ms / st.steps).toFixed(3)}`);
  line(`질량            ${massBefore.toLocaleString()} → ${massAfter.toLocaleString()} `
     + `(격자 밖으로 ${(massBefore - massAfter).toLocaleString()}셀 유출 — §1 상 정상)`);
  check(!st.forced, "정착이 수렴한다");
  check(st.ms / st.steps < 5, "자동자 1스텝 < 5ms (클라 목표, terrain.md §9)",
    `${(st.ms / st.steps).toFixed(3)}ms`);
  /* "3초 안에 정착" 은 이 규모에 적용하지 않는다 — roadmap.md Phase 0 이 완료 조건에서
     이 시나리오를 뺐다. 최대 무기의 10배 규모라 실전에 나오지 않는다.
     여기서는 계측만 남긴다. 판정은 §11.2 의 최대 무기 반경으로 한다. */
  const wallSeconds = st.steps / 4 / 60;
  line(`SUBSTEPS=4 로 보여주면 ${(st.steps / 4).toFixed(0)}프레임 = ${wallSeconds.toFixed(1)}초`);
  line(`3초에 맞추려면 SUBSTEPS ≥ ${Math.ceil(st.steps / (3 * 60))} — 실전 규모가 아니므로 판정하지 않는다`);
  line(`MAX_SETTLE_STEPS 는 최소 ${st.steps.toLocaleString()} 이상이어야 이 장면이 잘리지 않는다`);
}

/* ══ 7. 구조 붕괴 (아치 / 오버행) ══════════════════════════════════════ */
if (only("--structure")) {
  head("7. 구조 붕괴 — 오버행·아치가 유지되고 다리를 부수면 무너지는가");

  L.loadPreset("arch");
  let s0 = L.settleHeadless(60000);
  let standing = S.massCount();
  check(!s0.forced, "아치가 그대로 서 있다 (정착 후에도 무너지지 않음)", `${s0.steps}스텝`);
  const archTop = (() => {                        // 아치 천장에 재질이 남아 있는가
    let c = 0;
    for (let y = 230; y < 290; y++) for (let x = 380; x < 580; x++) if (S.grid[y * S.W + x] !== S.EMPTY) c++;
    return c;
  })();
  check(archTop > 1000, "아치 천장이 공중에 유지된다", `천장 영역 ${archTop}셀`);

  /* 아치는 다리가 둘이다. 하나를 끊어도 남은 다리로 BEDROCK 에 연결되어 버틴다 —
     버그가 아니라 규칙이며(terrain.md §6.2), "두 번째를 끊는 순간 전부 무너진다"는
     긴장을 만든다. 그래서 두 단계로 검사한다. */
  /* 다리를 실제로 끊으려면 폭발이 다리 폭을 **전부** 덮는 행이 하나는 있어야 한다.
     연결성은 4방향이라 한 행만 완전히 비어도 절단된다.
     다리는 x 280..328 / 632..680 (폭 49). ROCK 유효반경 = (r*140)>>8 이므로
     r=46 → 25 이고, 다리 중심에 맞추면 중심 행에서 51칸을 덮어 49를 포함한다.
     중심을 벗어나면 양 끝 몇 열이 살아 남아 절단되지 않는다 — 실제로 그렇게 실패했다. */
  const LEG_L_CX = (280 + 328) >> 1, LEG_R_CX = (632 + 680) >> 1;
  const cv1 = S.carve(LEG_L_CX, 470, 46);
  line(`왼쪽 다리 폭파 @x${LEG_L_CX} — 제거 ${cv1.removed}셀, ROCK→SCREE ${cv1.conv}셀`);
  check(cv1.conv === 0, "다리 하나만 끊으면 아치가 버틴다 (남은 다리가 BEDROCK 에 연결)",
    `변환 ${cv1.conv}셀`);
  L.settleHeadless(200000);
  const midTop = (() => {
    let c = 0;
    for (let y = 230; y < 290; y++) for (let x = 380; x < 580; x++) if (S.grid[y * S.W + x] !== S.EMPTY) c++;
    return c;
  })();
  check(midTop > archTop * 0.5, "천장이 아직 남아 있다", `${archTop} → ${midTop}셀`);

  const cv2 = S.carve(LEG_R_CX, 470, 46);
  line(`오른쪽 다리 폭파 @x${LEG_R_CX} — 제거 ${cv2.removed}셀, ROCK→SCREE ${cv2.conv}셀`);
  check(cv2.conv > 2000, "두 번째 다리를 끊으면 아치 전체가 SCREE 가 된다 (§6.2)", `${cv2.conv}셀`);
  const s1 = L.settleHeadless(200000);
  const afterTop = (() => {
    let c = 0;
    for (let y = 230; y < 290; y++) for (let x = 380; x < 580; x++) if (S.grid[y * S.W + x] !== S.EMPTY) c++;
    return c;
  })();
  check(afterTop < archTop * 0.1, "천장이 실제로 무너져 내렸다", `${archTop} → ${afterTop}셀`);
  check(!s1.forced, "붕괴가 수렴한다", `${s1.steps}스텝 / ${Math.round(s1.ms)}ms`);

  L.loadPreset("overhang");
  s0 = L.settleHeadless(60000);
  const slab = () => {
    let c = 0;
    for (let y = 250; y < 287; y++) for (let x = 400; x < 720; x++) if (S.grid[y * S.W + x] === S.ROCK) c++;
    return c;
  };
  const slabBefore = slab();
  check(slabBefore > 5000, "오버행 슬랩이 캔틸레버로 유지된다", `${slabBefore}셀`);
  const cvPillar = S.carve(320, 320, 40);         // 기둥을 끊는다
  check(cvPillar.conv > 5000, "기둥을 끊으면 슬랩이 SCREE 로 바뀐다", `ROCK→SCREE ${cvPillar.conv}셀`);
  const s2 = L.settleHeadless(200000);
  check(slab() < 500, "슬랩이 무너졌다", `${slabBefore} → ${slab()}셀`);
  check(!s2.forced, "붕괴가 수렴한다", `${s2.steps}스텝`);
}

/* ══ 요약 ══════════════════════════════════════════════════════════════ */
console.log();
if (failures === 0) console.log(`${C.g}전부 통과.${C.x}`);
else console.log(`${C.r}${failures}건 실패.${C.x}`);
process.exit(failures === 0 ? 0 : 1);
