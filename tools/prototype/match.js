/* ═══════════════════════════════════════════════════════════════════════════
   Talus — 매치 진행 · 경제 · AI  (docs/game-design.md §3 §4 §7)

   [SIM] 구획. **정수 연산만.** float / Math.random / 시계 금지.
   AI 도 여기 있다 — lockstep 에서 AI 는 결정론적이어야 하므로 `sim` 의 일부다.
   `Math.random()` 을 쓰면 서버와 클라의 AI 가 다르게 쏜다.

   ───────────────────────────────────────────────────────────────────────────
   확정 규칙을 따른 것

   · 완전 순차 턴 (§4.1). 활성 슬롯 한 명의 intent 만 해결한다
   · 한 발이 만든 다중 폭발은 계획 순서로 carve → 연결성 1회 → 정착 (terrain.md §8)
   · 피해는 카빙 **전** 위치 기준으로 전부 계산한 뒤 한꺼번에 적용 (simulation.md §5.2)
   · 상점은 라운드 사이에만 (§7)

   ───────────────────────────────────────────────────────────────────────────
   잠정으로 정한 것 — 값은 밸런싱, 형태는 `decisions.md` 추천안을 따랐다

   · 점수 = 킬 × KILL_SCORE + 총 피해 × DAMAGE_SCORE + 생존 × SURVIVE_SCORE   (B7)
   · 라운드 종료 = 생존 ≤ 1. 0 명이면 그 라운드 생존 점수 없이 무승부         (B7)
   · 라운드 턴 상한 ROUND_TURN_CAP. 도달 시 HP 합이 높은 쪽 승               (B12)
   · 매몰은 매 턴 재평가한다 — 위가 비면 자동 해제                            (B13)
   · 낙하·매몰 피해는 그 붕괴를 유발한 폭발의 소유자에게 귀속                 (C10)
   · 꼴찌 보정 — 하위 순위에게 자금 보너스 (§7)
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  "use strict";
  var T = root.TalusSim, P = root.TalusPhys, Wp = root.TalusWeapons;
  if (!T || !P || !Wp) throw new Error("automaton.js, sim.js, weapons.js 를 먼저 로드해야 한다");

  var CELL = P.CELL_SUBPX, CSH = P.CELL_SHIFT;

  /* ── 규칙 상수. 전부 잠정값 ─────────────────────────────────────────── */
  var RULES = {
    rounds: 5,                    // §3
    roundTurnCap: 40,             // B12 — 그래도 안 끝나는 경우의 상한
    startGold: 1500,              // §7
    goldPerDamage: 8,
    goldPerKill: 400,
    goldSurvive: 300,
    goldLastPlaceBonus: 250,      // 꼴찌 보정 (§7)
    killScore: 100,               // B7
    damageScore: 1,
    surviveScore: 50,
    fuelCellsPerUnit: 14,         // 연료 1개당 이동 셀 수
    moveMaxStepUp: 6,             // 이동 시 넘을 수 있는 최대 높이차 (셀)
  };

  /* ══ 플레이어 ═════════════════════════════════════════════════════════ */
  function makePlayer(slot, name, isAI, xSub) {
    var tk = P.makeTank(slot, xSub, name);
    tk.isAI = isAI;
    tk.gold = RULES.startGold;
    tk.weaponId = 0;
    tk.ammo = {};
    tk.items = { shield: 0, parachute: 0, fuel: 0, anemo: 0 };
    for (var i = 0; i < Wp.WEAPONS.length; i++) {
      var w = Wp.WEAPONS[i];
      if (w.ammo0 !== null) tk.ammo[w.id] = w.ammo0;
    }
    tk.score = 0; tk.kills = 0; tk.damageDone = 0;
    tk.intent = null;                       // { angle10, power, weaponId, moveDx, useShield }
    tk.shieldUp = false;
    return tk;
  }

  function ammoOf(pl, wid) {
    var w = Wp.byId(wid);
    return w.ammo0 === null ? Infinity : (pl.ammo[wid] || 0);
  }
  function canFire(pl, wid) { return ammoOf(pl, wid) > 0; }
  function spendAmmo(pl, wid) {
    var w = Wp.byId(wid);
    if (w.ammo0 !== null) pl.ammo[wid] = Math.max(0, (pl.ammo[wid] || 0) - 1);
  }
  /* 탄약이 없으면 표준탄으로 폴백한다 (netcode.md §5.3 의 "직전 턴 값" 폴백과 같은 취지) */
  function effectiveWeapon(pl, wid) {
    return canFire(pl, wid) ? Wp.byId(wid) : Wp.byId(0);
  }

  /* ══ 이동 (§6.2 연료) ═════════════════════════════════════════════════
     PHASE_RESOLVE 직전에 활성 플레이어에게 적용한다 (decisions.md B4).
     지형 경사에 제한받는다 — 높이차가 moveMaxStepUp 을 넘으면 못 올라간다. */
  function applyMove(pl, dxCells) {
    if (!pl.alive || !dxCells) return 0;
    var budget = pl.items.fuel * RULES.fuelCellsPerUnit;
    var want = dxCells < 0 ? -dxCells : dxCells;
    if (want > budget) want = budget;
    var dir = dxCells < 0 ? -1 : 1;
    var moved = 0;
    for (var i = 0; i < want; i++) {
      var nx = pl.x + dir * CELL;
      if (nx < 0 || nx >= P.MAP_W_SUB) break;
      var curTop = P.surfaceSubY(pl.x), nextTop = P.surfaceSubY(nx);
      /* 위로 오르는 높이차만 제한한다. 내려가는 건 자유낙하로 처리된다 */
      if ((curTop - nextTop) > RULES.moveMaxStepUp * CELL) break;
      pl.x = nx;
      moved++;
    }
    if (moved > 0) {
      var used = Math.ceil(moved / RULES.fuelCellsPerUnit);
      pl.items.fuel = Math.max(0, pl.items.fuel - used);
      P.reseatTank(pl);
    }
    return moved;
  }

  /* ══ 턴 해결 ══════════════════════════════════════════════════════════
     반환: { legs, dets, events } — 렌더러가 legs 를 재생하고,
     재생이 끝나면 applyDetonations() 를 부른다. */
  function resolveTurn(players, wind) {
    var legs = [], dets = [], events = [];

    /* 1) 활성 intent 의 이동을 먼저 적용한다 */
    for (var i = 0; i < players.length; i++) {
      var pl = players[i];
      if (!pl.alive || !pl.intent) continue;
      var mv = applyMove(pl, pl.intent.moveDx | 0);
      if (mv) events.push({ t: "move", slot: pl.slot, cells: mv });
      pl.shieldUp = !!pl.intent.useShield && pl.items.shield > 0;
      if (pl.shieldUp) { pl.items.shield--; events.push({ t: "shield", slot: pl.slot }); }
    }

    /* 2) intent 가 있는 활성 플레이어 한 명을 발사한다 */
    for (var j = 0; j < players.length; j++) {
      var p2 = players[j];
      if (!p2.alive || !p2.intent) continue;
      var w = effectiveWeapon(p2, p2.intent.weaponId);
      spendAmmo(p2, w.id);
      var pose = P.shotPose(p2, p2.intent.angle10);
      var r = Wp.resolveShot(pose.x, pose.y, pose.angle10, p2.intent.power,
                             wind, j, players, w);
      for (var k = 0; k < r.legs.length; k++) {
        r.legs[k].slot = p2.slot;
        legs.push(r.legs[k]);
      }
      for (var d = 0; d < r.dets.length; d++) {
        r.dets[d].owner = p2.slot;
        dets.push(r.dets[d]);
      }
      events.push({ t: "fire", slot: p2.slot, weapon: w.name,
                    angle10: p2.intent.angle10, power: p2.intent.power });
    }
    return { legs: legs, dets: dets, events: events };
  }

  /* ══ 폭발 적용 ════════════════════════════════════════════════════════
     피해를 **전부 먼저 계산**하고 그 뒤에 카빙한다 (simulation.md §5.2).
     순차 적용하면 슬롯 1번 폭발로 밀린 탱크가 2번을 피해 슬롯 순서가 유불리를 만든다. */
  function applyDetonations(players, dets) {
    var events = [];
    var pending = [];                        // {slot, dmg, owner}

    for (var i = 0; i < dets.length; i++) {
      var det = dets[i];
      if (det.weapon.maxDamage <= 0) continue;
      var hits = P.computeDamage(det.x, det.y, det.weapon, players);
      for (var h = 0; h < hits.length; h++) {
        pending.push({ idx: hits[h].idx, dmg: hits[h].dmg, dist: hits[h].dist, owner: det.owner });
      }
    }

    /* 한 발이 만든 자탄·적층을 계획 순서대로 적용한다 */
    var removed = 0, filled = 0;
    for (var j = 0; j < dets.length; j++) {
      var a = Wp.applyDetonation(dets[j]);
      removed += a.removed; filled += a.filled;
    }
    /* 한 발의 다중 폭발을 전부 적용한 뒤 연결성을 정확히 한 번 검사한다. */
    var conv = T.connectivity();
    if (conv > 0) events.push({ t: "conv", cells: conv });

    /* 피해 합산 적용 */
    for (var k = 0; k < pending.length; k++) {
      var pd = pending[k], pl = players[pd.idx];
      if (!pl.alive) continue;
      if (pl.shieldUp) {
        pl.shieldUp = false;
        events.push({ t: "blocked", slot: pl.slot });
        continue;                            // 1회 피격 무효 (§6.2)
      }
      pl.hp -= pd.dmg;
      creditDamage(players, pd.owner, pd.dmg);
      events.push({ t: "damage", slot: pl.slot, dmg: pd.dmg, by: pd.owner,
                    distPx: pd.dist >> 4 });
    }
    return { events: events, removed: removed, filled: filled, conv: conv };
  }

  function creditDamage(players, ownerSlot, dmg) {
    if (ownerSlot == null) return;
    for (var i = 0; i < players.length; i++) {
      if (players[i].slot === ownerSlot) {
        players[i].damageDone += dmg;
        players[i].gold += dmg * RULES.goldPerDamage;
        return;
      }
    }
  }

  /* ══ 정산 — 탱크 재배치, 낙하·매몰 피해, 사망 판정 (simulation.md §6.1) ══
     정착이 **완전히** 끝난 뒤에 한 번만 부른다 (연결성 재검사 루프까지 끝난 뒤).
     lastBlastOwner: 이번 턴 붕괴를 유발한 폭발의 소유자 (C10 귀속) */
  function applyPhase(players, lastBlastOwner) {
    var events = [];
    for (var i = 0; i < players.length; i++) {
      var pl = players[i];
      if (!pl.alive) continue;

      var fall = P.reseatTank(pl);
      if (fall < 0) {
        pl.hp = 0;
        events.push({ t: "outofmap", slot: pl.slot });
      } else if (fall > 0) {
        var fd = P.fallDamage(fall);
        if (fd > 0 && pl.items.parachute > 0) {
          pl.items.parachute--;
          events.push({ t: "parachute", slot: pl.slot, fallPx: fall });
        } else if (fd > 0) {
          pl.hp -= fd;
          creditDamage(players, lastBlastOwner, fd);
          events.push({ t: "falldamage", slot: pl.slot, fallPx: fall, dmg: fd });
        }
      }

      /* 매몰은 매 턴 재평가한다 — 위가 비면 자동 해제 (B13) */
      var bf = P.buriedFraction(pl);
      var wasBuried = pl.buried;
      pl.buried = bf >= P.CFG.burialPermille;
      if (pl.buried) {
        pl.hp -= P.CFG.burialDamage;
        creditDamage(players, lastBlastOwner, P.CFG.burialDamage);
        events.push({ t: "buried", slot: pl.slot, pct: (bf / 10) | 0, dmg: P.CFG.burialDamage });
      } else if (wasBuried) {
        events.push({ t: "unburied", slot: pl.slot });
      }

      if (pl.hp <= 0) {
        pl.hp = 0; pl.alive = false;
        events.push({ t: "dead", slot: pl.slot });
        creditKill(players, lastBlastOwner, pl.slot);
      }
    }
    return events;
  }

  function creditKill(players, ownerSlot, victimSlot) {
    if (ownerSlot == null || ownerSlot === victimSlot) return;
    for (var i = 0; i < players.length; i++) {
      if (players[i].slot === ownerSlot) {
        players[i].kills++;
        players[i].gold += RULES.goldPerKill;
        return;
      }
    }
  }

  /* ══ 라운드 종료 판정 (B7 · B12) ══════════════════════════════════════ */
  function roundOutcome(players, roundTurn) {
    var alive = players.filter(function (p) { return p.alive; });
    if (alive.length <= 1) {
      return { over: true, reason: alive.length === 1 ? "last" : "wipe",
               winner: alive.length === 1 ? alive[0].slot : null };
    }
    if (roundTurn >= RULES.roundTurnCap) {
      /* B12 — 사거리 밖에서 서로 못 맞히는 교착. HP 합이 높은 쪽 승 */
      var best = null;
      for (var i = 0; i < alive.length; i++) if (!best || alive[i].hp > best.hp) best = alive[i];
      var tied = alive.filter(function (p) { return p.hp === best.hp; }).length > 1;
      return { over: true, reason: "turncap", winner: tied ? null : best.slot };
    }
    return { over: false };
  }

  /* 라운드 점수·자금 정산 */
  function closeRound(players, outcome) {
    var events = [];
    for (var i = 0; i < players.length; i++) {
      var pl = players[i];
      pl.score += pl.kills * RULES.killScore + pl.damageDone * RULES.damageScore;
      if (pl.alive && outcome.reason !== "wipe") {
        pl.score += RULES.surviveScore;
        pl.gold += RULES.goldSurvive;
        events.push({ t: "survive", slot: pl.slot });
      }
      pl.kills = 0; pl.damageDone = 0;
    }
    /* 꼴찌 보정 (§7) — 최하위에게 자금 보너스. 격차가 벌어져 이탈하는 것을 막는다 */
    var sorted = players.slice().sort(function (a, b) { return a.score - b.score; });
    for (var k = 0; k < sorted.length; k++) {
      var bonus = (sorted.length - 1 - k) * RULES.goldLastPlaceBonus;
      if (bonus > 0) { sorted[k].gold += bonus; }
    }
    return events;
  }

  /* 다음 라운드 준비 — 지형은 유지하고 탱크만 부활시킨다 (B6 추천안) */
  function beginRound(players, spawnXs) {
    for (var i = 0; i < players.length; i++) {
      var pl = players[i];
      pl.hp = P.MAX_HP; pl.alive = true; pl.buried = false; pl.shieldUp = false;
      pl.intent = null;
      if (spawnXs && spawnXs[i] != null) pl.x = spawnXs[i];
      pl.y = P.surfaceSubY(pl.x);
      P.reseatTank(pl);
    }
  }

  /* ══ 상점 (§7) ════════════════════════════════════════════════════════ */
  function buyWeapon(pl, wid) {
    var w = Wp.byId(wid);
    if (w.ammo0 === null || pl.gold < w.price) return false;
    pl.gold -= w.price;
    pl.ammo[wid] = (pl.ammo[wid] || 0) + 1;
    return true;
  }
  function buyItem(pl, key) {
    for (var i = 0; i < Wp.ITEMS.length; i++) {
      var it = Wp.ITEMS[i];
      if (it.key !== key) continue;
      if (pl.gold < it.price) return false;
      pl.gold -= it.price;
      pl.items[key]++;
      return true;
    }
    return false;
  }

  /* ══════════════════════════════════════════════════════════════════════
     AI — 결정론적이어야 한다

     `Math.random()` 을 쓰면 서버와 클라의 AI 가 다르게 쏘고 그 순간 lockstep 이 깨진다.
     그래서 난수는 전부 `terrain.md` §7.1 의 `hash32(seed, slot, turnNo, 0)` 로 만든다.

     조준은 **실제 탄도를 반복 호출해** 찾는다 (해석해를 쓰지 않는다). 이유:
     바람·지형·자기 포신 위치가 전부 얽혀 있어 해석해가 실제 착탄점과 어긋난다.
     탐색 자체가 정수 연산이므로 결정론이 유지된다.
     ══════════════════════════════════════════════════════════════════════ */
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
    var h = T.hash32(seed ^ 0x51DE, me.slot, turnNo, 0);
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
    if (target.hp <= 40 && ammoOf(me, 5) > 0) cands.push(5);        // 성형탄으로 마무리
    if (ammoOf(me, 1) > 0) cands.push(1);                           // 파쇄탄
    if (ammoOf(me, 4) > 0) cands.push(4);                           // 전복탄
    if (ammoOf(me, 2) > 0) cands.push(2);                           // 분열탄
    if (ammoOf(me, 3) > 0) cands.push(3);                           // 굴착탄
    if (!cands.length) return 0;
    /* 절반은 표준탄을 쓴다 — 아껴 쓰는 인상을 준다 */
    if (((h >>> 16) & 1) === 0) return 0;
    return cands[((h >>> 17) % cands.length)];
  }

  /* AI 상점 — 싼 것부터 고르게 산다 */
  function aiShop(pl, seed, roundNo) {
    var h = T.hash32(seed ^ 0x5401, pl.slot, roundNo, 0);
    var order = [1, 4, 5, 2, 3, 6];
    var bought = [];
    for (var pass = 0; pass < 3; pass++) {
      for (var i = 0; i < order.length; i++) {
        var wid = order[(i + (h >>> (pass * 3))) % order.length];
        if (buyWeapon(pl, wid)) bought.push(Wp.byId(wid).name);
      }
    }
    if (pl.items.parachute === 0) { if (buyItem(pl, "parachute")) bought.push("낙하산"); }
    if (pl.items.shield === 0) { if (buyItem(pl, "shield")) bought.push("차폐막"); }
    return bought;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  root.TalusMatch = {
    RULES: RULES,
    makePlayer: makePlayer,
    ammoOf: ammoOf, canFire: canFire, effectiveWeapon: effectiveWeapon,
    applyMove: applyMove,
    resolveTurn: resolveTurn, applyDetonations: applyDetonations, applyPhase: applyPhase,
    roundOutcome: roundOutcome, closeRound: closeRound, beginRound: beginRound,
    buyWeapon: buyWeapon, buyItem: buyItem,
    aiIntent: aiIntent, aiShop: aiShop,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);

if (typeof module !== "undefined" && module.exports) module.exports = globalThis.TalusMatch;
