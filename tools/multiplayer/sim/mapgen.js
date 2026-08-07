// Generated from client/src/sim/mapgen.ts. Do not edit.
import { clampInt, floorDiv, hash32, iabs } from "./intmath.js";
import { BEDROCK, EMPTY, H, N, ROCK, SAND, SCREE, SOIL, W } from "./terrain.js";
export const MAPGEN_VERSION = 2;
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
export const PROVINCES = [
    {
        bands: [
            34,
            14,
            6,
            10,
            30
        ],
        bedrockDepth: 0
    },
    {
        bands: [
            0,
            48,
            4,
            8,
            40
        ],
        bedrockDepth: 0
    },
    {
        bands: [
            0,
            0,
            0,
            34,
            30
        ],
        bedrockDepth: 0
    },
    {
        bands: [
            6,
            12,
            0,
            6,
            16
        ],
        bedrockDepth: 132
    }
];
const PROVINCE_SALT = 0x9e07;
function provinceOrder(mapSeed) {
    const order = [
        0,
        1,
        2,
        3
    ];
    for(let i = order.length - 1; i > 0; i--){
        const j = hash32(mapSeed, i, PROVINCE_SALT, 1) % (i + 1);
        const t = order[i];
        order[i] = order[j];
        order[j] = t;
    }
    return order;
}
const PROVINCE_BLEND = 48;
function provinceAt(mapSeed, x) {
    const count = 4 + (hash32(mapSeed, 0, PROVINCE_SALT, 0) & 1);
    const width = floorDiv(W, count);
    let index = floorDiv(x, width);
    if (index >= count) index = count - 1;
    const localX = x - index * width;
    const pick = (i)=>provinceOrder(mapSeed)[i % PROVINCES.length];
    const here = pick(index);
    if (localX >= PROVINCE_BLEND || index === 0) return {
        a: here,
        b: here,
        t: 0
    };
    return {
        a: pick(index - 1),
        b: here,
        t: localX
    };
}
function blendBand(a, b, t) {
    return a + floorDiv((b - a) * t, PROVINCE_BLEND);
}
function buildLayers(target, surface, mapSeed) {
    for(let x = 0; x < W; x++){
        const p = provinceAt(mapSeed, x);
        const pa = PROVINCES[p.a];
        const pb = PROVINCES[p.b];
        const bands = [];
        for(let i = 0; i < 5; i++)bands.push(blendBand(pa.bands[i], pb.bands[i], p.t));
        const bedrockDepth = blendBand(pa.bedrockDepth, pb.bedrockDepth, p.t);
        let y = surface[x];
        const order = [
            SAND,
            SOIL,
            SAND,
            SCREE,
            SOIL
        ];
        for(let i = 0; i < 5; i++){
            if (bands[i] <= 0) continue;
            fillVertical(target, x, y, y + bands[i] - 1, order[i]);
            y += bands[i];
        }
        let bedrockTop = BEDROCK_Y;
        if (bedrockDepth > 0) {
            const shelf = surface[x] + bedrockDepth;
            if (shelf < bedrockTop) bedrockTop = shelf;
        }
        if (y < bedrockTop) fillVertical(target, x, y, bedrockTop - 1, ROCK);
        fillVertical(target, x, bedrockTop, H - 1, BEDROCK);
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
    buildLayers(target, surface, mapSeed);
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
