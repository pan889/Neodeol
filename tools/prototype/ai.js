/* ═══════════════════════════════════════════════════════════════════════════
   AI — 로컬 핫시트의 컴퓨터 플레이어

   **시뮬레이션 규칙이 아니라 입력 생성기다.** 사람이 조준 UI 로 만드는 것과 같은
   `intent`(각도·파워·무기·이동)를 만들 뿐이고, 그 다음은 전부 `sim/` 이 정한다.
   그래서 규칙 지문(`sim/rules`)에도 들어가지 않는다 — AI 가 달라도 같은 방에서 논다.

   물리·규칙은 **생성 사본**(`../multiplayer/sim/`)을 쓴다. 예전에는 `tools/prototype/`
   안에 sim.js · weapons.js · match.js 로 손으로 쓴 사본이 따로 있었고, 차체 경사 로직이
   그 탓에 4벌이었다. 대조 검사가 없어 프로토타입만 옛 규칙으로 도는 것을 아무도 못 잡았다.
   ═══════════════════════════════════════════════════════════════════════════ */
import * as T from "../multiplayer/sim/terrain.js";
import * as P from "../multiplayer/sim/ballistics.js";
import * as Wp from "../multiplayer/sim/weapons.js";
import * as M from "../multiplayer/sim/match.js";
import { hash32 } from "../multiplayer/sim/intmath.js";

const CELL = P.CELL_SUBPX;

function aiIntent(players, me, wind, turnNo, seed, difficulty) {
  var target = pickTarget(players, me);
  if (!target) return { angle10: 450, power: 500, weaponId: 0, moveDx: 0, useShield: false };

  var toRight = target.x > me.x;
  var best = null;

  /* 각도를 훑고, 각 각도에서 파워를 이분 탐색한다. 전부 정수. */
  var angles = toRight ? [300, 400, 450, 500, 550, 600, 700]
                      : [1500, 1400, 1350, 1300, 1250, 1200, 1100];
  for (var ai = 0; ai < angles.length; ai++) {
    var a = angles[ai];
    var lo = 100, hi = 1000;
    for (var it = 0; it < 12; it++) {
      var mid = (lo + hi) >> 1;
      var land = simLanding(me, a, mid, wind, players);
      if (land == null) { lo = mid + 1; continue; }
      var err = land - target.x;
      var absErr = err < 0 ? -err : err;
      if (!best || absErr < best.err) best = { angle10: a, power: mid, err: absErr };
      if (absErr <= 8) break;
      /* 오른쪽으로 쏠 때 짧으면 파워를 올린다. 왼쪽은 부호가 반대다 */
      var tooShort = toRight ? (err < 0) : (err > 0);
      if (tooShort) lo = mid + 1; else hi = mid - 1;
      if (lo > hi) break;
    }
    if (best && best.err <= 8) break;
  }
  if (!best) best = { angle10: toRight ? 450 : 1350, power: 700, err: 9999 };

  /* 난이도에 따른 조준 오차. 결정론적 해시로 만든다 */
  var h = hash32(seed ^ 0x51DE, me.slot, turnNo, 0);
  var spread = difficulty === "hard" ? 4 : (difficulty === "normal" ? 14 : 40);
  var jitterA = ((h & 0xFF) % (spread * 2 + 1)) - spread;
  var jitterP = (((h >>> 8) & 0xFF) % (spread * 2 + 1)) - spread;

  var wid = pickWeapon(me, target, h);

  return {
    angle10: clamp(best.angle10 + jitterA, 0, 1800),
    power: clamp(best.power + jitterP, 0, 1000),
    weaponId: wid,
    moveDx: 0,
    useShield: me.items.shield > 0 && me.hp <= 35,
  };
}

/* 그 조준으로 쏘면 x 몇에 떨어지는가 (subpx). 못 맞으면 null */
function simLanding(me, angle10, power, wind, players) {
  var pose = P.shotPose(me, angle10);
  var s = P.simulateShot(pose.x, pose.y, pose.angle10, power, wind, me.slot, players, null);
  if (s.hit === "void" || s.hit === "timeout") return null;
  return s.hitX;
}

function pickTarget(players, me) {
  var best = null;
  for (var i = 0; i < players.length; i++) {
    var p = players[i];
    if (!p.alive || p.slot === me.slot) continue;
    /* HP 가 낮은 쪽을 노린다. 동률이면 가까운 쪽 */
    if (!best) { best = p; continue; }
    if (p.hp < best.hp) best = p;
    else if (p.hp === best.hp) {
      var dNew = Math.abs(p.x - me.x), dOld = Math.abs(best.x - me.x);
      if (dNew < dOld) best = p;
    }
  }
  return best;
}

/* 무기 선택 — 탄약이 있는 것 중에서 상황에 맞는 것을 고른다 */
function pickWeapon(me, target, h) {
  var cands = [];
  if (target.hp <= 40 && M.ammoOf(me, 5) > 0) cands.push(5);        // 성형탄으로 마무리
  if (M.ammoOf(me, 1) > 0) cands.push(1);                           // 파쇄탄
  if (M.ammoOf(me, 4) > 0) cands.push(4);                           // 전복탄
  if (M.ammoOf(me, 2) > 0) cands.push(2);                           // 분열탄
  if (M.ammoOf(me, 3) > 0) cands.push(3);                           // 굴착탄
  if (!cands.length) return 0;
  /* 절반은 표준탄을 쓴다 — 아껴 쓰는 인상을 준다 */
  if (((h >>> 16) & 1) === 0) return 0;
  return cands[((h >>> 17) % cands.length)];
}

/* AI 상점 — 싼 것부터 고르게 산다 */
function aiShop(pl, seed, roundNo) {
  var h = hash32(seed ^ 0x5401, pl.slot, roundNo, 0);
  var order = [1, 4, 5, 2, 3, 6];
  var bought = [];
  for (var pass = 0; pass < 3; pass++) {
    for (var i = 0; i < order.length; i++) {
      var wid = order[(i + (h >>> (pass * 3))) % order.length];
      if (M.buyWeapon(pl, wid)) bought.push(Wp.byId(wid).name);
    }
  }
  if (pl.items.parachute === 0) { if (M.buyItem(pl, "parachute")) bought.push("낙하산"); }
  if (pl.items.shield === 0) { if (M.buyItem(pl, "shield")) bought.push("차폐막"); }
  return bought;
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

export { aiIntent, aiShop };
