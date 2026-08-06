/* ═══════════════════════════════════════════════════════════════════════════
   Talus — 탄도 · 탱크 · 턴 해결  (Phase 1)

   [SIM] 구획이다. **정수 연산만 쓴다.** float / Math.random / 시계 금지.
   지형 자동자는 `../sandbox/automaton.js` 를 그대로 재사용한다.

   ───────────────────────────────────────────────────────────────────────────
   왜 Phase 1 인데 정수인가

   `docs/roadmap.md` Phase 1 은 "아직 전부 float 로 만들어도 된다"고 허용하고
   Phase 2 에서 정수화하라고 한다. 그런데 자동자는 이미 정수이고
   `tools/ballistics-check.mjs` 에서 정수 탄도를 이미 검산해 두었으므로,
   여기서 float 로 쓰면 **버릴 코드를 새로 쓰는 것**이 된다.

   더 중요한 이유: Phase 2 완료 조건이 "Phase 1 과 체감이 동일하다"인데,
   float 로 감각을 잡고 정수로 옮기면 그 조건을 만족하는지 확인할 방법이 없다.
   처음부터 정수로 잡으면 그 위험이 아예 없다.

   ───────────────────────────────────────────────────────────────────────────
   임시로 값을 정한 것 — 전부 `docs/decisions.md` 대기 항목이다

   · POWER_SCALE / GRAVITY / WIND_MAX  → C3 · C4. 슬라이더로 조절한다
   · BARREL_LEN                        → simulation.md §4.1 미결. 288 subpx (18px)
   · 표준탄 damage / blastRadius        → C1. blastRadius 는 2의 거듭제곱 강제
   · FALL_DAMAGE_*                     → C8
   · 매몰 임계 80%                      → C8. 해제 규칙은 B13 (여기서는 매 턴 재평가)
   · 맵 생성                            → B1. sandbox 의 hills 프리셋을 쓴다
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  "use strict";
  var T = root.TalusSim;
  if (!T) throw new Error("../sandbox/automaton.js 를 먼저 로드해야 한다");

  var W = T.W, H = T.H, grid = T.grid, EMPTY = T.EMPTY, BEDROCK = T.BEDROCK;

  /* ── 좌표계 (simulation.md §2.1) ──────────────────────────────────── */
  var SUBPX = 16;                       // subpx per px
  var CELL_SUBPX = 32;                  // 2px
  var CELL_SHIFT = 5;                   // subpx → cell 은 >> 5
  var MAP_W_SUB = W * CELL_SUBPX;       // 30720
  var MAP_H_SUB = H * CELL_SUBPX;       // 17280

  /* ── 상수 (simulation.md §8). 전부 잠정값 ─────────────────────────── */
  var CFG = {
    gravity: 12,                        // subpx/tick²
    powerScale: 624,                    // B12 확정. 최대 파워 45° → 맵 폭의 98.9% (1899px)
    windMax: 2,                         // C4 추천값 (중력의 1/6)
    dragQ16: 0,                         // §4.5 — 항력 없음
    maxFlightTicks: 1800,               // 30초
    selfHitIgnore: 8,
    barrelLen: 288,                     // 18px. simulation.md §4.1 미결
    fallSafePx: 24,
    fallDamageNum: 1,
    fallDamageShift: 1,                 // (fallPx - 24) / 2
    burialPermille: 800,                // AABB 의 80%
    burialDamage: 6,
  };

  var TANK_W = 384, TANK_H = 256;       // 24 × 16 px
  var MAX_HP = 100;

  /* ── 표준탄. 무기 테이블 스키마는 decisions.md C1 ──────────────────── */
  var STANDARD = {
    id: 0,
    name: "표준탄",
    maxDamage: 50,
    blastRadius: 1024,                  // subpx. 64px = 32셀. **2의 거듭제곱 강제**
    damageShift: 10,                    // = log2(1024). dist=0 에서 정확히 maxDamage
    carveCells: 1024 >> CELL_SHIFT,      // 32
  };

  /* ── Q12 삼각함수 표 (simulation.md §3) ────────────────────────────
     Phase 2 에서 `tables/trig.bin` 으로 커밋된다. 지금은 로드 시 생성한다.
     Q12 로 반올림하므로 libm 의 마지막 자리 차이는 정수 결과를 바꾸지 않는다
     (바꾸려면 오차가 1e-4 규모여야 한다). */
  var SIN = new Int16Array(1801), COS = new Int16Array(1801);
  (function buildTrig() {
    for (var d = 0; d <= 1800; d++) {
      var r = (d / 10) * Math.PI / 180;
      SIN[d] = Math.round(Math.sin(r) * 4096);
      COS[d] = Math.round(Math.cos(r) * 4096);
    }
  })();

  /* ── 정수 제곱근 (simulation.md §5.1) ─────────────────────────────── */
  function isqrt(n) {
    if (n <= 0) return 0;
    var x = n, y = (x + 1) >> 1;
    while (y < x) { x = y; y = (x + Math.floor(n / x)) >> 1; }
    return x;
  }

  /* ── 셀 조회. 격자 밖 규칙은 terrain.md §1.1 ─────────────────────── */
  function solidAtSub(xs, ys) {
    if (ys < 0) return false;                        // 위쪽 밖은 통과
    if (xs < 0 || xs >= MAP_W_SUB) return false;     // 좌우 밖은 통과
    if (ys >= MAP_H_SUB) return false;               // 아래쪽 밖은 소멸 처리
    var cx = xs >> CELL_SHIFT, cy = ys >> CELL_SHIFT;
    return grid[cy * W + cx] !== EMPTY;
  }

  /* ══════════════════════════════════════════════════════════════════
     탄도 (simulation.md §4)

     궤적 전체를 한 번에 계산해 돌려준다. 렌더러는 그것을 재생만 한다 —
     서버가 계산하고 클라가 재생하는 netcode 구조(§2.3)와 같은 모양이다.

     반환: { xs, ys, n, hit, hitX, hitY, hitTank }
       xs/ys  틱별 위치 (subpx). n 개
       hit    "terrain" | "tank" | "void" | "timeout"
     ══════════════════════════════════════════════════════════════════ */
  var pathX = new Int32Array(2048), pathY = new Int32Array(2048);

  function simulateShot(x0, y0, angle10, power, wind, shooterIdx, tanks, splitWeapon) {
    var v0 = (power * CFG.powerScale) >> 10;
    var vx = ((v0 * COS[angle10]) >> 12);
    var vy = -((v0 * SIN[angle10]) >> 12);          // 괄호 필수 — simulation.md §2.2
    return integrate(x0, y0, vx, vy, wind, shooterIdx, tanks, !!splitWeapon);
  }

  /* 자탄용 — 이미 정해진 속도에서 이어 적분한다 (분열탄). */
  function continueShot(x0, y0, vx, vy, wind, shooterIdx, tanks) {
    return integrate(x0, y0, vx, vy, wind, shooterIdx, tanks, false);
  }

  /* 적분 본체. stopAtApex 면 vy 가 0 이상으로 넘어가는 첫 틱에서 멈추고
     그 시점의 위치·속도를 함께 돌려준다 — 분열탄이 거기서 갈라진다. */
  function integrate(x0, y0, vx, vy, wind, shooterIdx, tanks, stopAtApex) {
    var x = x0, y = y0, n = 0;
    var hit = "timeout", hitTank = -1;
    var apexReached = false, apexX = 0, apexY = 0, apexVx = 0, apexVy = 0;

    for (var t = 0; t < CFG.maxFlightTicks; t++) {
      /* 틱당 순서를 고정한다 (§4.2) */
      vx += wind;
      vy += CFG.gravity;
      if (CFG.dragQ16 !== 0) vx -= (vx * CFG.dragQ16) >> 16;

      /* §4.3 — 틱 내 세분화. 잔차를 없애려 **절대 위치**로 누적한다 */
      var L = (vx < 0 ? -vx : vx) + (vy < 0 ? -vy : vy);
      var steps = (L >> CELL_SHIFT) + 1;             // 이동량이 항상 32 subpx 이하
      var sx = x, sy = y, done = false;

      for (var k = 1; k <= steps; k++) {
        x = sx + Math.floor((vx * k) / steps);
        y = sy + Math.floor((vy * k) / steps);

        if (y >= MAP_H_SUB) { hit = "void"; done = true; break; }
        if (solidAtSub(x, y)) { hit = "terrain"; done = true; break; }

        if (tanks) {
          for (var i = 0; i < tanks.length; i++) {
            var tk = tanks[i];
            if (!tk.alive) continue;
            if (i === shooterIdx && t < CFG.selfHitIgnore) continue;
            if (x >= tk.x - (TANK_W >> 1) && x <= tk.x + (TANK_W >> 1) &&
                y >= tk.y - TANK_H && y <= tk.y) {
              hit = "tank"; hitTank = i; done = true; break;
            }
          }
          if (done) break;
        }
      }

      if (n < pathX.length) { pathX[n] = x; pathY[n] = y; n++; }
      if (done) break;

      /* 정점 판정 — vy 가 처음 0 이상이 되는 틱. 상승이 끝난 지점이다. */
      if (stopAtApex && !apexReached && vy >= 0) {
        apexReached = true;
        apexX = x; apexY = y; apexVx = vx; apexVy = vy;
        break;
      }
    }

    return {
      xs: pathX, ys: pathY, n: n, hit: hit, hitX: x, hitY: y, hitTank: hitTank,
      apexReached: apexReached, apexX: apexX, apexY: apexY, apexVx: apexVx, apexVy: apexVy,
    };
  }

  /* ── 평지 사거리 (simulation.md §8.1) ─────────────────────────────
     지형을 무시하고 "발사 높이로 되돌아온 순간"까지의 수평 거리를 px 로 돌려준다.
     `tools/ballistics-check.mjs` 와 **같은 정의**여야 문서 표와 대조할 수 있다.

     `simulateShot` 으로 재면 안 된다 — 그건 지형에 부딛는 지점을 돌려주므로
     발사 고도에 따라 값이 달라진다. 실제로 공중에서 쏘아 1220px 로 과대 측정된
     버그가 있었다(정답 916px). 스폰 간격이 이 값에서 파생되므로 조용히 게임을 깨뜨린다. */
  function flatRangePx(angle10, power, wind) {
    var v0 = (power * CFG.powerScale) >> 10;
    var vx = ((v0 * COS[angle10]) >> 12);
    var vy = -((v0 * SIN[angle10]) >> 12);
    var x = 0, y = 0;
    for (var t = 0; t < CFG.maxFlightTicks; t++) {
      vx += (wind | 0);
      vy += CFG.gravity;
      if (CFG.dragQ16 !== 0) vx -= (vx * CFG.dragQ16) >> 16;
      var L = (vx < 0 ? -vx : vx) + (vy < 0 ? -vy : vy);
      var steps = (L >> CELL_SHIFT) + 1;
      var sx = x, sy = y;
      for (var k = 1; k <= steps; k++) {
        x = sx + Math.floor((vx * k) / steps);
        y = sy + Math.floor((vy * k) / steps);
        if (y >= 0 && vy > 0) return (x / SUBPX) | 0;
      }
    }
    return (x / SUBPX) | 0;
  }

  /* 포신 끝 위치 (simulation.md §4.1). 회전 중심은 탱크 상단 중앙으로 잡는다 */
  function muzzle(tank, angle10) {
    return {
      x: tank.x + ((CFG.barrelLen * COS[angle10]) >> 12),
      y: (tank.y - TANK_H) - ((CFG.barrelLen * SIN[angle10]) >> 12),
    };
  }

  /* ══ 폭발 (simulation.md §5) ═══════════════════════════════════════
     피해는 **카빙 전 위치 기준으로 전부 계산한 뒤** 한꺼번에 적용한다 (§5.2). */
  function computeDamage(cx, cy, weapon, tanks) {
    var out = [];
    for (var i = 0; i < tanks.length; i++) {
      var tk = tanks[i];
      if (!tk.alive) continue;
      var dx = tk.x - cx, dy = (tk.y - (TANK_H >> 1)) - cy;
      var dist = isqrt(dx * dx + dy * dy);
      if (dist >= weapon.blastRadius) continue;
      out.push({
        idx: i,
        dmg: (weapon.maxDamage * (weapon.blastRadius - dist)) >> weapon.damageShift,
        dist: dist,
      });
    }
    return out;
  }

  /* ══ 탱크 재배치 (simulation.md §6.1) ══════════════════════════════
     정착이 완전히 끝난 뒤 한 번만 호출한다 — 연결성 재검사 루프까지 끝난 뒤다.
     반환: 낙하 픽셀. 화면 밖으로 나갔으면 -1 */
  function reseatTank(tank) {
    var startY = tank.y;
    var halfW = TANK_W >> 1;
    var guard = 0;
    while (guard++ < H * 2) {
      if (tank.y >= MAP_H_SUB) return -1;            // 화면 아래 이탈 → 즉사
      if (supported(tank)) break;
      tank.y += CELL_SUBPX;                          // 한 셀씩 내린다
    }
    /* 발밑이 솟아올랐으면 밀어올린다 — B13 의 매몰 해제와 별개로,
       흙이 쌓인 자리에 탱크가 박혀 있는 것을 막는다 */
    guard = 0;
    while (guard++ < H * 2 && buriedFraction(tank) >= 1000) tank.y -= CELL_SUBPX;

    var fallPx = (tank.y - startY) >> 4;             // subpx → px
    return fallPx > 0 ? fallPx : 0;
  }

  function supported(tank) {
    var halfW = TANK_W >> 1;
    var footY = tank.y;
    if (footY >= MAP_H_SUB) return false;
    for (var xs = tank.x - halfW; xs <= tank.x + halfW; xs += CELL_SUBPX) {
      if (solidAtSub(xs, footY)) return true;
    }
    return false;
  }

  /* AABB 안에서 비-EMPTY 셀의 비율 (‰). 매몰 판정용 (§6.1) */
  function buriedFraction(tank) {
    var halfW = TANK_W >> 1, filled = 0, total = 0;
    for (var ys = tank.y - TANK_H; ys < tank.y; ys += CELL_SUBPX) {
      for (var xs = tank.x - halfW; xs <= tank.x + halfW; xs += CELL_SUBPX) {
        total++;
        if (solidAtSub(xs, ys)) filled++;
      }
    }
    return total === 0 ? 0 : Math.floor((filled * 1000) / total);
  }

  function fallDamage(fallPx) {
    if (fallPx <= CFG.fallSafePx) return 0;
    return ((fallPx - CFG.fallSafePx) * CFG.fallDamageNum) >> CFG.fallDamageShift;
  }

  /* ══ 스폰 배치 ═══════════════════════════════════════════════════
     맵 생성이 미결(decisions.md B1)이므로 sandbox 의 hills 프리셋 위에
     최소 간격만 지켜 앉힌다. 확정 시 생성기와 함께 옮긴다. */
  function surfaceSubY(xSub) {
    var cx = xSub >> CELL_SHIFT;
    if (cx < 0) cx = 0;
    if (cx > W - 1) cx = W - 1;
    for (var cy = 0; cy < H; cy++) {
      if (grid[cy * W + cx] !== EMPTY) return cy * CELL_SUBPX;
    }
    return MAP_H_SUB;
  }

  function makeTank(slot, xSub, name) {
    return {
      slot: slot, name: name, x: xSub, y: surfaceSubY(xSub),
      hp: MAX_HP, alive: true, buried: false,
      angle10: slot === 0 ? 450 : 1350,             // 45° / 135°
      power: 600,
    };
  }

  root.TalusPhys = {
    SUBPX: SUBPX, CELL_SUBPX: CELL_SUBPX, CELL_SHIFT: CELL_SHIFT,
    MAP_W_SUB: MAP_W_SUB, MAP_H_SUB: MAP_H_SUB,
    TANK_W: TANK_W, TANK_H: TANK_H, MAX_HP: MAX_HP,
    CFG: CFG, STANDARD: STANDARD,
    SIN: SIN, COS: COS, isqrt: isqrt,
    simulateShot: simulateShot, continueShot: continueShot,
    muzzle: muzzle, flatRangePx: flatRangePx,
    computeDamage: computeDamage,
    reseatTank: reseatTank, supported: supported,
    buriedFraction: buriedFraction, fallDamage: fallDamage,
    surfaceSubY: surfaceSubY, makeTank: makeTank,
    solidAtSub: solidAtSub,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);

if (typeof module !== "undefined" && module.exports) module.exports = globalThis.TalusPhys;
