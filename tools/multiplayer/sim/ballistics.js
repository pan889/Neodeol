// Generated from client/src/sim/ballistics.ts. Do not edit.
import { floorDiv, isqrt, iabs, clampInt } from "./intmath.js";
import { SIN, COS } from "./trig.js";
import { grid, W, H, EMPTY, BEDROCK } from "./terrain.js";
export const SUBPX = 16;
export const CELL_SUBPX = 32;
export const CELL_SHIFT = 5;
export const PX_SHIFT = 4;
export const MAP_W_SUB = W * CELL_SUBPX;
export const MAP_H_SUB = H * CELL_SUBPX;
export const TANK_W = 384;
export const TANK_H = 256;
export const MAX_HP = 100;
export const MAX_POWER = 1500;
export const TANK_TILT_MAX10 = 140;
const TANK_TILT_SAMPLE = TANK_W * 7 >> 4;
export const CFG = {
    gravity: 12,
    powerScale: 624,
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
    burialReliefCells: 1
};
export function solidAtSub(xs, ys) {
    if (ys < 0) return false;
    if (xs < 0 || xs >= MAP_W_SUB) return false;
    if (ys >= MAP_H_SUB) return false;
    const cx = xs >> CELL_SHIFT;
    const cy = ys >> CELL_SHIFT;
    return grid[cy * W + cx] !== EMPTY;
}
const pathX = new Int32Array(2048);
const pathY = new Int32Array(2048);
export function simulateShot(x0, y0, angle10, power, wind, shooterIdx, tanks, stopAtApex) {
    const v0 = power * CFG.powerScale >> 10;
    const vx = v0 * COS(angle10) >> 12;
    const vy = -(v0 * SIN(angle10) >> 12);
    return integrate(x0, y0, vx, vy, wind, shooterIdx, tanks, stopAtApex);
}
export function continueShot(x0, y0, vx, vy, wind, shooterIdx, tanks) {
    return integrate(x0, y0, vx, vy, wind, shooterIdx, tanks, false);
}
function integrate(x0, y0, vx0, vy0, wind, shooterIdx, tanks, stopAtApex) {
    let vx = vx0;
    let vy = vy0;
    let x = x0;
    let y = y0;
    let n = 0;
    let hit = "timeout";
    let hitTank = -1;
    let apexReached = false;
    let apexX = 0;
    let apexY = 0;
    let apexVx = 0;
    let apexVy = 0;
    for(let t = 0; t < CFG.maxFlightTicks; t++){
        vx += wind;
        vy += CFG.gravity;
        if (CFG.dragQ16 !== 0) vx -= vx * CFG.dragQ16 >> 16;
        const L = iabs(vx) + iabs(vy);
        const steps = (L >> CELL_SHIFT) + 1;
        const sx = x;
        const sy = y;
        let done = false;
        for(let k = 1; k <= steps; k++){
            x = sx + floorDiv(vx * k, steps);
            y = sy + floorDiv(vy * k, steps);
            if (y >= MAP_H_SUB) {
                hit = "void";
                done = true;
                break;
            }
            if (solidAtSub(x, y)) {
                hit = "terrain";
                done = true;
                break;
            }
            if (tanks !== null) {
                for(let i = 0; i < tanks.length; i++){
                    const tk = tanks[i];
                    if (!tk.alive) continue;
                    if (i === shooterIdx && t < CFG.selfHitIgnore) continue;
                    if (x >= tk.x - (TANK_W >> 1) && x <= tk.x + (TANK_W >> 1) && y >= tk.y - TANK_H && y <= tk.y) {
                        hit = "tank";
                        hitTank = i;
                        done = true;
                        break;
                    }
                }
                if (done) break;
            }
        }
        if (n < pathX.length) {
            pathX[n] = x;
            pathY[n] = y;
            n++;
        }
        if (done) break;
        if (stopAtApex && !apexReached && vy >= 0) {
            apexReached = true;
            apexX = x;
            apexY = y;
            apexVx = vx;
            apexVy = vy;
            break;
        }
    }
    return {
        xs: pathX,
        ys: pathY,
        n,
        hit,
        hitX: x,
        hitY: y,
        hitTank,
        apexReached,
        apexX,
        apexY,
        apexVx,
        apexVy
    };
}
export function flatRangePx(angle10, power, wind) {
    const v0 = power * CFG.powerScale >> 10;
    let vx = v0 * COS(angle10) >> 12;
    let vy = -(v0 * SIN(angle10) >> 12);
    let x = 0;
    let y = 0;
    for(let t = 0; t < CFG.maxFlightTicks; t++){
        vx += wind;
        vy += CFG.gravity;
        if (CFG.dragQ16 !== 0) vx -= vx * CFG.dragQ16 >> 16;
        const L = iabs(vx) + iabs(vy);
        const steps = (L >> CELL_SHIFT) + 1;
        const sx = x;
        const sy = y;
        for(let k = 1; k <= steps; k++){
            x = sx + floorDiv(vx * k, steps);
            y = sy + floorDiv(vy * k, steps);
            if (y >= 0 && vy > 0) return x >> PX_SHIFT;
        }
    }
    return x >> PX_SHIFT;
}
function supportYAtTank(tank, xSub) {
    const cx = clampInt(xSub >> CELL_SHIFT, 0, W - 1);
    const foot = clampInt(tank.y >> CELL_SHIFT, 0, H - 1);
    const from = foot > 8 ? foot - 8 : 0;
    const to = foot + 16 < H ? foot + 16 : H - 1;
    for(let y = from; y <= to; y++)if (grid[y * W + cx] !== EMPTY) return y;
    return foot;
}
export function tankTilt10(tank) {
    const leftX = clampInt(tank.x - TANK_TILT_SAMPLE >> CELL_SHIFT, 0, W - 1);
    const rightX = clampInt(tank.x + TANK_TILT_SAMPLE >> CELL_SHIFT, 0, W - 1);
    const run = rightX - leftX;
    if (run <= 0) return 0;
    const rise = supportYAtTank(tank, tank.x + TANK_TILT_SAMPLE) - supportYAtTank(tank, tank.x - TANK_TILT_SAMPLE);
    if (rise === 0) return 0;
    const magnitude = iabs(rise);
    let bestAngle = 0;
    let bestError = 0x7fffffff;
    for(let angle10 = 0; angle10 <= TANK_TILT_MAX10; angle10++){
        const error = iabs(magnitude * COS(angle10) - run * SIN(angle10));
        if (error < bestError) {
            bestError = error;
            bestAngle = angle10;
        }
    }
    return rise < 0 ? -bestAngle : bestAngle;
}
export function effectiveAngle10(tank, angle10) {
    return clampInt(angle10 - tankTilt10(tank), 0, 1800);
}
export function shotPose(tank, angle10) {
    const tilt10 = tankTilt10(tank);
    const absTilt10 = iabs(tilt10);
    const tiltSin = tilt10 < 0 ? -SIN(absTilt10) : SIN(absTilt10);
    const anchorX = tank.x + (TANK_H * tiltSin >> 12);
    const anchorY = tank.y - (TANK_H * COS(absTilt10) >> 12);
    const shotAngle10 = clampInt(angle10 - tilt10, 0, 1800);
    return {
        x: anchorX + (CFG.barrelLen * COS(shotAngle10) >> 12),
        y: anchorY - (CFG.barrelLen * SIN(shotAngle10) >> 12),
        angle10: shotAngle10,
        tilt10
    };
}
export function muzzle(tank, angle10) {
    const pose = shotPose(tank, angle10);
    return {
        x: pose.x,
        y: pose.y
    };
}
export function computeDamage(cx, cy, weapon, tanks) {
    const out = [];
    for(let i = 0; i < tanks.length; i++){
        const tk = tanks[i];
        if (!tk.alive) continue;
        const dx = tk.x - cx;
        const dy = tk.y - (TANK_H >> 1) - cy;
        const dist = isqrt(dx * dx + dy * dy);
        if (dist >= weapon.blastRadius) continue;
        out.push({
            idx: i,
            dmg: weapon.maxDamage * (weapon.blastRadius - dist) >> weapon.damageShift,
            dist
        });
    }
    return out;
}
export function reseatTank(tank) {
    const startY = tank.y;
    let guard = 0;
    while(guard++ < H * 2){
        if (tank.y >= MAP_H_SUB) return -1;
        if (supported(tank)) break;
        tank.y += CELL_SUBPX;
    }
    let relief = 0;
    while(relief < CFG.burialReliefCells && buriedFraction(tank) >= CFG.burialPermille){
        relief++;
        tank.y -= CELL_SUBPX;
    }
    const fallPx = tank.y - startY >> PX_SHIFT;
    return fallPx > 0 ? fallPx : 0;
}
export function supported(tank) {
    const halfW = TANK_W >> 1;
    const footY = tank.y;
    if (footY >= MAP_H_SUB) return false;
    for(let xs = tank.x - halfW; xs <= tank.x + halfW; xs += CELL_SUBPX){
        if (solidAtSub(xs, footY)) return true;
    }
    return false;
}
export function buriedFraction(tank) {
    const halfW = TANK_W >> 1;
    let filled = 0;
    let total = 0;
    for(let ys = tank.y - TANK_H; ys < tank.y; ys += CELL_SUBPX){
        for(let xs = tank.x - halfW; xs <= tank.x + halfW; xs += CELL_SUBPX){
            total++;
            if (solidAtSub(xs, ys)) filled++;
        }
    }
    return total === 0 ? 0 : floorDiv(filled * 1000, total);
}
export function fallDamage(fallPx) {
    if (fallPx <= CFG.fallSafePx) return 0;
    return (fallPx - CFG.fallSafePx) * CFG.fallDamageNum >> CFG.fallDamageShift;
}
export function surfaceSubY(xSub) {
    const cx = clampInt(xSub >> CELL_SHIFT, 0, W - 1);
    for(let cy = 0; cy < H; cy++){
        if (grid[cy * W + cx] !== EMPTY) return cy * CELL_SUBPX;
    }
    return MAP_H_SUB;
}
export function makeTank(slot, xSub, name) {
    return {
        slot,
        name,
        x: xSub,
        y: surfaceSubY(xSub),
        hp: MAX_HP,
        alive: true,
        buried: false,
        angle10: slot % 2 === 0 ? 450 : 1350,
        power: 600
    };
}
export function isBedrockAt(cx, cy) {
    return grid[cy * W + cx] === BEDROCK;
}
