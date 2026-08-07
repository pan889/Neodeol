// Generated from client/src/sim/intmath.ts. Do not edit.
export function floorDiv(a, b) {
    const q = (a - (a % b + b) % b) / b;
    return q | 0;
}
export function isqrt(n) {
    if (n <= 0) return 0;
    if (n < 4) return 1;
    let x = n;
    let y = x + 1 >> 1;
    while(y < x){
        x = y;
        y = x + floorDiv(n, x) >> 1;
    }
    return x;
}
export function iabs(v) {
    return v < 0 ? -v : v;
}
export function clampInt(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}
export const FNV_OFFSET = 0x811c9dc5 | 0;
export const FNV_PRIME = 0x01000193 | 0;
export function hash32(seed, x, y, step) {
    const v = (seed ^ Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x85ebca77) ^ Math.imul(step, 0xc2b2ae3d)) >>> 0;
    let h = FNV_OFFSET;
    h = Math.imul(h ^ v & 0xff, FNV_PRIME);
    h = Math.imul(h ^ v >>> 8 & 0xff, FNV_PRIME);
    h = Math.imul(h ^ v >>> 16 & 0xff, FNV_PRIME);
    h = Math.imul(h ^ v >>> 24 & 0xff, FNV_PRIME);
    h = (h ^ h >>> 15) >>> 0;
    h = Math.imul(h, 0x2545f491) >>> 0;
    h = (h ^ h >>> 13) >>> 0;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    return (h ^ h >>> 16) >>> 0;
}
export function fnv1a32(bytes) {
    let h = FNV_OFFSET;
    for(let i = 0; i < bytes.length; i++)h = Math.imul(h ^ bytes[i], FNV_PRIME);
    return h >>> 0;
}
export function hex8(u) {
    return (u >>> 0).toString(16).toUpperCase().padStart(8, "0");
}
