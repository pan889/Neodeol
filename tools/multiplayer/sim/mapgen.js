// Generated from client/src/sim/mapgen.ts. Do not edit.
import { clampInt, floorDiv, hash32, iabs } from "./intmath.js";
import { BEDROCK, EMPTY, H, N, ROCK, SAND, SCREE, SOIL, W } from "./terrain.js";
export const MAPGEN_VERSION = 1;
export const NOISE_SHIFT = 7;
export const SURFACE_BASE = 170;
export const SURFACE_AMP = 60;
export const BEDROCK_Y = 522;
const NOISE_MASK = 127;
const NOISE_SALT = 0x4d47;
const ANCHOR_SALT = 0xa11c;
const ARCH_SALT = 0xa2c4;
const ANCHOR_BASE_X = [
    160,
    320,
    640,
    800
];
function setCell(target, x, y, material) {
    target[y * W + x] = material;
}
function fillVertical(target, x, yStart, yEnd, material) {
    const start = clampInt(yStart, 0, H - 1);
    const end = clampInt(yEnd, 0, H - 1);
    for(let y = start; y <= end; y++)setCell(target, x, y, material);
}
function generatedSurface(mapSeed, x) {
    const sample = x >> NOISE_SHIFT;
    const fraction = x & NOISE_MASK;
    const a = hash32(mapSeed, sample, NOISE_SALT, 0) & 0xffff;
    const b = hash32(mapSeed, sample + 1, NOISE_SALT, 0) & 0xffff;
    const noise = a + ((b - a) * fraction >> NOISE_SHIFT);
    return clampInt(SURFACE_BASE + ((noise - 32768) * SURFACE_AMP >> 16), 96, 260);
}
function buildLayers(target, surface) {
    for(let x = 0; x < W; x++){
        let y = surface[x];
        fillVertical(target, x, y, y + 17, SAND);
        y += 18;
        fillVertical(target, x, y, y + 27, SOIL);
        y += 28;
        fillVertical(target, x, y, y + 9, SAND);
        y += 10;
        fillVertical(target, x, y, y + 11, SCREE);
        y += 12;
        fillVertical(target, x, y, y + 39, SOIL);
        y += 40;
        fillVertical(target, x, y, BEDROCK_Y - 1, ROCK);
        fillVertical(target, x, BEDROCK_Y, H - 1, BEDROCK);
    }
}
function addAnchors(target, surface, mapSeed) {
    for(let i = 0; i < ANCHOR_BASE_X.length; i++){
        const jitter = (hash32(mapSeed, i, ANCHOR_SALT, 0) & 31) - 15;
        const x = clampInt(ANCHOR_BASE_X[i] + jitter, 24, 935);
        const top = clampInt(surface[x] + 96, 220, 500);
        for(let column = x - 3; column <= x + 2; column++){
            fillVertical(target, column, top, H - 1, BEDROCK);
        }
    }
}
function addArch(target, surface, mapSeed) {
    const center = 480 + ((hash32(mapSeed, 0, ARCH_SALT, 0) & 127) - 63);
    const left = center - 72;
    const right = center + 72;
    let deepestSurface = surface[left];
    for(let x = left + 1; x <= right; x++){
        if (surface[x] > deepestSurface) deepestSurface = surface[x];
    }
    const roofY = deepestSurface + 24;
    let legBottom = roofY + 64;
    const leftBottom = surface[left] + 112;
    const rightBottom = surface[right] + 112;
    if (leftBottom > legBottom) legBottom = leftBottom;
    if (rightBottom > legBottom) legBottom = rightBottom;
    legBottom = clampInt(legBottom, roofY + 64, 510);
    for(let x = left; x <= right; x++)fillVertical(target, x, roofY, roofY + 7, ROCK);
    for(let x = left + 8; x <= right - 8; x++){
        fillVertical(target, x, roofY + 8, roofY + 56, EMPTY);
    }
    for(let x = left; x <= left + 7; x++)fillVertical(target, x, roofY, legBottom, ROCK);
    for(let x = right - 7; x <= right; x++)fillVertical(target, x, roofY, legBottom, ROCK);
}
export function surfaceCellY(source, x) {
    const column = clampInt(x, 0, W - 1);
    for(let y = 0; y < H; y++){
        if (source[y * W + column] !== EMPTY) return y;
    }
    return H - 1;
}
function sealEdges(target) {
    const leftTop = surfaceCellY(target, 2);
    const rightTop = surfaceCellY(target, W - 3);
    for(let x = 0; x < 2; x++)fillVertical(target, x, leftTop, H - 1, BEDROCK);
    for(let x = W - 2; x < W; x++)fillVertical(target, x, rightTop, H - 1, BEDROCK);
}
export function buildMap(mapSeed) {
    const target = new Uint8Array(N);
    const surface = new Int16Array(W);
    for(let x = 0; x < W; x++)surface[x] = generatedSurface(mapSeed, x);
    buildLayers(target, surface);
    addAnchors(target, surface, mapSeed);
    addArch(target, surface, mapSeed);
    sealEdges(target);
    return target;
}
export function chooseSpawnCells(source, playerCount) {
    if (source.length !== N) throw new RangeError("grid length must be 960 * 540");
    if (playerCount < 2 || playerCount > 6) throw new RangeError("playerCount must be 2..6");
    const selected = [];
    for(let slot = 0; slot < playerCount; slot++){
        const target = floorDiv((slot + 1) * W, playerCount + 1);
        const start = clampInt(target - 72, 16, W - 17);
        const end = clampInt(target + 72, 16, W - 17);
        let bestX = -1;
        let bestScore = 0x7fffffff;
        for(let x = start; x <= end; x++){
            let separated = true;
            for (const other of selected){
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
    selected.sort((a, b)=>a - b);
    return selected;
}
