// Generated from client/src/sim/trig.ts. Do not edit.
export const TRIG_DECIDEG_MAX = 1800;
export const TRIG_COUNT = TRIG_DECIDEG_MAX + 1;
export const TRIG_SHIFT = 12;
export const TRIG_SCALE = 1 << TRIG_SHIFT;
export const TRIG_BYTES = TRIG_COUNT * 2 * 2;
let SIN_ARR = null;
let COS_ARR = null;
export function loadTrig(bytes) {
    if (bytes.length !== TRIG_BYTES) {
        throw new Error(`trig.bin 크기가 다르다: ${bytes.length} (기대 ${TRIG_BYTES})`);
    }
    const copy = new Uint8Array(bytes);
    const view = new DataView(copy.buffer);
    const sin = new Int16Array(TRIG_COUNT);
    const cos = new Int16Array(TRIG_COUNT);
    for(let i = 0; i < TRIG_COUNT; i++){
        sin[i] = view.getInt16(i * 2, true);
        cos[i] = view.getInt16((TRIG_COUNT + i) * 2, true);
    }
    if (sin[0] !== 0 || cos[0] !== TRIG_SCALE) throw new Error("trig.bin 0° 값이 틀렸다");
    if (sin[900] !== TRIG_SCALE || cos[900] !== 0) throw new Error("trig.bin 90° 값이 틀렸다");
    if (sin[1800] !== 0 || cos[1800] !== -TRIG_SCALE) throw new Error("trig.bin 180° 값이 틀렸다");
    if (sin[450] !== 2896 || cos[450] !== 2896) throw new Error("trig.bin 45° 값이 틀렸다");
    SIN_ARR = sin;
    COS_ARR = cos;
}
export function trigLoaded() {
    return SIN_ARR !== null;
}
function table(which) {
    const t = which === "sin" ? SIN_ARR : COS_ARR;
    if (t === null) throw new Error("loadTrig() 를 먼저 불러야 한다 (tables/trig.bin)");
    return t;
}
export function SIN(deg10) {
    return table("sin")[deg10];
}
export function COS(deg10) {
    return table("cos")[deg10];
}
