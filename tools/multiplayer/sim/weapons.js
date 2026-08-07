// Generated from client/src/sim/weapons.ts. Do not edit.
import { hash32 } from "./intmath.js";
import { grid, W, H, EMPTY, BEDROCK, SOIL, CFG as TCFG, carveDeferred, deposit } from "./terrain.js";
import { CELL_SHIFT, CELL_SUBPX, continueShot, simulateShot } from "./ballistics.js";
export function shiftOf(r) {
    let s = 0;
    let v = r;
    while(v > 1){
        v >>= 1;
        s++;
    }
    if (1 << s !== r) throw new Error(`blastRadius 가 2의 거듭제곱이 아니다: ${r}`);
    return s;
}
function W_(o) {
    return {
        ...o,
        damageShift: shiftOf(o.blastRadius)
    };
}
export const WEAPONS = [
    W_({
        id: 0,
        name: "표준탄",
        kind: "plain",
        maxDamage: 45,
        blastRadius: 1024,
        carveCells: 28,
        ammo0: null,
        price: 0,
        desc: "작은 원형 구덩이. 무한"
    }),
    W_({
        id: 1,
        name: "파쇄탄",
        kind: "plain",
        maxDamage: 62,
        blastRadius: 2048,
        carveCells: 60,
        ammo0: 2,
        price: 700,
        desc: "큰 구덩이 + 넓은 붕괴 유발"
    }),
    W_({
        id: 2,
        name: "분열탄",
        kind: "split",
        maxDamage: 30,
        blastRadius: 512,
        carveCells: 16,
        splitCount: 5,
        splitSpread: 34,
        ammo0: 2,
        price: 850,
        desc: "정점에서 5발로 갈라져 산개"
    }),
    W_({
        id: 3,
        name: "굴착탄",
        kind: "burrow",
        maxDamage: 55,
        blastRadius: 1024,
        carveCells: 24,
        burrowCells: 46,
        ammo0: 2,
        price: 800,
        desc: "지면에 박힌 뒤 아래로 파고들어 폭발"
    }),
    W_({
        id: 4,
        name: "전복탄",
        kind: "roll",
        maxDamage: 50,
        blastRadius: 1024,
        carveCells: 26,
        rollCells: 140,
        ammo0: 2,
        price: 900,
        desc: "착탄 후 경사를 따라 굴러가서 폭발"
    }),
    W_({
        id: 5,
        name: "성형탄",
        kind: "plain",
        maxDamage: 95,
        blastRadius: 512,
        carveCells: 5,
        ammo0: 2,
        price: 950,
        desc: "피해 높고 구덩이는 아주 작다. 지형 보존"
    }),
    W_({
        id: 6,
        name: "적층탄",
        kind: "deposit",
        maxDamage: 0,
        blastRadius: 512,
        carveCells: 0,
        depositCells: 30,
        depositMat: SOIL,
        ammo0: 2,
        price: 650,
        desc: "폭발 대신 흙을 쌓는다. 유일한 지형 추가"
    }),
    W_({
        id: 7,
        name: "핵포탄",
        kind: "plain",
        maxDamage: 120,
        blastRadius: 4096,
        carveCells: 80,
        ammo0: 0,
        price: 4800,
        desc: "초기 0발. 전장을 뒤엎는 초대형 폭발"
    })
];
export const NUCLEAR_WEAPON_ID = 7;
export const ITEMS = [
    {
        id: 0,
        key: "shield",
        name: "차폐막",
        price: 600,
        desc: "1회 피격 무효"
    },
    {
        id: 1,
        key: "parachute",
        name: "낙하산",
        price: 400,
        desc: "낙하 피해 무효. 자동 발동"
    },
    {
        id: 2,
        key: "fuel",
        name: "연료",
        price: 300,
        desc: "턴당 좌우 이동"
    },
    {
        id: 3,
        key: "anemo",
        name: "측풍계",
        price: 500,
        desc: "다음 턴 바람과 돌풍을 예보"
    }
];
export function byId(id) {
    return WEAPONS[id] ?? WEAPONS[0];
}
function copyPts(s) {
    const out = [];
    for(let i = 0; i < s.n; i++)out.push({
        x: s.xs[i],
        y: s.ys[i]
    });
    return out;
}
function pushDet(dets, s, weapon) {
    if (s.hit === "void" || s.hit === "timeout") return;
    dets.push({
        x: s.hitX,
        y: s.hitY,
        weapon
    });
}
export function resolveShot(x0, y0, angle10, power, wind, shooterIdx, tanks, weapon) {
    const legs = [];
    const dets = [];
    const s = simulateShot(x0, y0, angle10, power, wind, shooterIdx, tanks, weapon.kind === "split");
    legs.push({
        pts: copyPts(s),
        kind: "main"
    });
    if (weapon.kind === "split" && s.apexReached) {
        const n = weapon.splitCount;
        const half = n - 1 >> 1;
        const ax = s.apexX, ay = s.apexY, avx = s.apexVx, avy = s.apexVy;
        for(let i = 0; i < n; i++){
            const dvx = (i - half) * weapon.splitSpread;
            const sub = continueShot(ax, ay, avx + dvx, avy, wind, shooterIdx, tanks);
            legs.push({
                pts: copyPts(sub),
                kind: "split"
            });
            pushDet(dets, sub, weapon);
        }
        return {
            legs,
            dets
        };
    }
    if (s.hit === "void" || s.hit === "timeout") return {
        legs,
        dets
    };
    if (weapon.kind === "burrow") {
        const bx = s.hitX >> CELL_SHIFT;
        let by = s.hitY >> CELL_SHIFT;
        const tail = [];
        for(let d = 0; d < weapon.burrowCells; d++){
            const ny = by + 1;
            if (ny >= H) break;
            if (grid[ny * W + bx] === BEDROCK) break;
            by = ny;
            tail.push({
                x: bx * CELL_SUBPX + (CELL_SUBPX >> 1),
                y: by * CELL_SUBPX + (CELL_SUBPX >> 1)
            });
        }
        if (tail.length) legs.push({
            pts: tail,
            kind: "burrow"
        });
        dets.push({
            x: bx * CELL_SUBPX + (CELL_SUBPX >> 1),
            y: by * CELL_SUBPX + (CELL_SUBPX >> 1),
            weapon
        });
        return {
            legs,
            dets
        };
    }
    if (weapon.kind === "roll") {
        let rx = s.hitX >> CELL_SHIFT;
        let ry = s.hitY >> CELL_SHIFT;
        const trail = [];
        for(let k = 0; k < weapon.rollCells; k++){
            if (ry + 1 < H && grid[(ry + 1) * W + rx] === EMPTY) {
                ry++;
            } else {
                const dl = dropDepth(rx - 1, ry);
                const dr = dropDepth(rx + 1, ry);
                if (dl === 0 && dr === 0) break;
                let goLeft;
                if (dl > dr) goLeft = true;
                else if (dr > dl) goLeft = false;
                else goLeft = (hash32(TCFG.seed, rx, ry, k) & 1) === 0;
                rx += goLeft ? -1 : 1;
                if (rx < 0 || rx >= W) break;
            }
            trail.push({
                x: rx * CELL_SUBPX + (CELL_SUBPX >> 1),
                y: ry * CELL_SUBPX + (CELL_SUBPX >> 1)
            });
        }
        if (trail.length) legs.push({
            pts: trail,
            kind: "roll"
        });
        dets.push({
            x: rx * CELL_SUBPX + (CELL_SUBPX >> 1),
            y: ry * CELL_SUBPX + (CELL_SUBPX >> 1),
            weapon
        });
        return {
            legs,
            dets
        };
    }
    dets.push({
        x: s.hitX,
        y: s.hitY,
        weapon
    });
    return {
        legs,
        dets
    };
}
export function dropDepth(x, y) {
    if (x < 0 || x >= W || y + 1 >= H) return 0;
    if (grid[y * W + x] !== EMPTY) return 0;
    let d = 0;
    while(y + 1 + d < H && grid[(y + 1 + d) * W + x] === EMPTY && d < 8)d++;
    return d + 1;
}
export function applyDetonation(det) {
    const w = det.weapon;
    let cx = det.x >> CELL_SHIFT;
    let cy = det.y >> CELL_SHIFT;
    if (cx < 0) cx = 0;
    if (cx > W - 1) cx = W - 1;
    if (cy < 0) cy = 0;
    if (cy > H - 1) cy = H - 1;
    if (w.kind === "deposit") {
        const filled = deposit(cx, cy, w.depositCells, w.depositMat);
        return {
            removed: 0,
            conv: 0,
            filled
        };
    }
    const r = carveDeferred(cx, cy, w.carveCells);
    return {
        removed: r.removed,
        conv: 0,
        filled: 0
    };
}
