/* ═══════════════════════════════════════════════════════════════════════════
   Talus — 모래 붕괴 자동자   docs/terrain.md §1~§8

   `tools/sandbox/automaton.js` 의 정수 이식이다. **로직을 바꾸지 않았다** —
   Phase 0 에서 순서 독립성·동점 불가·해시 품질을 실측으로 검증한 코드이므로
   여기서 창의성을 발휘하면 그 검증이 무효가 된다. 타입과 모듈 경계만 추가했다.

   Phase 3 에서 `server/src/talus/sim/terrain.py` 로 다시 옮겨진다.
   그때도 같은 원칙이다 — 1:1 번역이며 창의성 없음.

   ───────────────────────────────────────────────────────────────────────────
   절대 규칙 (CLAUDE.md)

     · 부동소수점 금지. 나눗셈은 `>>` 또는 `intmath.floorDiv` 만
     · `Math.random` / 시계 / 소켓 / 파일 금지
     · 제안(propose) → 해소(resolve) → 커밋(commit) 3단계. 순서 의존 금지
     · 셀 단위 활성 집합 금지 (행 단위 비트마스크만)
   ═══════════════════════════════════════════════════════════════════════════ */

import { hash32, fnv1a32 } from "./intmath.ts";

/* ── 격자 (§1) ─────────────────────────────────────────────────────────── */
export const W = 960;
export const H = 540;
export const N = W * H;

/* ── 재질 (§2) ─────────────────────────────────────────────────────────── */
export const EMPTY = 0;
export const SAND = 1;
export const SOIL = 2;
export const SCREE = 3;
export const ROCK = 4;
export const BEDROCK = 5;
export const MATERIAL_NAME = ["EMPTY", "SAND", "SOIL", "SCREE", "ROCK", "BEDROCK"] as const;

export type Material = 0 | 1 | 2 | 3 | 4 | 5;

/** 격자 밖 목표. §1.1 — 떨어져 나가면 소멸한다 */
export const VOID = -1;

/* 해소 우선순위 가중치 — 큰 값이 이긴다. **규칙번호의 역순이다** (§3.2) */
const RW_FALL = 3;
const RW_DIAG = 2;
const RW_CREEP = 1;
/** 규칙 1 은 목표가 유일하고 가중치가 최대라 하위 비트가 결과에 영향을 줄 수 없다 (§3.2) */
const PRIO_FALL = RW_FALL << 17;

/* ── 순회 순서. 자기검증에서만 바꾼다 ─────────────────────────────────── */
export const ORD_FWD = 0;
export const ORD_REV = 1;
export const ORD_SPLIT = 2;
export type ResolveOrder = 0 | 1 | 2;

export interface TerrainConfig {
  /** Q8 (0~256). 정적 게이트에서 안식각을 연속 조절한다 (§4.2, decisions.md A1) */
  slideSandQ8: number;
  slideSoilQ8: number;
  /** SCREE 가 규칙 3 을 안 쓴다는 것을 0 으로 표현한다 (§3.1 게이트 5번) */
  slideScreeQ8: number;
  /** 자동자 해시의 seed. `turnSeed = hash32(mapSeed, turnNo, 0, 0)` (decisions.md B2) */
  seed: number;
  /** 재질별 폭발 저항 Q8. `BEDROCK` 키가 **없는 것이 규칙**이다 (§8) */
  blastResistQ8: Readonly<Record<number, number>>;
  /** 고른 방향이 막히면 반대쪽도 시도할지. **확정: false** (decisions.md A2) */
  bothDirections: boolean;
  /** 규칙 3 게이트에서 step 을 뺄지. **확정: true** (decisions.md A1) */
  slideGateStatic: boolean;
}

export const CFG: TerrainConfig = {
  slideSandQ8: 256, // 26.6°
  slideSoilQ8: 48, //  40.3°
  slideScreeQ8: 0, //  44.2° (규칙 3 미적용)
  seed: 0x55,
  blastResistQ8: { [SAND]: 256, [SOIL]: 208, [SCREE]: 256, [ROCK]: 140 },
  bothDirections: false,
  slideGateStatic: true,
};

/* ── 상태 ──────────────────────────────────────────────────────────────── */
export const grid = new Uint8Array(N);
export const rowActive = new Uint8Array(H);
const rowNext = new Uint8Array(H);
let simStep = 0;

/* 작업 버퍼는 전부 사전 할당한다. 스텝마다 할당하면 GC 가 프레임을 씹는다. */
const pSrc = new Int32Array(N);
const pDst = new Int32Array(N);
const pPrio = new Int32Array(N);
const pRow = new Int32Array(N);
const pDRow = new Int32Array(N);
let pN = 0;

const mSrc = new Int32Array(N);
const mDst = new Int32Array(N);
const mMat = new Uint8Array(N);
const mRow = new Int32Array(N);
const mDRow = new Int32Array(N);
let mN = 0;

const bestPrio = new Int32Array(N);
const bestStamp = new Int32Array(N);
let stampCtr = 0;

const visited = new Uint8Array(N);
const ffStack = new Int32Array(N);
const tieMark = new Uint8Array(N);

let lastMoved = 0;
let lastMobile = 0;
let tieWatch = false;
let tieCount = 0;

let resolveOrder: ResolveOrder = ORD_FWD;
let proposeBottomUp = true;

function orderAt(i: number, n: number): number {
  if (resolveOrder === ORD_FWD) return i;
  if (resolveOrder === ORD_REV) return n - 1 - i;
  const half = (n + 1) >> 1; // 짝수 인덱스 역순 → 홀수 인덱스 정순
  return i < half ? (half - 1 - i) * 2 : (i - half) * 2 + 1;
}

export function setOrder(ro: ResolveOrder, bottomUp: boolean): void {
  resolveOrder = ro;
  proposeBottomUp = bottomUp;
}

/* ── 체크섬 (§7.2) — 격자 전체를 idx 오름차순으로 ─────────────────────── */
export function checksum(): number {
  return fnv1a32(grid);
}

export function massCount(): number {
  let c = 0;
  for (let i = 0; i < N; i++) if (grid[i] !== EMPTY) c++;
  return c;
}

/* ── 활성 행 (§5.1) ───────────────────────────────────────────────────── */
function markBandNext(a: number, b: number): void {
  let lo = a - 1;
  let hi = b + 1;
  if (lo < 0) lo = 0;
  if (hi > H - 1) hi = H - 1;
  for (let k = lo; k <= hi; k++) rowNext[k] = 1;
}
export function markRows(a: number, b: number): void {
  if (a < 0) a = 0;
  if (b > H - 1) b = H - 1;
  for (let y = a; y <= b; y++) rowActive[y] = 1;
}
export function markAll(): void {
  rowActive.fill(1);
}
export function clearActive(): void {
  rowActive.fill(0);
}
export function activeRowCount(): number {
  let c = 0;
  for (let y = 0; y < H; y++) if (rowActive[y]) c++;
  return c;
}

export interface StepResult {
  /** 이번 스텝에 실제로 이동한 셀 수 */
  moved: number;
  /** 어떤 해시 값에서든 이동할 수 있는 셀 수. **`0` 이 정착의 정확한 판정이다** (§5.2) */
  mobile: number;
}

/** 재질별 규칙 3 임계값 (Q16). SCREE 는 0 이라 규칙 3 이 절대 성립하지 않는다 */
function slideThreshold(m: number): number {
  if (m === SAND) return CFG.slideSandQ8 << 8;
  if (m === SOIL) return CFG.slideSoilQ8 << 8;
  return CFG.slideScreeQ8 << 8;
}

/* ══════════════════════════════════════════════════════════════════════════
   자동자 한 스텝 (§3)

   Phase 1(제안)은 격자를 읽기만 하고, Phase 3(커밋)만 격자를 쓴다.
   두 단계 모두 순회 순서와 무관해야 한다 — 절대 규칙 3.
   ══════════════════════════════════════════════════════════════════════════ */
export function step(): StepResult {
  const st = simStep;
  const seed = CFG.seed;
  const gateStatic = CFG.slideGateStatic;
  const both = CFG.bothDirections;
  pN = 0;
  mN = 0;
  let mobile = 0;
  rowNext.fill(0);

  /* ── Phase 1 — Propose (읽기 전용) ─────────────────────────────────── */
  const yFrom = proposeBottomUp ? H - 1 : 0;
  const yTo = proposeBottomUp ? -1 : H;
  const yInc = proposeBottomUp ? -1 : 1;

  for (let y = yFrom; y !== yTo; y += yInc) {
    if (!rowActive[y]) continue;
    const rowBase = y * W;
    const belowBase = rowBase + W;
    const yOut = y + 1 >= H;

    for (let x = 0; x < W; x++) {
      const idx = rowBase + x;
      const m = grid[idx];
      if (m === EMPTY || m === ROCK || m === BEDROCK) continue; // 낙하 재질만

      /* ── 규칙 1 — 자유낙하 ─────────────────────────────────────────── */
      if (yOut) {
        pushMove(idx, VOID, m, y, y); // 아래가 격자 밖 → 소멸 (§1.1)
        markBandNext(y, y);
        mobile++;
        continue;
      }
      if (grid[belowBase + x] === EMPTY) {
        pSrc[pN] = idx;
        pDst[pN] = belowBase + x;
        pPrio[pN] = PRIO_FALL;
        pRow[pN] = y;
        pDRow[pN] = y + 1;
        pN++;
        markBandNext(y, y + 1);
        mobile++;
        continue;
      }

      /* 규칙 2·3 은 둘 다 "그 방향의 같은 행 셀이 EMPTY"를 요구한다.
         좌우가 모두 막혔으면 어떤 해시 값에서도 불가능하다 → 비활성. */
      const cl = x === 0 ? EMPTY : grid[idx - 1];
      const cr = x === W - 1 ? EMPTY : grid[idx + 1];
      if (cl !== EMPTY && cr !== EMPTY) continue;

      /* 규칙 3 가능성. static 게이트면 통과 여부가 위치로 고정되므로
         통과 못하는 자리의 셀은 **영구히** 규칙 3 을 못 쓴다 → 이동 가능이 아니다.
         반영하지 않으면 정착 판정이 영원히 성립하지 않는다 (§5.1). */
      const thr = slideThreshold(m);
      let r3ok: boolean;
      if (thr === 0) r3ok = false;
      else if (gateStatic)
        r3ok = ((hash32(seed ^ 0x9e3779b9, x, y, 0) >>> 8) & 0xffff) < thr;
      else r3ok = true;

      /* ── 양방향을 기하로 평가한다 (확률 게이트는 제외) ──────────────
         rL/rR : 0=불가, 2=규칙2, 3=규칙3.   dL/dR : 목표 idx 또는 VOID */
      let rL = 0;
      let dL = 0;
      let rR = 0;
      let dR = 0;

      if (x === 0) {
        rL = 2;
        dL = VOID; // 왼쪽이 격자 밖 → 규칙 2 성립, 소멸
      } else if (cl === EMPTY) {
        if (grid[belowBase + x - 1] === EMPTY) {
          rL = 2;
          dL = belowBase + x - 1;
        } else if (r3ok) {
          const xl2 = x - 2;
          if (xl2 < 0) {
            rL = 3;
            dL = idx - 1; // dir2·belowDir2 가 격자 밖 = EMPTY
          } else if (grid[idx - 2] === EMPTY && grid[belowBase + xl2] === EMPTY) {
            rL = 3;
            dL = idx - 1;
          }
        }
      }
      if (x === W - 1) {
        rR = 2;
        dR = VOID;
      } else if (cr === EMPTY) {
        if (grid[belowBase + x + 1] === EMPTY) {
          rR = 2;
          dR = belowBase + x + 1;
        } else if (r3ok) {
          const xr2 = x + 2;
          if (xr2 >= W) {
            rR = 3;
            dR = idx + 1;
          } else if (grid[idx + 2] === EMPTY && grid[belowBase + xr2] === EMPTY) {
            rR = 3;
            dR = idx + 1;
          }
        }
      }

      if (rL === 0 && rR === 0) continue; // 기하적으로 정지 → 비활성

      /* 여기까지 왔으면 어떤 해시 값에서는 반드시 움직인다. 다음 스텝도 활성. */
      mobile++;
      markBandNext(y, y + 1);

      /* ── 방향 선택 (§7.1: h & 1). 한 방향만 시도한다 (A2 확정) ───── */
      const h = hash32(seed, x, y, st);
      const side = h & 1; // 1 = 우, 0 = 좌
      let rule: number;
      let dst: number;
      let usedSide: number;
      if (side) {
        rule = rR;
        dst = dR;
        usedSide = 1;
        if (rule === 0 && both) {
          rule = rL;
          dst = dL;
          usedSide = 0;
        }
      } else {
        rule = rL;
        dst = dL;
        usedSide = 0;
        if (rule === 0 && both) {
          rule = rR;
          dst = dR;
          usedSide = 1;
        }
      }
      if (rule === 0) continue; // 고른 방향이 막혔다

      /* 확률 게이트는 규칙 3 에만. static 모드는 위에서 이미 반영됐다 (§3.1) */
      if (rule === 3 && !gateStatic && ((h >>> 8) & 0xffff) >= thr) continue;

      const dRow = rule === 3 ? y : y + 1;
      if (dst === VOID) {
        pushMove(idx, VOID, m, y, dRow);
        continue;
      }

      /* 목표 셀 기준 1비트로 승자 쪽을 뒤집어 좌우 편향을 없앤다 (§3.2) */
      const dstX = dst - dRow * W;
      const flip = hash32(seed, dstX, dRow, st) & 1;
      pSrc[pN] = idx;
      pDst[pN] = dst;
      pRow[pN] = y;
      pDRow[pN] = dRow;
      pPrio[pN] =
        ((rule === 3 ? RW_CREEP : RW_DIAG) << 17) |
        (((usedSide ^ flip) & 1) << 16) |
        (h & 0xffff);
      pN++;
    }
  }

  /* ── Phase 2 — Resolve ─────────────────────────────────────────────
     1) 목표별 최대 우선순위   2) 최대와 같은 제안자만 이동 */
  const n = pN;
  const stamp = ++stampCtr;
  for (let i = 0; i < n; i++) {
    const k = orderAt(i, n);
    const dst = pDst[k];
    if (bestStamp[dst] !== stamp) {
      bestStamp[dst] = stamp;
      bestPrio[dst] = pPrio[k];
    } else if (pPrio[k] > bestPrio[dst]) {
      bestPrio[dst] = pPrio[k];
    }
  }
  for (let i = 0; i < n; i++) {
    const k = orderAt(i, n);
    const dst = pDst[k];
    if (pPrio[k] !== bestPrio[dst]) continue;
    if (tieWatch) {
      if (tieMark[dst]) tieCount++;
      else tieMark[dst] = 1;
    }
    pushMove(pSrc[k], dst, grid[pSrc[k]], pRow[k], pDRow[k]);
  }

  /* ── Phase 3 — Commit: 전부 비운 뒤 전부 쓴다 (§3.3) ────────────────
     src 집합과 dst 집합은 서로소다 — dst 는 제안 시점에 EMPTY 였고 src 는 아니었다.
     그래도 2패스로 나눠 순서 의존을 원천 차단한다. */
  for (let i = 0; i < mN; i++) grid[mSrc[i]] = EMPTY;
  for (let i = 0; i < mN; i++) if (mDst[i] !== VOID) grid[mDst[i]] = mMat[i];
  if (tieWatch) for (let i = 0; i < mN; i++) if (mDst[i] !== VOID) tieMark[mDst[i]] = 0;

  rowActive.set(rowNext);

  lastMoved = mN;
  lastMobile = mobile;
  simStep = (simStep + 1) | 0;
  return { moved: mN, mobile };
}

function pushMove(src: number, dst: number, mat: number, srcRow: number, dRow: number): void {
  mSrc[mN] = src;
  mDst[mN] = dst;
  mMat[mN] = mat;
  mRow[mN] = srcRow;
  mDRow[mN] = dRow;
  mN++;
}

/* ══ 폭발 카빙 (§8) ═══════════════════════════════════════════════════ */
export interface CarveResult {
  removed: number;
  conv: number;
}

interface CarveOnlyResult {
  removed: number;
  hitRock: boolean;
}

const carveR2 = new Int32Array(6);

function carveOnly(cx: number, cy: number, radiusCells: number): CarveOnlyResult {
  for (let m = 1; m <= 5; m++) {
    const resist = CFG.blastResistQ8[m];
    if (resist === undefined) {
      carveR2[m] = -1; // 판정 이전에 제외 (BEDROCK). 0 이 아니다 — 0 은 "반경 0"이다
      continue;
    }
    const rm = (radiusCells * resist) >> 8;
    carveR2[m] = rm * rm;
  }
  const y0 = cy - radiusCells < 0 ? 0 : cy - radiusCells;
  const y1 = cy + radiusCells > H - 1 ? H - 1 : cy + radiusCells;
  const x0 = cx - radiusCells < 0 ? 0 : cx - radiusCells;
  const x1 = cx + radiusCells > W - 1 ? W - 1 : cx + radiusCells;
  let removed = 0;
  let hitRock = false;
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    const dy2 = dy * dy;
    const base = y * W;
    for (let x = x0; x <= x1; x++) {
      const idx = base + x;
      const m = grid[idx];
      if (m === EMPTY) continue;
      const r2 = carveR2[m];
      if (r2 < 0) continue; // BEDROCK — 저항 ∞
      const dx = x - cx;
      if (dx * dx + dy2 <= r2) {
        grid[idx] = EMPTY;
        removed++;
        if (m === ROCK) hitRock = true;
      }
    }
  }
  markRows(y0 - 2, y1 + 2);
  return { removed, hitRock };
}

/** 단일 폭발 편의 API. 동시 폭발은 `carveDeferred()` 후 연결성을 한 번만 검사한다. */
export function carve(cx: number, cy: number, radiusCells: number): CarveResult {
  const r = carveOnly(cx, cy, radiusCells);
  return { removed: r.removed, conv: r.hitRock ? connectivity() : 0 };
}

/** 동시 폭발 배치용. 모든 호출이 끝난 뒤 호출자가 `connectivity()` 를 한 번 부른다. */
export function carveDeferred(cx: number, cy: number, radiusCells: number): CarveResult {
  const r = carveOnly(cx, cy, radiusCells);
  return { removed: r.removed, conv: 0 };
}

/* ══ 흙 쌓기 (§8.1) — 적층탄이 요구하는 유일한 지형 추가 연산 ═════════ */
export function deposit(cx: number, cy: number, radiusCells: number, mat: number): number {
  const r2 = radiusCells * radiusCells;
  const y0 = cy - radiusCells < 0 ? 0 : cy - radiusCells;
  const y1 = cy + radiusCells > H - 1 ? H - 1 : cy + radiusCells;
  const x0 = cx - radiusCells < 0 ? 0 : cx - radiusCells;
  const x1 = cx + radiusCells > W - 1 ? W - 1 : cx + radiusCells;
  let filled = 0;
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    const dy2 = dy * dy;
    const base = y * W;
    for (let x = x0; x <= x1; x++) {
      const idx = base + x;
      if (grid[idx] !== EMPTY) continue; // 비-EMPTY 를 덮어쓰지 않는다 (§2 위반 방지)
      const dx = x - cx;
      if (dx * dx + dy2 <= r2) {
        grid[idx] = mat;
        filled++;
      }
    }
  }
  markRows(y0 - 2, y1 + 2);
  return filled;
}

/* ══ 암반 구조 붕괴 (§6) ═══════════════════════════════════════════════
   BEDROCK 을 시드로 ROCK ∪ BEDROCK 을 4방향 연결로 flood fill.
   도달하지 못한 ROCK 을 전부 SCREE 로 바꾼다.
   라벨링 순서는 무관하고 **결과 집합만 같으면 된다** (§6.1). */
export function connectivity(): number {
  visited.fill(0);
  let sp = 0;
  for (let i = 0; i < N; i++) {
    if (grid[i] === BEDROCK) {
      visited[i] = 1;
      ffStack[sp++] = i;
    }
  }
  while (sp > 0) {
    const i = ffStack[--sp];
    const x = i % W;
    let j: number;
    if (x > 0) {
      j = i - 1;
      if (!visited[j] && (grid[j] === ROCK || grid[j] === BEDROCK)) { visited[j] = 1; ffStack[sp++] = j; }
    }
    if (x < W - 1) {
      j = i + 1;
      if (!visited[j] && (grid[j] === ROCK || grid[j] === BEDROCK)) { visited[j] = 1; ffStack[sp++] = j; }
    }
    if (i >= W) {
      j = i - W;
      if (!visited[j] && (grid[j] === ROCK || grid[j] === BEDROCK)) { visited[j] = 1; ffStack[sp++] = j; }
    }
    if (i < N - W) {
      j = i + W;
      if (!visited[j] && (grid[j] === ROCK || grid[j] === BEDROCK)) { visited[j] = 1; ffStack[sp++] = j; }
    }
  }
  let conv = 0;
  let minY = H;
  let maxY = -1;
  for (let y = 0; y < H; y++) {
    const base = y * W;
    for (let x = 0; x < W; x++) {
      const i = base + x;
      if (grid[i] === ROCK && !visited[i]) {
        grid[i] = SCREE;
        conv++;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (conv > 0) markRows(minY - 1, maxY + 1);
  return conv;
}

/* ══ 진단 — 이동 가능한 셀을 격자 전체에서 센다 ════════════════════════
   `step()` 의 mobile 과 어긋나면 활성 행 최적화가 셀을 굶기고 있다는 뜻이다. */
export interface MobileCount {
  rule1: number;
  rule2: number;
  rule3: number;
  total: number;
}

export function countMobile(): MobileCount {
  let r1 = 0;
  let r2 = 0;
  let r3 = 0;
  const seed = CFG.seed;
  const gateStatic = CFG.slideGateStatic;
  for (let y = 0; y < H; y++) {
    const rowBase = y * W;
    const belowBase = rowBase + W;
    const yOut = y + 1 >= H;
    for (let x = 0; x < W; x++) {
      const idx = rowBase + x;
      const m = grid[idx];
      if (m === EMPTY || m === ROCK || m === BEDROCK) continue;
      if (yOut || grid[belowBase + x] === EMPTY) {
        r1++;
        continue;
      }
      const thr = slideThreshold(m);
      const r3ok =
        thr === 0
          ? false
          : gateStatic
            ? ((hash32(seed ^ 0x9e3779b9, x, y, 0) >>> 8) & 0xffff) < thr
            : true;
      let hit = 0;
      for (let s = 0; s < 2 && !hit; s++) {
        const d = s ? 1 : -1;
        const xd = x + d;
        if (xd < 0 || xd >= W) { hit = 2; break; }
        if (grid[idx + d] !== EMPTY) continue;
        if (grid[belowBase + xd] === EMPTY) { hit = 2; break; }
        if (!r3ok) continue;
        const xd2 = x + d + d;
        if (xd2 < 0 || xd2 >= W) { hit = 3; break; }
        if (grid[idx + d + d] === EMPTY && grid[belowBase + xd2] === EMPTY) { hit = 3; break; }
      }
      if (hit === 2) r2++;
      else if (hit === 3) r3++;
    }
  }
  return { rule1: r1, rule2: r2, rule3: r3, total: r1 + r2 + r3 };
}

/* ══ 스냅샷 ════════════════════════════════════════════════════════════ */
export interface Snapshot {
  g: Uint8Array;
  st: number;
  ra: Uint8Array;
}
export function snapshot(): Snapshot {
  return { g: grid.slice(), st: simStep, ra: rowActive.slice() };
}
export function restore(s: Snapshot): void {
  grid.set(s.g);
  simStep = s.st;
  rowActive.set(s.ra);
  mN = 0;
  lastMoved = 0;
}

export function getStep(): number {
  return simStep;
}
export function setStep(v: number): void {
  simStep = v | 0;
}
export function getLastMoved(): number {
  return lastMoved;
}
export function getLastMobile(): number {
  return lastMobile;
}
export function setTieWatch(on: boolean): void {
  tieWatch = on;
  if (on) {
    tieCount = 0;
    tieMark.fill(0);
  }
}
export function getTieCount(): number {
  return tieCount;
}

/** 렌더러가 이동한 셀을 강조할 때 쓴다. **읽기만 한다** (절대 규칙 6) */
export const moved = {
  src: mSrc,
  dst: mDst,
  row: mRow,
  drow: mDRow,
  mat: mMat,
} as const;
export function getMovedCount(): number {
  return mN;
}
export function setMovedCount(v: number): void {
  mN = v | 0;
}
