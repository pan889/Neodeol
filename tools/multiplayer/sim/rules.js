// Generated from client/src/sim/rules.ts. Do not edit.
import { fnv1a32, hex8 } from "./intmath.js";
import * as T from "./terrain.js";
import * as B from "./ballistics.js";
import * as Wp from "./weapons.js";
import * as M from "./mapgen.js";
import { MATCH_VERSION, RULES } from "./match.js";
const KIND_INDEX = [
    "plain",
    "split",
    "burrow",
    "roll",
    "deposit"
];
function kindIndex(kind) {
    const i = KIND_INDEX.indexOf(kind);
    if (i < 0) throw new Error(`모르는 무기 kind: ${kind}`);
    return i;
}
export function ruleFingerprint() {
    const out = [];
    out.push(MATCH_VERSION, M.MAPGEN_VERSION);
    out.push(Wp.WEAPONS.length);
    for (const w of Wp.WEAPONS){
        out.push(w.id, kindIndex(w.kind), w.maxDamage, w.blastRadius, w.carveCells, w.ammo0 === null ? -1 : w.ammo0, w.price, w.splitCount ?? 0, w.splitSpread ?? 0, w.burrowCells ?? 0, w.rollCells ?? 0, w.depositCells ?? 0, w.depositMat ?? 0);
    }
    out.push(Wp.ITEMS.length);
    for (const item of Wp.ITEMS)out.push(item.id, item.price);
    out.push(M.PROVINCES.length);
    for (const p of M.PROVINCES)out.push(...p.bands, p.bedrockDepth);
    out.push(M.NOISE_SHIFT, M.SURFACE_BASE, M.SURFACE_AMP, M.BEDROCK_Y, M.PROVINCE_BLEND);
    out.push(M.SPAWN_MIN_GAP, M.SPAWN_MAX_RELIEF);
    out.push(RULES.rounds, RULES.roundTurnCap, RULES.startGold, RULES.goldPerDamage, RULES.goldPerKill, RULES.goldSurvive, RULES.goldLastPlaceBonus, RULES.killScore, RULES.damageScore, RULES.surviveScore, RULES.fuelCellsPerUnit, RULES.moveMaxStepUp, RULES.maxSettleSteps, RULES.connectivityMaxRounds);
    out.push(B.MAX_POWER, B.CFG.gravity, B.CFG.powerScale, B.CFG.windMax, B.CFG.windScaleQ8, B.CFG.dragQ16, B.CFG.maxFlightTicks, B.CFG.selfHitIgnore, B.CFG.barrelLen, B.CFG.fallSafePx, B.CFG.fallDamageNum, B.CFG.fallDamageShift, B.CFG.burialPermille, B.CFG.burialDamage, B.CFG.burialReliefCells);
    out.push(T.CFG.slideSandQ8, T.CFG.slideSoilQ8, T.CFG.slideScreeQ8, T.CFG.slideGateStatic ? 1 : 0, T.CFG.bothDirections ? 1 : 0);
    for (const material of [
        T.SAND,
        T.SOIL,
        T.SCREE,
        T.ROCK,
        T.BEDROCK
    ]){
        out.push(material, T.CFG.blastResistQ8[material] ?? -1);
    }
    return out;
}
export function ruleHash() {
    const values = ruleFingerprint();
    for(let i = 0; i < values.length; i++){
        if (!Number.isInteger(values[i])) {
            throw new Error(`규칙 지문 ${i}번이 정수가 아니다: ${values[i]}`);
        }
    }
    const packed = new Int32Array(values.length);
    for(let i = 0; i < values.length; i++)packed[i] = values[i] | 0;
    return hex8(fnv1a32(new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength)));
}
