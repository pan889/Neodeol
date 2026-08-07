/* ═══════════════════════════════════════════════════════════════════════════
   Talus — 탄도 · 탱크   docs/simulation.md §2 §4 §5 §6

   `tools/prototype/sim.js` 의 정수 이식이다. Phase 2 에서 실제로 없앤 float:

     · 런타임 `Math.sin/cos` → `tables/trig.bin` (§3)
     · `Math.floor(a / b)`   → `intmath.floorDiv` (§4.3 의 유일한 예외)
     · `isqrt` 안의 `n / x`  → `intmath.isqrt` (완전 정수 뉴턴법)
     · `Math.abs/max/min`    → `intmath.iabs` / 명시적 비교

   `tools/check-no-float.mjs` 가 이 디렉터리 전체를 정적 검사한다.
   ═══════════════════════════════════════════════════════════════════════════ */

import { floorDiv, isqrt, iabs, clampInt } from "./intmath.ts";
import { SIN, COS } from "./trig.ts";
import { grid, W, H, EMPTY, BEDROCK } from "./terrain.ts";

/* ── 좌표계 (§2.1) ─────────────────────────────────────────────────────── */
export const SUBPX = 16;
export const CELL_SUBPX = 32; // 2 px
export const CELL_SHIFT = 5; // subpx → cell 은 >> 5
export const PX_SHIFT = 4; // subpx → px 는 >> 4
export const MAP_W_SUB = W * CELL_SUBPX; // 30720
export const MAP_H_SUB = H * CELL_SUBPX; // 17280

export const TANK_W = 384; // 24 px
export const TANK_H = 256; // 16 px
export const MAX_HP = 100;
export const TANK_TILT_MAX10 = 140; // ±14.0°
const TANK_TILT_SAMPLE = (TANK_W * 7) >> 4;

/* ── 상수 (§8). `server/src/talus/constants.py` 가 기계 판독 사본이다 ──── */
export interface BallisticsConfig {
  gravity: number;
  powerScale: number;
  windMax: number;
  dragQ16: number;
  maxFlightTicks: number;
  selfHitIgnore: number;
  barrelLen: number;
  fallSafePx: number;
  fallDamageNum: number;
  fallDamageShift: number;
  burialPermille: number;
  burialDamage: number;
}

export const CFG: BallisticsConfig = {
  gravity: 12,
  powerScale: 624, // B12 확정 — 최대 파워 45° 사거리 = 맵 폭
  windMax: 4,
  dragQ16: 0,
  maxFlightTicks: 1800,
  selfHitIgnore: 8,
  barrelLen: 160,
  fallSafePx: 24,
  fallDamageNum: 1,
  fallDamageShift: 1,
  burialPermille: 800,
  burialDamage: 6,
};

/* ── 셀 조회. 격자 밖 규칙은 `terrain.md` §1.1 ─────────────────────────── */
export function solidAtSub(xs: number, ys: number): boolean {
  if (ys < 0) return false; // 위쪽 밖은 통과
  if (xs < 0 || xs >= MAP_W_SUB) return false; // 좌우 밖은 통과
  if (ys >= MAP_H_SUB) return false; // 아래쪽 밖은 소멸로 따로 처리
  const cx = xs >> CELL_SHIFT;
  const cy = ys >> CELL_SHIFT;
  return grid[cy * W + cx] !== EMPTY;
}

export type HitKind = "terrain" | "tank" | "void" | "timeout";

export interface Tank {
  slot: number;
  name: string;
  x: number;
  y: number;
  hp: number;
  alive: boolean;
  buried: boolean;
  angle10: number;
  power: number;
}

export interface ShotResult {
  xs: Int32Array;
  ys: Int32Array;
  n: number;
  hit: HitKind;
  hitX: number;
  hitY: number;
  hitTank: number;
  apexReached: boolean;
  apexX: number;
  apexY: number;
  apexVx: number;
  apexVy: number;
}

const pathX = new Int32Array(2048);
const pathY = new Int32Array(2048);

/**
 * 발사. 궤적 전체를 한 번에 계산해 돌려준다 —
 * 서버가 계산하고 클라가 재생하는 netcode 구조(§2.3)와 같은 모양이다.
 */
export function simulateShot(
  x0: number,
  y0: number,
  angle10: number,
  power: number,
  wind: number,
  shooterIdx: number,
  tanks: Tank[] | null,
  stopAtApex: boolean,
): ShotResult {
  const v0 = (power * CFG.powerScale) >> 10;
  const vx = (v0 * COS(angle10)) >> 12;
  const vy = -((v0 * SIN(angle10)) >> 12); // 괄호 필수 — §2.2
  return integrate(x0, y0, vx, vy, wind, shooterIdx, tanks, stopAtApex);
}

/** 자탄용 — 이미 정해진 속도에서 이어 적분한다 (분열탄) */
export function continueShot(
  x0: number,
  y0: number,
  vx: number,
  vy: number,
  wind: number,
  shooterIdx: number,
  tanks: Tank[] | null,
): ShotResult {
  return integrate(x0, y0, vx, vy, wind, shooterIdx, tanks, false);
}

function integrate(
  x0: number,
  y0: number,
  vx0: number,
  vy0: number,
  wind: number,
  shooterIdx: number,
  tanks: Tank[] | null,
  stopAtApex: boolean,
): ShotResult {
  let vx = vx0;
  let vy = vy0;
  let x = x0;
  let y = y0;
  let n = 0;
  let hit: HitKind = "timeout";
  let hitTank = -1;
  let apexReached = false;
  let apexX = 0;
  let apexY = 0;
  let apexVx = 0;
  let apexVy = 0;

  for (let t = 0; t < CFG.maxFlightTicks; t++) {
    /* 틱당 순서를 고정한다 (§4.2). 순서가 바뀌면 궤적이 달라진다. */
    vx += wind;
    vy += CFG.gravity;
    if (CFG.dragQ16 !== 0) vx -= (vx * CFG.dragQ16) >> 16;

    /* §4.3 — 틱 내 세분화. 잔차를 없애려 **절대 위치**로 누적한다.
       차분(pos += floorDiv(v, steps))을 반복하면 틱당 최대 4% 를 잃는다. */
    const L = iabs(vx) + iabs(vy);
    const steps = (L >> CELL_SHIFT) + 1; // 이동량이 항상 32 subpx 이하
    const sx = x;
    const sy = y;
    let done = false;

    for (let k = 1; k <= steps; k++) {
      x = sx + floorDiv(vx * k, steps);
      y = sy + floorDiv(vy * k, steps);

      if (y >= MAP_H_SUB) { hit = "void"; done = true; break; }
      if (solidAtSub(x, y)) { hit = "terrain"; done = true; break; }

      if (tanks !== null) {
        for (let i = 0; i < tanks.length; i++) {
          const tk = tanks[i];
          if (!tk.alive) continue;
          if (i === shooterIdx && t < CFG.selfHitIgnore) continue;
          if (
            x >= tk.x - (TANK_W >> 1) &&
            x <= tk.x + (TANK_W >> 1) &&
            y >= tk.y - TANK_H &&
            y <= tk.y
          ) {
            hit = "tank";
            hitTank = i;
            done = true;
            break;
          }
        }
        if (done) break;
      }
    }

    if (n < pathX.length) { pathX[n] = x; pathY[n] = y; n++; }
    if (done) break;

    /* 정점 — vy 가 처음 0 이상이 되는 틱. 분열탄이 거기서 갈라진다. */
    if (stopAtApex && !apexReached && vy >= 0) {
      apexReached = true;
      apexX = x; apexY = y; apexVx = vx; apexVy = vy;
      break;
    }
  }

  return { xs: pathX, ys: pathY, n, hit, hitX: x, hitY: y, hitTank,
           apexReached, apexX, apexY, apexVx, apexVy };
}

/**
 * 평지 사거리 (px). §8.1
 * 지형을 무시하고 "발사 높이로 되돌아온 순간"까지의 수평 거리다.
 * `tools/ballistics-check.mjs` 와 **같은 정의**여야 문서 표와 대조할 수 있다.
 */
export function flatRangePx(angle10: number, power: number, wind: number): number {
  const v0 = (power * CFG.powerScale) >> 10;
  let vx = (v0 * COS(angle10)) >> 12;
  let vy = -((v0 * SIN(angle10)) >> 12);
  let x = 0;
  let y = 0;
  for (let t = 0; t < CFG.maxFlightTicks; t++) {
    vx += wind;
    vy += CFG.gravity;
    if (CFG.dragQ16 !== 0) vx -= (vx * CFG.dragQ16) >> 16;
    const L = iabs(vx) + iabs(vy);
    const steps = (L >> CELL_SHIFT) + 1;
    const sx = x;
    const sy = y;
    for (let k = 1; k <= steps; k++) {
      x = sx + floorDiv(vx * k, steps);
      y = sy + floorDiv(vy * k, steps);
      if (y >= 0 && vy > 0) return x >> PX_SHIFT;
    }
  }
  return x >> PX_SHIFT;
}

function supportYAtTank(tank: Tank, xSub: number): number {
  const cx = clampInt(xSub >> CELL_SHIFT, 0, W - 1);
  const foot = clampInt(tank.y >> CELL_SHIFT, 0, H - 1);
  const from = foot > 8 ? foot - 8 : 0;
  const to = foot + 16 < H ? foot + 16 : H - 1;
  for (let y = from; y <= to; y++) if (grid[y * W + cx] !== EMPTY) return y;
  return foot;
}

/** 좌우 궤도 지지점으로 계산한 차체 경사. +는 화면 기준 시계 방향. */
export function tankTilt10(tank: Tank): number {
  const leftX = clampInt((tank.x - TANK_TILT_SAMPLE) >> CELL_SHIFT, 0, W - 1);
  const rightX = clampInt((tank.x + TANK_TILT_SAMPLE) >> CELL_SHIFT, 0, W - 1);
  const run = rightX - leftX;
  if (run <= 0) return 0;
  const rise = supportYAtTank(tank, tank.x + TANK_TILT_SAMPLE)
    - supportYAtTank(tank, tank.x - TANK_TILT_SAMPLE);
  if (rise === 0) return 0;
  const magnitude = iabs(rise);
  let bestAngle = 0;
  let bestError = 0x7fffffff;
  for (let angle10 = 0; angle10 <= TANK_TILT_MAX10; angle10++) {
    const error = iabs(magnitude * COS(angle10) - run * SIN(angle10));
    if (error < bestError) {
      bestError = error;
      bestAngle = angle10;
    }
  }
  return rise < 0 ? -bestAngle : bestAngle;
}

/** 조준 입력은 차체 기준 상대각, 탄도는 월드 절대각으로 변환한다. */
export function effectiveAngle10(tank: Tank, angle10: number): number {
  return clampInt(angle10 - tankTilt10(tank), 0, 1800);
}

export interface ShotPose {
  x: number;
  y: number;
  angle10: number;
  tilt10: number;
}

/** 기울어진 포탑 중심과 실제 월드 발사각으로 계산한 포신 끝. */
export function shotPose(tank: Tank, angle10: number): ShotPose {
  const tilt10 = tankTilt10(tank);
  const absTilt10 = iabs(tilt10);
  const tiltSin = tilt10 < 0 ? -SIN(absTilt10) : SIN(absTilt10);
  const anchorX = tank.x + ((TANK_H * tiltSin) >> 12);
  const anchorY = tank.y - ((TANK_H * COS(absTilt10)) >> 12);
  const shotAngle10 = clampInt(angle10 - tilt10, 0, 1800);
  return {
    x: anchorX + ((CFG.barrelLen * COS(shotAngle10)) >> 12),
    y: anchorY - ((CFG.barrelLen * SIN(shotAngle10)) >> 12),
    angle10: shotAngle10,
    tilt10,
  };
}

export function muzzle(tank: Tank, angle10: number): { x: number; y: number } {
  const pose = shotPose(tank, angle10);
  return {
    x: pose.x,
    y: pose.y,
  };
}

/* ══ 피해 (§5.1) ═══════════════════════════════════════════════════════ */
export interface WeaponDamage {
  maxDamage: number;
  blastRadius: number; // subpx. **2의 거듭제곱 강제**
  damageShift: number; // = log2(blastRadius)
}
export interface DamageHit {
  idx: number;
  dmg: number;
  dist: number;
}

/**
 * 피해를 계산만 한다. **적용하지 않는다** —
 * §5.2 대로 카빙 전 위치 기준으로 전부 계산한 뒤 한꺼번에 적용해야 한다.
 * 순차 적용하면 슬롯 1번 폭발로 밀린 탱크가 2번을 피해 슬롯 순서가 유불리를 만든다.
 */
export function computeDamage(
  cx: number,
  cy: number,
  weapon: WeaponDamage,
  tanks: Tank[],
): DamageHit[] {
  const out: DamageHit[] = [];
  for (let i = 0; i < tanks.length; i++) {
    const tk = tanks[i];
    if (!tk.alive) continue;
    const dx = tk.x - cx;
    const dy = tk.y - (TANK_H >> 1) - cy;
    const dist = isqrt(dx * dx + dy * dy);
    if (dist >= weapon.blastRadius) continue;
    out.push({
      idx: i,
      dmg: (weapon.maxDamage * (weapon.blastRadius - dist)) >> weapon.damageShift,
      dist,
    });
  }
  return out;
}

/* ══ 탱크 재배치 (§6.1) ════════════════════════════════════════════════
   정착이 **완전히** 끝난 뒤 한 번만 부른다 — 연결성 재검사 루프까지 끝난 뒤다.
   반환: 낙하 픽셀. 화면 밖으로 나갔으면 -1 */
export function reseatTank(tank: Tank): number {
  const startY = tank.y;
  let guard = 0;
  while (guard++ < H * 2) {
    if (tank.y >= MAP_H_SUB) return -1; // 화면 아래 이탈 → 즉사
    if (supported(tank)) break;
    tank.y += CELL_SUBPX;
  }
  /* 발밑이 솟아올랐으면 밀어올린다.
     임계는 **매몰 판정과 같은 값**이다 (`decisions.md` B13). 예전에는 1000‰ 에서만
     밀어올려서, 800~999‰ 에 안착하면 탈출 경로가 원리적으로 없었다 —
     턴당 6 피해로 약 17턴 확정사였다. */
  guard = 0;
  while (guard++ < H * 2 && buriedFraction(tank) >= CFG.burialPermille) tank.y -= CELL_SUBPX;
  const fallPx = (tank.y - startY) >> PX_SHIFT;
  return fallPx > 0 ? fallPx : 0;
}

export function supported(tank: Tank): boolean {
  const halfW = TANK_W >> 1;
  const footY = tank.y;
  if (footY >= MAP_H_SUB) return false;
  for (let xs = tank.x - halfW; xs <= tank.x + halfW; xs += CELL_SUBPX) {
    if (solidAtSub(xs, footY)) return true;
  }
  return false;
}

/** AABB 안에서 비-EMPTY 셀의 비율 (‰). 매몰 판정용 (§6.1) */
export function buriedFraction(tank: Tank): number {
  const halfW = TANK_W >> 1;
  let filled = 0;
  let total = 0;
  for (let ys = tank.y - TANK_H; ys < tank.y; ys += CELL_SUBPX) {
    for (let xs = tank.x - halfW; xs <= tank.x + halfW; xs += CELL_SUBPX) {
      total++;
      if (solidAtSub(xs, ys)) filled++;
    }
  }
  return total === 0 ? 0 : floorDiv(filled * 1000, total);
}

export function fallDamage(fallPx: number): number {
  if (fallPx <= CFG.fallSafePx) return 0;
  return ((fallPx - CFG.fallSafePx) * CFG.fallDamageNum) >> CFG.fallDamageShift;
}

/** 그 열의 지표면 y (subpx). 지형이 없으면 맵 바닥 */
export function surfaceSubY(xSub: number): number {
  const cx = clampInt(xSub >> CELL_SHIFT, 0, W - 1);
  for (let cy = 0; cy < H; cy++) {
    if (grid[cy * W + cx] !== EMPTY) return cy * CELL_SUBPX;
  }
  return MAP_H_SUB;
}

export function makeTank(slot: number, xSub: number, name: string): Tank {
  return {
    slot, name, x: xSub, y: surfaceSubY(xSub),
    hp: MAX_HP, alive: true, buried: false,
    angle10: slot % 2 === 0 ? 450 : 1350,
    power: 600,
  };
}

/** `BEDROCK` 참조를 유지해 정적 검사가 미사용 import 로 오해하지 않게 한다 */
export function isBedrockAt(cx: number, cy: number): boolean {
  return grid[cy * W + cx] === BEDROCK;
}
