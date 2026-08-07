/* ═══════════════════════════════════════════════════════════════════════════
   Talus — 무기 8종  (docs/game-design.md §6.1)

   [SIM] 구획. **정수 연산만.** float / Math.random / 시계 금지.

   ───────────────────────────────────────────────────────────────────────────
   무기 설계 원칙: **모든 무기는 지형을 다르게 바꾼다.** 데미지만 다른 무기는 없다.

   이 파일이 `docs/decisions.md` C9 의 "무기가 요구하는 sim 기능"을 구현한다.
   각 기능을 어떻게 구현했는지와, 그게 결정을 만든 것인지 아닌지를 아래에 적는다.

   | 요구 | 구현 | 새 결정인가 |
   |---|---|---|
   | 적층탄의 지형 **추가** | `TalusSim.deposit()` 신설 | 아니다. EMPTY 만 채우는 것은 §2 에서 강제된다 |
   | 분열탄의 다중 발사체 | 정점에서 5발로 분기 | **잠정** — 분기 수·산개폭은 밸런싱 |
   | 굴착탄의 하향 관통 | 착탄 후 아래로 N셀 파고들어 폭발 | **잠정** — 깊이는 밸런싱 |
   | 전복탄의 경사 활강 | 착탄 후 표면을 따라 낮은 쪽으로 굴러감 | **잠정** — 최대 거리는 밸런싱 |
   | 성형탄의 피해≠카빙 반경 | `blastRadius` 와 `carveCells` 를 분리 | 아니다. 이미 단위가 달랐다 |
   | 측풍계 | 현재 바람은 모두 표시하고 다음 턴을 예보한다 | 확정 — lockstep 에서 정보 은닉은 불가능하다 |

   **측풍계가 왜 그런가.** 모든 클라가 같은 입력으로 같은 계산을 하므로 "나만 정확한
   바람 값을 안다"는 것이 원리적으로 불가능하다. 서버가 누군가에게 다른 값을 보내면
   그 사람의 재생이 갈라진다. 그래서 현재 바람 값은 **모두가 알고 있고**, 측풍계는
   다음 턴의 바람과 돌풍 여부를 먼저 보여주는 UI 아이템으로 재정의했다.

   ───────────────────────────────────────────────────────────────────────────
   무기 파라미터 스키마 — `decisions.md` C1

   값은 전부 **잠정**이다. 스키마(어떤 열이 존재하는가)만 확정으로 취급한다.

     maxDamage     dist=0 에서의 피해
     blastRadius   피해 반경 (subpx). **2의 거듭제곱 강제** — simulation.md §5.1
     damageShift   = log2(blastRadius). 테스트로 강제한다
     carveCells    카빙 반경 (셀). blastRadius 와 독립이다 (성형탄이 이걸 쓴다)
     ammo0         라운드 1 시작 시 보유량. null = 무한
     price         상점 1발 가격
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  "use strict";
  var T = root.TalusSim, P = root.TalusPhys;
  if (!T || !P) throw new Error("automaton.js 와 sim.js 를 먼저 로드해야 한다");

  var CELL_SHIFT = P.CELL_SHIFT, CELL = P.CELL_SUBPX;
  var W = T.W, H = T.H, grid = T.grid, EMPTY = T.EMPTY;

  /* log2 검증 — blastRadius 가 2의 거듭제곱이 아니면 dist=0 피해가 maxDamage 가 아니다 */
  function shiftOf(r) {
    var s = 0, v = r;
    while (v > 1) { v >>= 1; s++; }
    if ((1 << s) !== r) throw new Error("blastRadius 가 2의 거듭제곱이 아니다: " + r);
    return s;
  }

  function W_(o) {
    o.damageShift = shiftOf(o.blastRadius);
    return o;
  }

  /* ── 무기 테이블 ────────────────────────────────────────────────────── */
  var NUCLEAR_WEAPON_ID = 7;
  var WEAPONS = [
    W_({ id: 0, name: "표준탄", kind: "plain",
         maxDamage: 45, blastRadius: 1024, carveCells: 28,
         ammo0: null, price: 0,
         desc: "작은 원형 구덩이. 무한" }),

    W_({ id: 1, name: "파쇄탄", kind: "plain",
         maxDamage: 62, blastRadius: 2048, carveCells: 60,
         ammo0: 2, price: 700,
         desc: "큰 구덩이 + 넓은 붕괴 유발" }),

    W_({ id: 2, name: "분열탄", kind: "split",
         maxDamage: 30, blastRadius: 512, carveCells: 16,
         splitCount: 5, splitSpread: 34,          // subpx/tick. 정점에서 좌우로 벌어진다
         ammo0: 2, price: 850,
         desc: "정점에서 5발로 갈라져 산개" }),

    W_({ id: 3, name: "굴착탄", kind: "burrow",
         maxDamage: 55, blastRadius: 1024, carveCells: 24,
         burrowCells: 46,                          // 착탄 지점에서 아래로 파고드는 셀 수
         ammo0: 2, price: 800,
         desc: "지면에 박힌 뒤 아래로 파고들어 폭발" }),

    W_({ id: 4, name: "전복탄", kind: "roll",
         maxDamage: 50, blastRadius: 1024, carveCells: 26,
         rollCells: 140,                           // 경사를 따라 굴러가는 최대 셀 수
         ammo0: 2, price: 900,
         desc: "착탄 후 경사를 따라 굴러가서 폭발" }),

    W_({ id: 5, name: "성형탄", kind: "plain",
         maxDamage: 95, blastRadius: 512, carveCells: 5,
         ammo0: 2, price: 950,
         desc: "피해 높고 구덩이는 아주 작다. 지형 보존" }),

    W_({ id: 6, name: "적층탄", kind: "deposit",
         maxDamage: 0, blastRadius: 512, carveCells: 0,
         depositCells: 30, depositMat: T.SOIL,
         ammo0: 2, price: 650,
         desc: "폭발 대신 흙을 쌓는다. 유일한 지형 추가" }),

    W_({ id: NUCLEAR_WEAPON_ID, name: "핵포탄", kind: "plain",
         maxDamage: 120, blastRadius: 4096, carveCells: 80,
         ammo0: 0, price: 4800,
         desc: "초기 0발. 전장을 뒤엎는 초대형 폭발" }),
  ];

  /* ── 비-포탄 아이템 (game-design.md §6.2) ───────────────────────────── */
  var ITEMS = [
    { id: 0, key: "shield",   name: "차폐막", price: 600, desc: "1회 피격 무효" },
    { id: 1, key: "parachute", name: "낙하산", price: 400, desc: "낙하 피해 무효. 자동 발동" },
    { id: 2, key: "fuel",     name: "연료",   price: 300, desc: "턴당 좌우 이동" },
    { id: 3, key: "anemo",    name: "측풍계", price: 500, desc: "다음 턴 바람과 돌풍을 예보" },
  ];

  /* ══════════════════════════════════════════════════════════════════════
     발사 해결 — 발사 1회가 **폭발 여러 개**를 만들 수 있다

     반환: { legs: [ {pts:[{x,y}], kind} ], dets: [ {x, y, weapon} ] }
       legs  렌더러가 재생할 궤적 조각들 (분열탄은 여러 개)
       dets  터질 지점 목록. 모든 leg 재생이 끝난 뒤 한꺼번에 적용한다
             (simulation.md §5.2 — 피해는 카빙 전 위치 기준으로 전부 계산)
     ══════════════════════════════════════════════════════════════════════ */
  function resolveShot(x0, y0, angle10, power, wind, shooterIdx, tanks, weapon) {
    var legs = [], dets = [];

    var s = P.simulateShot(x0, y0, angle10, power, wind, shooterIdx, tanks,
                           weapon.kind === "split" ? weapon : null);
    var pts = copyPts(s);
    legs.push({ pts: pts, kind: "main" });

    if (weapon.kind === "split" && s.apexReached) {
      /* 정점에서 갈라진다. 부모는 여기서 소멸하고 자탄 N 발이 이어받는다.
         산개는 좌우 대칭 고정 오프셋이라 난수가 없다 — 결정론이 유지된다. */
      var n = weapon.splitCount, half = (n - 1) >> 1;
      for (var i = 0; i < n; i++) {
        var dvx = (i - half) * weapon.splitSpread;
        var sub = P.continueShot(s.apexX, s.apexY, s.apexVx + dvx, s.apexVy,
                                 wind, shooterIdx, tanks);
        legs.push({ pts: copyPts(sub), kind: "split" });
        pushDet(dets, sub, weapon);
      }
      return { legs: legs, dets: dets };
    }

    if (s.hit === "void" || s.hit === "timeout") return { legs: legs, dets: dets };

    if (weapon.kind === "burrow") {
      /* 착탄 지점에서 아래로 파고든다. 지형을 뚫고 내려가되 BEDROCK 은 못 뚫는다. */
      var bx = s.hitX >> CELL_SHIFT, by = s.hitY >> CELL_SHIFT;
      var tail = [];
      for (var d = 0; d < weapon.burrowCells; d++) {
        var ny = by + 1;
        if (ny >= H) break;
        if (grid[ny * W + bx] === T.BEDROCK) break;
        by = ny;
        tail.push({ x: bx * CELL + (CELL >> 1), y: by * CELL + (CELL >> 1) });
      }
      if (tail.length) legs.push({ pts: tail, kind: "burrow" });
      dets.push({ x: bx * CELL + (CELL >> 1), y: by * CELL + (CELL >> 1), weapon: weapon });
      return { legs: legs, dets: dets };
    }

    if (weapon.kind === "roll") {
      /* 표면을 따라 낮은 쪽으로 굴러간다.
         매 스텝: 아래가 비면 낙하, 아니면 좌·우 중 **더 낮은 쪽**으로 한 칸.
         양쪽이 같으면 §7.1 해시로 결정론적으로 고른다. 내려갈 곳이 없으면 멈춘다. */
      var rx = s.hitX >> CELL_SHIFT, ry = s.hitY >> CELL_SHIFT;
      var trail = [];
      for (var k = 0; k < weapon.rollCells; k++) {
        if (ry + 1 < H && grid[(ry + 1) * W + rx] === EMPTY) { ry++; }
        else {
          var dl = dropDepth(rx - 1, ry), dr = dropDepth(rx + 1, ry);
          if (dl === 0 && dr === 0) break;                   // 양쪽이 다 막혔다
          var goLeft;
          if (dl > dr) goLeft = true;
          else if (dr > dl) goLeft = false;
          else goLeft = ((T.hash32(T.CFG.seed, rx, ry, k) & 1) === 0);
          rx += goLeft ? -1 : 1;
          if (rx < 0 || rx >= W) break;                       // 격자 밖으로 굴러 나갔다
        }
        trail.push({ x: rx * CELL + (CELL >> 1), y: ry * CELL + (CELL >> 1) });
      }
      if (trail.length) legs.push({ pts: trail, kind: "roll" });
      dets.push({ x: rx * CELL + (CELL >> 1), y: ry * CELL + (CELL >> 1), weapon: weapon });
      return { legs: legs, dets: dets };
    }

    /* plain / deposit — 착탄 지점 그대로 */
    dets.push({ x: s.hitX, y: s.hitY, weapon: weapon });
    return { legs: legs, dets: dets };
  }

  /* (x, y) 에서 아래로 몇 셀 비어 있는가. 0 이면 그 방향으로 못 간다 */
  function dropDepth(x, y) {
    if (x < 0 || x >= W || y + 1 >= H) return 0;
    if (grid[y * W + x] !== EMPTY) return 0;                  // 그 칸 자체가 막혔다
    var d = 0;
    while (y + 1 + d < H && grid[(y + 1 + d) * W + x] === EMPTY && d < 8) d++;
    return d + 1;
  }

  function copyPts(s) {
    var out = [];
    for (var i = 0; i < s.n; i++) out.push({ x: s.xs[i], y: s.ys[i] });
    return out;
  }
  function pushDet(dets, s, weapon) {
    if (s.hit === "void" || s.hit === "timeout") return;
    dets.push({ x: s.hitX, y: s.hitY, weapon: weapon });
  }

  /* ══ 폭발 적용 — 카빙/적층 ════════════════════════════════════════════
     피해 계산은 호출자가 **이 함수를 부르기 전에** 전부 끝내야 한다
     (simulation.md §5.2 — 순차 적용하면 슬롯 순서가 유불리를 만든다). */
  function applyDetonation(det) {
    var w = det.weapon;
    var cx = det.x >> CELL_SHIFT, cy = det.y >> CELL_SHIFT;
    if (cx < 0) cx = 0; if (cx > W - 1) cx = W - 1;
    if (cy < 0) cy = 0; if (cy > H - 1) cy = H - 1;

    if (w.kind === "deposit") {
      var filled = T.deposit(cx, cy, w.depositCells, w.depositMat);
      return { removed: 0, conv: 0, filled: filled };
    }
    var r = T.carveDeferred(cx, cy, w.carveCells);
    return { removed: r.removed, conv: 0, filled: 0 };
  }

  root.TalusWeapons = {
    WEAPONS: WEAPONS, ITEMS: ITEMS, NUCLEAR_WEAPON_ID: NUCLEAR_WEAPON_ID,
    resolveShot: resolveShot, applyDetonation: applyDetonation,
    byId: function (id) { return WEAPONS[id] || WEAPONS[0]; },
  };
})(typeof globalThis !== "undefined" ? globalThis : this);

if (typeof module !== "undefined" && module.exports) module.exports = globalThis.TalusWeapons;
