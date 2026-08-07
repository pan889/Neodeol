/* ═══════════════════════════════════════════════════════════════════════════
   골든 리플레이 생성기 — 교차 검증(§9 `test_cross_sim`)의 기준선

     node --experimental-strip-types client/tools/gen-golden.mts

   TS 구현이 **진실의 원본**이다 (CLAUDE.md §포팅 방향: 브라우저 → TS → Python).
   Python 이 같은 입력에서 같은 체크섬을 내는지 대조한다.

   ───────────────────────────────────────────────────────────────────────────
   파일 형식 — `docs/decisions.md` B2 의 구현안

     tests/replays/<name>.jsonl       헤더 1줄 + 레코드 N줄
     tests/replays/<name>.grid.gz     초기 격자 518,400 바이트 (gzip)

   헤더:
     { v, name, kind, seed, cfg, gridSha256, gridFile, steps, sampleEvery }
   레코드:
     { step, checksum, mass, mobile }

   **초기 격자를 파일로 들고 있는 이유.** 원래 리플레이는 `mapSeed` 만 담고
   양쪽이 같은 맵을 생성해야 한다(절대 규칙 4). 그런데 맵 생성기 명세가
   `decisions.md` B1 로 미결이다. 생성기가 확정되면 이 사이드카를 지우고
   `mapSeed` 만 남긴다 — 그때까지는 격자를 실어야 교차 검증을 **지금** 할 수 있다.
   이건 임시 조치이며 헤더의 `kind` 가 그것을 표시한다.
   ═══════════════════════════════════════════════════════════════════════════ */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import * as T from "../src/sim/terrain.ts";
import { hash32, hex8 } from "../src/sim/intmath.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(ROOT, "tests", "replays");
fs.mkdirSync(OUT, { recursive: true });

const { W, H, EMPTY, SAND, SOIL, SCREE, ROCK, BEDROCK } = T;

/** 시나리오 빌더 — 순수 정수 절차. B1 확정 전까지의 임시 지형 */
function buildScenario(target: Uint8Array, seed: number, variant: number): void {
  target.fill(EMPTY);
  const bands: Array<[number, number]> = [
    [SAND, 14 + (variant % 5)], [SOIL, 28], [SAND, 10],
    [SCREE, 12], [SOIL, 40], [ROCK, 26],
  ];
  for (let x = 0; x < W; x++) {
    const i = x >> 7, f = x - (i << 7);
    const a = hash32(seed, i, 11 + variant, 0) & 0xffff;
    const b = hash32(seed, i + 1, 11 + variant, 0) & 0xffff;
    const nz = a + (((b - a) * f) >> 7);
    let y = 170 + (((nz - 32768) * (60 + variant * 4)) >> 16);
    if (y < 20) y = 20;
    for (const [m, t] of bands) for (let k = 0; k < t && y < H; k++, y++) target[y * W + x] = m;
    for (; y < H; y++) target[y * W + x] = y >= 522 ? BEDROCK : ROCK;
  }
  /* 좌우 봉인 — terrain.md §1.1. 없으면 최외곽 열이 매 스텝 유출된다 */
  for (const x of [0, 1, W - 2, W - 1]) {
    const ref = x < 2 ? 2 : W - 3;
    let top = H;
    for (let y = 0; y < H; y++) if (target[y * W + ref] !== EMPTY) { top = y; break; }
    for (let y = top; y < H; y++) target[y * W + x] = BEDROCK;
  }
  /* 폭발 구덩이 — 붕괴가 실제로 일어나게 만든다. 개수·위치를 variant 로 흔든다 */
  const craters = 2 + (variant % 3);
  for (let c = 0; c < craters; c++) {
    const hc = hash32(seed, 900 + c, variant, 0);
    const cx = 120 + (hc % 720);
    const cy = 170 + ((hc >>> 10) % 130);
    const r = 22 + ((hc >>> 20) % 30);
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

const REPLAY_COUNT = 20;
const STEPS = 400;
const SAMPLE_EVERY = 20; // 체크섬은 Python 에서 57ms 라 매 스텝은 비싸다

let totalRecords = 0;
for (let v = 0; v < REPLAY_COUNT; v++) {
  const seed = (0x11 + v * 37) & 0xff;
  T.CFG.seed = seed;
  buildScenario(T.grid, seed, v);
  T.connectivity();
  T.markAll();
  T.setStep(0);

  const gridBytes = Buffer.from(T.grid);
  const gridSha = crypto.createHash("sha256").update(gridBytes).digest("hex");
  const name = `terrain-${String(v).padStart(2, "0")}`;
  fs.writeFileSync(path.join(OUT, `${name}.grid.gz`), zlib.gzipSync(gridBytes, { level: 9 }));

  const lines: string[] = [];
  lines.push(JSON.stringify({
    v: 1,
    name,
    kind: "terrain-only",
    note: "초기 격자를 사이드카로 싣는다. 맵 생성기(decisions.md B1) 확정 시 mapSeed 로 대체한다",
    seed,
    cfg: {
      slideSandQ8: T.CFG.slideSandQ8,
      slideSoilQ8: T.CFG.slideSoilQ8,
      slideScreeQ8: T.CFG.slideScreeQ8,
      slideGateStatic: T.CFG.slideGateStatic,
      bothDirections: T.CFG.bothDirections,
      blastResistQ8: T.CFG.blastResistQ8,
    },
    gridFile: `${name}.grid.gz`,
    gridSha256: gridSha,
    steps: STEPS,
    sampleEvery: SAMPLE_EVERY,
  }));
  lines.push(JSON.stringify({ step: 0, checksum: hex8(T.checksum()), mass: T.massCount(), mobile: -1 }));

  for (let s = 1; s <= STEPS; s++) {
    const r = T.step();
    if (s % SAMPLE_EVERY === 0 || s === STEPS) {
      lines.push(JSON.stringify({
        step: s, checksum: hex8(T.checksum()), mass: T.massCount(), mobile: r.mobile,
      }));
      totalRecords++;
    }
  }
  fs.writeFileSync(path.join(OUT, `${name}.jsonl`), lines.join("\n") + "\n");
  process.stdout.write(`  ${name}  seed 0x${seed.toString(16)}  최종 ${hex8(T.checksum())}\n`);
}

console.log(`\n골든 리플레이 ${REPLAY_COUNT}개 · 레코드 ${totalRecords}개 → tests/replays/`);
console.log(`재생성하면 반드시 이유를 커밋 메시지에 적는다 (CLAUDE.md §결정론 게이트)`);

/* ═══════════════════════════════════════════════════════════════════════════
   장기 리플레이 — "매 턴 동일 체크섬" (roadmap Phase 3 완료 조건)

   위의 20개는 *스텝* 단위 대조다. 실제 게임의 단위는 **턴**이고,
   한 턴은 `carve → 연결성 → 정착 → 재검사` 루프 전체다 (terrain.md §6.1).
   턴 경계에서 갈라지는 버그(연결성 재검사 루프, step 카운터 리셋 여부)는
   스텝 단위 대조로는 안 잡힌다.
   ═══════════════════════════════════════════════════════════════════════════ */
function makeLongReplay(name: string, TURNS: number, rMin: number, rSpan: number): void {
  const seed = 0x7c;
  T.CFG.seed = seed;
  buildScenario(T.grid, seed, 3);
  T.connectivity(); T.markAll(); T.setStep(0);
  /* 초기 정착 — 생성 직후 저절로 무너지는 것을 없앤다 */
  for (let s = 0; s < 40000; s++) if (T.step().mobile === 0) break;

  const gridBytes = Buffer.from(T.grid);
  const gridSha = crypto.createHash("sha256").update(gridBytes).digest("hex");
  fs.writeFileSync(path.join(OUT, `${name}.grid.gz`), zlib.gzipSync(gridBytes, { level: 9 }));

  /* ★ 재생 측과 동일한 프롤로그를 **다시** 밟는다.
     사이드카에는 격자만 들어간다 — `step` 카운터와 활성 집합은 안 들어간다.
     그런데 우선순위 해시가 `step` 을 먹으므로(§3.2), 여기서 카운터를 위의 정착이
     남긴 값 그대로 두고 턴을 시작하면 재생 측(step=0 에서 로드)과 결과가 갈라진다.
     격자가 같아도 갈라지는 것이고, 그건 사이드카에 담기지 않은 상태에 기록이
     의존했다는 뜻이다. 로더가 하는 일을 그대로 반복해 상태를 맞춘다. */
  T.connectivity(); T.markAll(); T.setStep(0);
  for (let s = 0; s < 40000; s++) if (T.step().mobile === 0) break;

  /** 열 cx 의 지표면 y (첫 비-EMPTY 행) */
  function surfaceY(cx: number): number {
    for (let y = 0; y < H; y++) if (T.grid[y * W + cx] !== EMPTY) return y;
    return H;
  }

  const lines: string[] = [];
  const turns: Array<{ cx: number; cy: number; r: number; kind: string }> = [];
  let totalSteps = 0;
  const recs: string[] = [];

  for (let t = 1; t <= TURNS; t++) {
    /* 턴 입력을 결정론적으로 만든다 — 리플레이의 intents[] 자리.
       ★ 좌표를 **지표면 기준**으로 잡는다. 절대 좌표로 뽑으면 상당수가 깊은 암반
       속(붕괴 없음)이거나 허공(제거 0셀)이라 턴이 no-op 이 되고, 그러면 60턴을
       돌려도 자동자를 거의 안 돌린 채 "통과"한다. */
    const h = hash32(seed ^ 0x7017, t, 0, 0);
    const cx = 60 + (h % 840);
    const r = rMin + ((h >>> 19) % rSpan);
    /* ★ carve 와 deposit 의 **물질 수지를 맞춘다.** 처음엔 deposit 을 1/4 턴에 반경 절반으로
       넣었는데, 그러면 제거가 적층의 13배라 1000턴에서 질량이 86% 사라졌다. 600턴쯤이면
       맵이 암반까지 벗겨져 이후 400턴은 carve 가 0셀을 지우고 정착이 1스텝에 끝난다 —
       "1000턴 통과"라고 적히지만 뒤쪽 절반은 아무것도 검증하지 않는다.
       빈도 1:1, 반경 동일로 맞춰 맵이 계속 살아 있게 한다. */
    const kind = ((h >>> 27) & 1) === 0 ? "deposit" : "carve";
    const sy = surfaceY(cx);
    const cy = kind === "deposit"
      ? Math.max(4, sy - 12 - ((h >>> 9) % 24))       // 지표 위 → 떨어지며 쌓인다
      : Math.min(H - 4, sy + 4 + ((h >>> 9) % 28));   // 지표 바로 아래 → 무너진다
    turns.push({ cx, cy, r, kind });

    if (kind === "deposit") T.deposit(cx, cy, r, SOIL);
    else T.carve(cx, cy, r);

    /* 정착 + 연결성 재검사 루프 (terrain.md §6.1). step 은 리셋하지 않는다 */
    let steps = 0, rounds = 0;
    for (;;) {
      let settled = false;
      while (steps < 40000) { steps++; if (T.step().mobile === 0) { settled = true; break; } }
      if (!settled) break;
      const conv = T.connectivity();
      if (conv > 0 && ++rounds < 8) continue;
      break;
    }
    totalSteps += steps;
    recs.push(JSON.stringify({
      turn: t, steps, totalSteps,
      checksum: hex8(T.checksum()), mass: T.massCount(),
    }));
  }

  lines.push(JSON.stringify({
    v: 1, name, kind: "terrain-turns",
    note: "턴 = carve/deposit → 연결성 → 정착 → 재검사 루프. terrain.md §6.1",
    seed,
    cfg: {
      slideSandQ8: T.CFG.slideSandQ8, slideSoilQ8: T.CFG.slideSoilQ8,
      slideScreeQ8: T.CFG.slideScreeQ8, slideGateStatic: T.CFG.slideGateStatic,
      bothDirections: T.CFG.bothDirections, blastResistQ8: T.CFG.blastResistQ8,
    },
    gridFile: `${name}.grid.gz`, gridSha256: gridSha,
    turns, turnCount: TURNS, totalSteps, rMin, rSpan,
  }));
  lines.push(...recs);
  fs.writeFileSync(path.join(OUT, `${name}.jsonl`), lines.join("\n") + "\n");
  console.log(`장기 리플레이 ${name}  ${TURNS}턴 / ${totalSteps.toLocaleString()}스텝  최종 ${hex8(T.checksum())}`);
}

/* ── 두 장기 리플레이는 역할이 다르다 ─────────────────────────────────────
   둘 다 크게 만들면 검증 비용이 규칙 변경을 막는 수준이 된다. 반경 14~59 로 1000턴을
   돌리면 300만 스텝이고, 생성 34분 + Python 재생 57분이다. 자동자 규칙을 만질 때마다
   1시간 반이 드는 게이트는 결국 아무도 안 돌린다 — 그러면 게이트가 없는 것과 같다.
   그래서 **규모**와 **지속**을 나눠 맡긴다.                                    */

/* 규모 — 60턴 × 대형 폭발(반경 14~59). 한 턴이 평균 3,000스텝짜리 대형 붕괴다.
   상시 게이트. Python 재생 약 3분.                                             */
makeLongReplay("terrain-long", 60, 14, 46);

/* 지속 — 1000턴 × 중간 폭발(반경 8~27). 누적 상태(step 카운터 증가, 연결성 재검사
   반복, 활성 집합 누수)가 장기간에 걸쳐 어긋나는지를 본다. 이쪽은 한 턴의 크기가 아니라
   **턴 수** 자체가 검증 대상이다. `-m slow` 로 분리. Python 재생 약 12분.
   조건 없이 항상 생성한다 — 플래그로 가리면 1000턴본만 옛 규칙으로 남고,
   그건 "게이트가 통과했는데 틀린" 상태다.                                      */
makeLongReplay("terrain-long1k", 1000, 8, 20);
