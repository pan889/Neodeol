// Generated from client/src/sim/terrain.ts. Do not edit.
import { hash32, fnv1a32 } from "./intmath.js";
export const W = 960;
export const H = 540;
export const N = W * H;
export const EMPTY = 0;
export const SAND = 1;
export const SOIL = 2;
export const SCREE = 3;
export const ROCK = 4;
export const BEDROCK = 5;
export const MATERIAL_NAME = [
    "EMPTY",
    "SAND",
    "SOIL",
    "SCREE",
    "ROCK",
    "BEDROCK"
];
export const VOID = -1;
const RW_FALL = 3;
const RW_DIAG = 2;
const RW_CREEP = 1;
const PRIO_FALL = RW_FALL << 17;
export const ORD_FWD = 0;
export const ORD_REV = 1;
export const ORD_SPLIT = 2;
export const CFG = {
    slideSandQ8: 256,
    slideSoilQ8: 48,
    slideScreeQ8: 0,
    seed: 0x55,
    blastResistQ8: {
        [SAND]: 256,
        [SOIL]: 208,
        [SCREE]: 256,
        [ROCK]: 140
    },
    bothDirections: false,
    slideGateStatic: true
};
export const grid = new Uint8Array(N);
export const rowActive = new Uint8Array(H);
const rowNext = new Uint8Array(H);
let simStep = 0;
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
let resolveOrder = ORD_FWD;
let proposeBottomUp = true;
function orderAt(i, n) {
    if (resolveOrder === ORD_FWD) return i;
    if (resolveOrder === ORD_REV) return n - 1 - i;
    const half = n + 1 >> 1;
    return i < half ? (half - 1 - i) * 2 : (i - half) * 2 + 1;
}
export function setOrder(ro, bottomUp) {
    resolveOrder = ro;
    proposeBottomUp = bottomUp;
}
export function checksum() {
    return fnv1a32(grid);
}
export function massCount() {
    let c = 0;
    for(let i = 0; i < N; i++)if (grid[i] !== EMPTY) c++;
    return c;
}
function markBandNext(a, b) {
    let lo = a - 1;
    let hi = b + 1;
    if (lo < 0) lo = 0;
    if (hi > H - 1) hi = H - 1;
    for(let k = lo; k <= hi; k++)rowNext[k] = 1;
}
export function markRows(a, b) {
    if (a < 0) a = 0;
    if (b > H - 1) b = H - 1;
    for(let y = a; y <= b; y++)rowActive[y] = 1;
}
export function markAll() {
    rowActive.fill(1);
}
export function clearActive() {
    rowActive.fill(0);
}
export function activeRowCount() {
    let c = 0;
    for(let y = 0; y < H; y++)if (rowActive[y]) c++;
    return c;
}
function slideThreshold(m) {
    if (m === SAND) return CFG.slideSandQ8 << 8;
    if (m === SOIL) return CFG.slideSoilQ8 << 8;
    return CFG.slideScreeQ8 << 8;
}
export function step() {
    const st = simStep;
    const seed = CFG.seed;
    const gateStatic = CFG.slideGateStatic;
    const both = CFG.bothDirections;
    pN = 0;
    mN = 0;
    let mobile = 0;
    rowNext.fill(0);
    const yFrom = proposeBottomUp ? H - 1 : 0;
    const yTo = proposeBottomUp ? -1 : H;
    const yInc = proposeBottomUp ? -1 : 1;
    for(let y = yFrom; y !== yTo; y += yInc){
        if (!rowActive[y]) continue;
        const rowBase = y * W;
        const belowBase = rowBase + W;
        const yOut = y + 1 >= H;
        for(let x = 0; x < W; x++){
            const idx = rowBase + x;
            const m = grid[idx];
            if (m === EMPTY || m === ROCK || m === BEDROCK) continue;
            if (yOut) {
                pushMove(idx, VOID, m, y, y);
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
            const cl = x === 0 ? EMPTY : grid[idx - 1];
            const cr = x === W - 1 ? EMPTY : grid[idx + 1];
            if (cl !== EMPTY && cr !== EMPTY) continue;
            const thr = slideThreshold(m);
            let r3ok;
            if (thr === 0) r3ok = false;
            else if (gateStatic) r3ok = (hash32(seed ^ 0x9e3779b9, x, y, 0) >>> 8 & 0xffff) < thr;
            else r3ok = true;
            let rL = 0;
            let dL = 0;
            let rR = 0;
            let dR = 0;
            if (x === 0) {
                rL = 2;
                dL = VOID;
            } else if (cl === EMPTY) {
                if (grid[belowBase + x - 1] === EMPTY) {
                    rL = 2;
                    dL = belowBase + x - 1;
                } else if (r3ok) {
                    const xl2 = x - 2;
                    if (xl2 < 0) {
                        rL = 3;
                        dL = idx - 1;
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
            if (rL === 0 && rR === 0) continue;
            mobile++;
            markBandNext(y, y + 1);
            const h = hash32(seed, x, y, st);
            const side = h & 1;
            let rule;
            let dst;
            let usedSide;
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
            if (rule === 0) continue;
            if (rule === 3 && !gateStatic && (h >>> 8 & 0xffff) >= thr) continue;
            const dRow = rule === 3 ? y : y + 1;
            if (dst === VOID) {
                pushMove(idx, VOID, m, y, dRow);
                continue;
            }
            const dstX = dst - dRow * W;
            const flip = hash32(seed, dstX, dRow, st) & 1;
            pSrc[pN] = idx;
            pDst[pN] = dst;
            pRow[pN] = y;
            pDRow[pN] = dRow;
            pPrio[pN] = (rule === 3 ? RW_CREEP : RW_DIAG) << 17 | ((usedSide ^ flip) & 1) << 16 | h & 0xffff;
            pN++;
        }
    }
    const n = pN;
    const stamp = ++stampCtr;
    for(let i = 0; i < n; i++){
        const k = orderAt(i, n);
        const dst = pDst[k];
        if (bestStamp[dst] !== stamp) {
            bestStamp[dst] = stamp;
            bestPrio[dst] = pPrio[k];
        } else if (pPrio[k] > bestPrio[dst]) {
            bestPrio[dst] = pPrio[k];
        }
    }
    for(let i = 0; i < n; i++){
        const k = orderAt(i, n);
        const dst = pDst[k];
        if (pPrio[k] !== bestPrio[dst]) continue;
        if (tieWatch) {
            if (tieMark[dst]) tieCount++;
            else tieMark[dst] = 1;
        }
        pushMove(pSrc[k], dst, grid[pSrc[k]], pRow[k], pDRow[k]);
    }
    for(let i = 0; i < mN; i++)grid[mSrc[i]] = EMPTY;
    for(let i = 0; i < mN; i++)if (mDst[i] !== VOID) grid[mDst[i]] = mMat[i];
    if (tieWatch) {
        for(let i = 0; i < mN; i++)if (mDst[i] !== VOID) tieMark[mDst[i]] = 0;
    }
    rowActive.set(rowNext);
    lastMoved = mN;
    lastMobile = mobile;
    simStep = simStep + 1 | 0;
    return {
        moved: mN,
        mobile
    };
}
function pushMove(src, dst, mat, srcRow, dRow) {
    mSrc[mN] = src;
    mDst[mN] = dst;
    mMat[mN] = mat;
    mRow[mN] = srcRow;
    mDRow[mN] = dRow;
    mN++;
}
const carveR2 = new Int32Array(6);
function carveOnly(cx, cy, radiusCells) {
    for(let m = 1; m <= 5; m++){
        const resist = CFG.blastResistQ8[m];
        if (resist === undefined) {
            carveR2[m] = -1;
            continue;
        }
        const rm = radiusCells * resist >> 8;
        carveR2[m] = rm * rm;
    }
    const y0 = cy - radiusCells < 0 ? 0 : cy - radiusCells;
    const y1 = cy + radiusCells > H - 1 ? H - 1 : cy + radiusCells;
    const x0 = cx - radiusCells < 0 ? 0 : cx - radiusCells;
    const x1 = cx + radiusCells > W - 1 ? W - 1 : cx + radiusCells;
    let removed = 0;
    let hitRock = false;
    for(let y = y0; y <= y1; y++){
        const dy = y - cy;
        const dy2 = dy * dy;
        const base = y * W;
        for(let x = x0; x <= x1; x++){
            const idx = base + x;
            const m = grid[idx];
            if (m === EMPTY) continue;
            const r2 = carveR2[m];
            if (r2 < 0) continue;
            const dx = x - cx;
            if (dx * dx + dy2 <= r2) {
                grid[idx] = EMPTY;
                removed++;
                if (m === ROCK) hitRock = true;
            }
        }
    }
    markRows(y0 - 2, y1 + 2);
    return {
        removed,
        hitRock
    };
}
export function carve(cx, cy, radiusCells) {
    const r = carveOnly(cx, cy, radiusCells);
    return {
        removed: r.removed,
        conv: r.hitRock ? connectivity() : 0
    };
}
export function carveDeferred(cx, cy, radiusCells) {
    const r = carveOnly(cx, cy, radiusCells);
    return {
        removed: r.removed,
        conv: 0
    };
}
export function deposit(cx, cy, radiusCells, mat) {
    const r2 = radiusCells * radiusCells;
    const y0 = cy - radiusCells < 0 ? 0 : cy - radiusCells;
    const y1 = cy + radiusCells > H - 1 ? H - 1 : cy + radiusCells;
    const x0 = cx - radiusCells < 0 ? 0 : cx - radiusCells;
    const x1 = cx + radiusCells > W - 1 ? W - 1 : cx + radiusCells;
    let filled = 0;
    for(let y = y0; y <= y1; y++){
        const dy = y - cy;
        const dy2 = dy * dy;
        const base = y * W;
        for(let x = x0; x <= x1; x++){
            const idx = base + x;
            if (grid[idx] !== EMPTY) continue;
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
export function connectivity() {
    visited.fill(0);
    let sp = 0;
    for(let i = 0; i < N; i++){
        if (grid[i] === BEDROCK) {
            visited[i] = 1;
            ffStack[sp++] = i;
        }
    }
    while(sp > 0){
        const i = ffStack[--sp];
        const x = i % W;
        let j;
        if (x > 0) {
            j = i - 1;
            if (!visited[j] && (grid[j] === ROCK || grid[j] === BEDROCK)) {
                visited[j] = 1;
                ffStack[sp++] = j;
            }
        }
        if (x < W - 1) {
            j = i + 1;
            if (!visited[j] && (grid[j] === ROCK || grid[j] === BEDROCK)) {
                visited[j] = 1;
                ffStack[sp++] = j;
            }
        }
        if (i >= W) {
            j = i - W;
            if (!visited[j] && (grid[j] === ROCK || grid[j] === BEDROCK)) {
                visited[j] = 1;
                ffStack[sp++] = j;
            }
        }
        if (i < N - W) {
            j = i + W;
            if (!visited[j] && (grid[j] === ROCK || grid[j] === BEDROCK)) {
                visited[j] = 1;
                ffStack[sp++] = j;
            }
        }
    }
    let conv = 0;
    let minY = H;
    let maxY = -1;
    for(let y = 0; y < H; y++){
        const base = y * W;
        for(let x = 0; x < W; x++){
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
export function countMobile() {
    let r1 = 0;
    let r2 = 0;
    let r3 = 0;
    const seed = CFG.seed;
    const gateStatic = CFG.slideGateStatic;
    for(let y = 0; y < H; y++){
        const rowBase = y * W;
        const belowBase = rowBase + W;
        const yOut = y + 1 >= H;
        for(let x = 0; x < W; x++){
            const idx = rowBase + x;
            const m = grid[idx];
            if (m === EMPTY || m === ROCK || m === BEDROCK) continue;
            if (yOut || grid[belowBase + x] === EMPTY) {
                r1++;
                continue;
            }
            const thr = slideThreshold(m);
            const r3ok = thr === 0 ? false : gateStatic ? (hash32(seed ^ 0x9e3779b9, x, y, 0) >>> 8 & 0xffff) < thr : true;
            let hit = 0;
            for(let s = 0; s < 2 && !hit; s++){
                const d = s ? 1 : -1;
                const xd = x + d;
                if (xd < 0 || xd >= W) {
                    hit = 2;
                    break;
                }
                if (grid[idx + d] !== EMPTY) continue;
                if (grid[belowBase + xd] === EMPTY) {
                    hit = 2;
                    break;
                }
                if (!r3ok) continue;
                const xd2 = x + d + d;
                if (xd2 < 0 || xd2 >= W) {
                    hit = 3;
                    break;
                }
                if (grid[idx + d + d] === EMPTY && grid[belowBase + xd2] === EMPTY) {
                    hit = 3;
                    break;
                }
            }
            if (hit === 2) r2++;
            else if (hit === 3) r3++;
        }
    }
    return {
        rule1: r1,
        rule2: r2,
        rule3: r3,
        total: r1 + r2 + r3
    };
}
export function snapshot() {
    return {
        g: grid.slice(),
        st: simStep,
        ra: rowActive.slice()
    };
}
export function restore(s) {
    grid.set(s.g);
    simStep = s.st;
    rowActive.set(s.ra);
    mN = 0;
    lastMoved = 0;
}
export function getStep() {
    return simStep;
}
export function setStep(v) {
    simStep = v | 0;
}
export function getLastMoved() {
    return lastMoved;
}
export function getLastMobile() {
    return lastMobile;
}
export function setTieWatch(on) {
    tieWatch = on;
    if (on) {
        tieCount = 0;
        tieMark.fill(0);
    }
}
export function getTieCount() {
    return tieCount;
}
export const moved = {
    src: mSrc,
    dst: mDst,
    row: mRow,
    drow: mDRow,
    mat: mMat
};
export function getMovedCount() {
    return mN;
}
export function setMovedCount(v) {
    mN = v | 0;
}
