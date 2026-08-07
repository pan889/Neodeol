/** 결정론적 초기 맵 생성 — docs/mapgen.md. */

import { clampInt, floorDiv, hash32, iabs } from "./intmath.ts";
import {
  BEDROCK,
  EMPTY,
  H,
  N,
  ROCK,
  SAND,
  SCREE,
  SOIL,
  W,
} from "./terrain.ts";

export const MAPGEN_VERSION = 2;
export const NOISE_SHIFT = 7;
export const SURFACE_BASE = 170;
export const SURFACE_AMP = 60;
export const BEDROCK_Y = 522;

const NOISE_MASK = 127;
const NOISE_SALT = 0x4d47;
const ANCHOR_SALT = 0xa11c;
const ARCH_SALT = 0xa2c4;
const ANCHOR_BASE_X = [160, 320, 640, 800] as const;

function setCell(target: Uint8Array, x: number, y: number, material: number): void {
  target[y * W + x] = material;
}

function fillVertical(
  target: Uint8Array,
  x: number,
  yStart: number,
  yEnd: number,
  material: number,
): void {
  const start = clampInt(yStart, 0, H - 1);
  const end = clampInt(yEnd, 0, H - 1);
  for (let y = start; y <= end; y++) setCell(target, x, y, material);
}

function generatedSurface(mapSeed: number, x: number): number {
  const sample = x >> NOISE_SHIFT;
  const fraction = x & NOISE_MASK;
  const a = hash32(mapSeed, sample, NOISE_SALT, 0) & 0xffff;
  const b = hash32(mapSeed, sample + 1, NOISE_SALT, 0) & 0xffff;
  const noise = a + (((b - a) * fraction) >> NOISE_SHIFT);
  return clampInt(SURFACE_BASE + (((noise - 32768) * SURFACE_AMP) >> 16), 96, 260);
}

/* ══ 지질 구역 (§3.1) ═════════════════════════════════════════════════════
   맵을 좌우로 나눠 **구역마다 다른 지층**을 깐다.

   그 전에는 960열 전부가 같은 지층(SAND 18 / SOIL 28 / SAND 10 / SCREE 12 / SOIL 40)
   이었다. 그래서 실측으로 갈라놓은 안식각 26.6°/40.3°/44.2° 가 전술적으로 아무 일도
   하지 않았다 — 어디를 파도 같은 순서로 같은 것이 나오니 **서 있는 자리가 의미가 없었다.**

   **표면 형상은 건드리지 않는다.** 바뀌는 것은 지표 아래 두께뿐이라 새로 노출되는 경사가
   없고, 따라서 초기 정착 비용이 늘지 않는다 (실측 §11). 차이는 **파헤쳤을 때** 드러난다 —
   모래 분지를 파면 26.6° 로 넓게 흘러내리고, 점토 대지를 파면 40.3° 벽이 그대로 선다. */

/** 구역 프로파일. 위에서부터의 두께이고, 남는 깊이는 `ROCK` 이 채운다. */
interface Province {
  /** [SAND, SOIL, SAND, SCREE, SOIL] 두께 (셀) */
  bands: readonly [number, number, number, number, number];
  /** 기반암 상단을 지표에서 얼마나 아래에 둘 것인가. 0 이면 `BEDROCK_Y` 그대로 */
  bedrockDepth: number;
}

/* **표면 재질이 구역마다 달라야 한다.** 첫 판에서는 네 구역 모두 SAND 로 시작했는데,
   그러면 화면상 전부 모래라 플레이어가 서 있는 땅을 구분할 수 없다 — 지질이 달라도
   보이지 않으면 전술이 되지 않는다. 앞 밴드를 0 으로 두어 아래 재질을 노출시킨다.
   노출된 SOIL(40.3°)·SCREE(44.2°) 는 지표 경사(최대 25°)보다 안식각이 급해서
   그대로 서 있는다 — 노출시켜도 정착 비용이 안 든다 (실측 §11). */
export const PROVINCES: readonly Province[] = [
  /* 0 모래 분지 — 두꺼운 모래가 지표에 드러난다. 파면 26.6° 로 넓게 흘러내린다 */
  { bands: [34, 14, 6, 10, 30], bedrockDepth: 0 },
  /* 1 점토 대지 — 점토가 지표다. 40.3° 급한 벽이 서고 잘 안 무너진다 */
  { bands: [0, 48, 4, 8, 40], bedrockDepth: 0 },
  /* 2 자갈 사면 — 자갈이 지표다. 44.2° 각진 더미를 만든다 */
  { bands: [0, 0, 0, 34, 30], bedrockDepth: 0 },
  /* 3 암반 선반 — 얇은 표토 밑이 바로 기반암이다. 깊이 못 파는 대신 발밑이 안전하다 */
  { bands: [6, 12, 0, 6, 16], bedrockDepth: 132 },
];

const PROVINCE_SALT = 0x9e07;
/** 구역 배치 순열. **한 맵 안에 네 지질이 전부 나오는 것을 보장한다.**

    처음에는 구역마다 `hash32(...) % 4` 로 독립 추첨했는데, 그러면 시드에 따라 맵 전체가
    한 지질로 덮인다 (실측: 모래 809열 / 960). 그러면 "어디에 서 있느냐"가 다시 의미를
    잃는다 — 다양성이 이 변경의 전부인데 우연에 맡길 이유가 없다.

    정수 전용 Fisher-Yates 다. 결정론을 위해 `hash32` 만 쓴다. */
function provinceOrder(mapSeed: number): number[] {
  const order = [0, 1, 2, 3];
  for (let i = order.length - 1; i > 0; i--) {
    const j = hash32(mapSeed, i, PROVINCE_SALT, 1) % (i + 1);
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  return order;
}

/** 구역 경계가 지층을 수직으로 자르지 않게 섞는 폭 (셀) */
const PROVINCE_BLEND = 48;

/** 열 `x` 가 속한 구역과, 경계에서의 이웃·혼합 가중치 */
function provinceAt(mapSeed: number, x: number): { a: number; b: number; t: number } {
  const count = 4 + (hash32(mapSeed, 0, PROVINCE_SALT, 0) & 1); // 4 또는 5 구역
  const width = floorDiv(W, count);
  let index = floorDiv(x, width);
  if (index >= count) index = count - 1;
  const localX = x - index * width;

  const pick = (i: number): number => provinceOrder(mapSeed)[i % PROVINCES.length];

  const here = pick(index);
  if (localX >= PROVINCE_BLEND || index === 0) return { a: here, b: here, t: 0 };
  /* 경계 왼쪽 절반은 이전 구역과 섞는다. t 는 0..PROVINCE_BLEND 의 정수 가중치 */
  return { a: pick(index - 1), b: here, t: localX };
}

/** 두 프로파일을 정수 가중 평균한다. `t/PROVINCE_BLEND` 비율로 b 쪽에 간다 */
function blendBand(a: number, b: number, t: number): number {
  return a + floorDiv((b - a) * t, PROVINCE_BLEND);
}

function buildLayers(target: Uint8Array, surface: Int16Array, mapSeed: number): void {
  for (let x = 0; x < W; x++) {
    const p = provinceAt(mapSeed, x);
    const pa = PROVINCES[p.a];
    const pb = PROVINCES[p.b];
    const bands: number[] = [];
    for (let i = 0; i < 5; i++) bands.push(blendBand(pa.bands[i], pb.bands[i], p.t));
    const bedrockDepth = blendBand(pa.bedrockDepth, pb.bedrockDepth, p.t);

    let y = surface[x];
    const order = [SAND, SOIL, SAND, SCREE, SOIL];
    for (let i = 0; i < 5; i++) {
      if (bands[i] <= 0) continue;
      fillVertical(target, x, y, y + bands[i] - 1, order[i]);
      y += bands[i];
    }
    /* 기반암 상단. 선반 구역은 지표 가까이 올라온다 */
    let bedrockTop = BEDROCK_Y;
    if (bedrockDepth > 0) {
      const shelf = surface[x] + bedrockDepth;
      if (shelf < bedrockTop) bedrockTop = shelf;
    }
    if (y < bedrockTop) fillVertical(target, x, y, bedrockTop - 1, ROCK);
    fillVertical(target, x, bedrockTop, H - 1, BEDROCK);
  }
}

function addAnchors(target: Uint8Array, surface: Int16Array, mapSeed: number): void {
  for (let i = 0; i < ANCHOR_BASE_X.length; i++) {
    const jitter = (hash32(mapSeed, i, ANCHOR_SALT, 0) & 31) - 15;
    const x = clampInt(ANCHOR_BASE_X[i] + jitter, 24, 935);
    const top = clampInt(surface[x] + 96, 220, 500);
    for (let column = x - 3; column <= x + 2; column++) {
      fillVertical(target, column, top, H - 1, BEDROCK);
    }
  }
}

function addArch(target: Uint8Array, surface: Int16Array, mapSeed: number): void {
  const center = 480 + ((hash32(mapSeed, 0, ARCH_SALT, 0) & 127) - 63);
  const left = center - 72;
  const right = center + 72;
  let deepestSurface = surface[left];
  for (let x = left + 1; x <= right; x++) {
    if (surface[x] > deepestSurface) deepestSurface = surface[x];
  }
  const roofY = deepestSurface + 24;
  let legBottom = roofY + 64;
  const leftBottom = surface[left] + 112;
  const rightBottom = surface[right] + 112;
  if (leftBottom > legBottom) legBottom = leftBottom;
  if (rightBottom > legBottom) legBottom = rightBottom;
  legBottom = clampInt(legBottom, roofY + 64, 510);

  for (let x = left; x <= right; x++) fillVertical(target, x, roofY, roofY + 7, ROCK);
  for (let x = left + 8; x <= right - 8; x++) {
    fillVertical(target, x, roofY + 8, roofY + 56, EMPTY);
  }
  for (let x = left; x <= left + 7; x++) fillVertical(target, x, roofY, legBottom, ROCK);
  for (let x = right - 7; x <= right; x++) fillVertical(target, x, roofY, legBottom, ROCK);
}

export function surfaceCellY(source: Uint8Array, x: number): number {
  const column = clampInt(x, 0, W - 1);
  for (let y = 0; y < H; y++) {
    if (source[y * W + column] !== EMPTY) return y;
  }
  return H - 1;
}

function sealEdges(target: Uint8Array): void {
  const leftTop = surfaceCellY(target, 2);
  const rightTop = surfaceCellY(target, W - 3);
  for (let x = 0; x < 2; x++) fillVertical(target, x, leftTop, H - 1, BEDROCK);
  for (let x = W - 2; x < W; x++) fillVertical(target, x, rightTop, H - 1, BEDROCK);
}

export function buildMap(mapSeed: number): Uint8Array {
  const target = new Uint8Array(N);
  const surface = new Int16Array(W);
  for (let x = 0; x < W; x++) surface[x] = generatedSurface(mapSeed, x);
  buildLayers(target, surface, mapSeed);
  addAnchors(target, surface, mapSeed);
  addArch(target, surface, mapSeed);
  sealEdges(target);
  return target;
}

export function chooseSpawnCells(source: Uint8Array, playerCount: number): number[] {
  if (source.length !== N) throw new RangeError("grid length must be 960 * 540");
  if (playerCount < 2 || playerCount > 6) throw new RangeError("playerCount must be 2..6");

  const selected: number[] = [];
  for (let slot = 0; slot < playerCount; slot++) {
    const target = floorDiv((slot + 1) * W, playerCount + 1);
    const start = clampInt(target - 72, 16, W - 17);
    const end = clampInt(target + 72, 16, W - 17);
    let bestX = -1;
    let bestScore = 0x7fffffff;

    for (let x = start; x <= end; x++) {
      let separated = true;
      for (const other of selected) {
        if (iabs(x - other) < 96) {
          separated = false;
          break;
        }
      }
      if (!separated) continue;

      const y = surfaceCellY(source, x);
      const flatness = iabs(surfaceCellY(source, x - 6) - y) + iabs(surfaceCellY(source, x + 6) - y);
      const score = flatness * 256 + iabs(x - target);
      if (score < bestScore) {
        bestScore = score;
        bestX = x;
      }
    }

    selected.push(bestX < 0 ? clampInt(target, 16, W - 17) : bestX);
  }

  selected.sort((a, b) => a - b);
  return selected;
}
