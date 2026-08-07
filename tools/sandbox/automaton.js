/* ═══════════════════════════════════════════════════════════════════════════
   Talus — 모래 붕괴 자동자 참조 구현  (docs/terrain.md §1~§8)

   이 파일은 [SIM] 구획이다. **정수 연산만 쓴다.**
   float / Math.random / 시계 / 순회 순서 의존 금지.
   Phase 2 에서 client/src/sim/terrain.ts 로, Phase 3 에서 numpy 로 옮겨진다.

   브라우저(<script src>)와 node(import) 양쪽에서 동작한다. UI 도, 렌더러도,
   계측도 여기 없다 — 그건 index.html 의 [TOOL] 구획과 harness.mjs 가 한다.
   나눈 이유: 헤드리스로 물리를 검증할 수 있어야 상수를 믿을 수 있다.

   ───────────────────────────────────────────────────────────────────────────
   문서와 다르게 구현한 곳. 전부 docs/terrain.md 에 반영했다.

   (1) §3.2 규칙 가중치 방향을 역전했다.
       문서 원문 `priority = (규칙번호 << 16) | hash16` 을 대입하면 규칙 3 이 이기는데,
       같은 절이 "규칙 1(자유낙하)이 규칙 2·3보다 항상 이긴다"고 한다. 서술이 의도다.
       → 가중치 규칙1=3, 규칙2=2, 규칙3=1.

   (2) §3.2 "동점은 발생하지 않는다"는 성립하지 않아 우선순위에 방향 비트를 넣었다.
       16비트 해시는 519k 셀에서 충돌이 사실상 확정이고, 동점이 나면 한 목표 셀에
       두 셀이 들어가 질량이 사라지며 어느 재질이 남는지가 순회 순서에 의존한다.
       한 목표를 같은 규칙으로 경합하는 제안자는 정확히 2개(좌/우)뿐이므로
       방향 비트를 넣으면 동점이 **구조적으로** 불가능해진다. 좌우 편향을 없애려
       목표 셀 해시 1비트로 승자 쪽을 뒤집는다.
       → prio = (W << 17) | ((side ^ (hash(dst) & 1)) << 16) | (hash(src) & 0xFFFF)

   (3) §7.1 해시에 최종 확산(avalanche) 단계를 추가했다. ★가장 중요한 수정★
       FNV-1a 는 하위 비트로 확산되지 않는다. 곱수 0x01000193 이 홀수라
       bit0 이 입력 비트의 순수 XOR 패리티가 되고, 실측 결과:
         · `h & 1` 을 입력 비트 패리티로 100.00% 예측 가능
         · step 을 1 올리면 격자 **전체**의 방향 비트가 동시에 반전
         · 즉 방향장(direction field)이 평생 단 2가지 배치만 갖는다
       그 결과 어떤 셀이 필요한 방향을 두 스텝 연속 못 받는 상황이 생기고,
       §5.2 의 "이동 셀 0" 정착 판정이 거짓으로 성립해 더미가 사면 중간에 얼었다.
       (SCREE 실측 55°, 문서 주장 45°)
       → FNV-1a 뒤에 xorshift-multiply 확산을 붙였다.

   (4) §5.1 활성 집합과 §5.2 정착 판정을 "이동한 셀"이 아니라 "이동 가능한 셀"
       기준으로 바꿨다.
       문서의 "활성 = 직전 스텝에 움직인 셀 ∪ 8이웃" 은 규칙이 상태만의 함수일 때만
       옳다. 그런데 §3.1 의 규칙은 방향 선택과 slideChance 게이트 때문에
       **상태 + 스텝**의 함수다. 움직일 수 있었지만 이번 스텝에 게이트에 막힌 셀을
       비활성으로 떨어뜨리면 영구히 얼어붙는다. 실측으로 확인했다 —
       활성 행 0으로 "정착" 보고된 격자에 강제로 전 행을 켜니 즉시 58셀이 움직이고
       723스텝 30,055회 이동이 더 필요했다.
       → 제안 단계에서 **양방향을 기하로 평가**해 "어떤 해시 값에서든 움직일 수
         있는가"를 판정하고, 그 셀의 행을 다음 스텝 활성으로 남긴다.
         정착 = 이동 가능한 셀이 0개. 이건 근사가 아니라 정확한 판정이다.

   (5) §7.1 slideChance 를 Q8 정수(0~256)로 고정했다.
       §7.1 게이트가 `chance * 65536` 으로 실수 곱을 쓰는데 §7.3 이 부동소수점을
       금지한다. 0.15 × 65536 = 9830.4 라 floor/round 선택이 갈리면 두 구현이 갈라진다.
       → Q8 정수로 두고 임계값을 `q8 << 8` 로 만든다. 2의 거듭제곱 스케일이라
         언어 간 차이가 없다. 0.75 → 192, 0.15 → 38.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  "use strict";

  /* ── 격자 (§1) ──────────────────────────────────────────────────────── */
  var W = 960, H = 540, N = W * H;

  /* ── 재질 (§2) ──────────────────────────────────────────────────────── */
  var EMPTY = 0, SAND = 1, SOIL = 2, SCREE = 3, ROCK = 4, BEDROCK = 5;
  var MAT_NAME = ["EMPTY", "SAND", "SOIL", "SCREE", "ROCK", "BEDROCK"];

  /* 해소 우선순위 가중치 — 큰 값이 이긴다 (수정 1) */
  var RW_FALL = 3, RW_DIAG = 2, RW_CREEP = 1;
  var PRIO_FALL = RW_FALL << 17;

  var VOID = -1;                       // 격자 밖 (§1 — 떨어져 나가면 소멸)

  /* ── 튜닝 상수. §4 의 시작값이며 확정값이 아니다 ────────────────────── */
  var CFG = {
    /* Q8 (0~256). server/src/talus/constants.py 와 같은 값을 유지한다.
       정적 게이트(아래)에서 Q8 이 안식각을 연속 조절한다 — 실측 곡선은 terrain.md §4.2.
         256 → 26.6°   48 → 40.3°   0 → 44.2°(규칙 3 미적용)
       값은 밸런싱 대상이지만 조절 **방법**은 확정이다 (decisions.md A1). */
    slideSandQ8: 256,                  // 26.6° — 완만한 지표층
    slideSoilQ8: 48,                   // 40.3° — 급한 중간층
    slideScreeQ8: 0,                   // 44.2° — 규칙 3 을 안 쓴다는 뜻
    seed: 0x55,
    blastResist: [0, 256, 208, 256, 140, 0],   // Q8 (§8)
    /* 문서 §3.1 은 "방향을 해시로 하나 고른다"고만 하고 실패 시 반대쪽을 시도하는지
       말하지 않는다. false = 문서 문자 그대로(한 방향만 시도).
       true = 고른 방향이 막히면 반대쪽도 시도 → 유동이 대략 2배 빨라진다.
       물리가 바뀌는 결정이라 여기서 확정하지 않는다. 미결 항목. */
    bothDirections: false,

    /* 규칙 3 확률 게이트의 입력에서 step 을 뺀다. **확정 규칙이다** (decisions.md A1).
       활강 가능 여부가 위치로 고정되어 "잘 안 미끄러지는 자리"가 사면을 붙잡으므로
       slideChance 가 안식각을 실제로 조절한다.

       false 로 두면(step 포함) 게이트를 통과 못한 셀도 다음 스텝엔 통과하므로
       **결국 반드시 미끄러지고**, 종단 각도가 규칙 3 의 기하 한계로만 수렴한다 —
       즉 slideChance 가 안식각을 못 바꾼다. 실측으로 확인했다: Q8 8~256 전부 26.6°.
       비교용으로 false 를 남겨두었지만 규칙은 true 다. */
    slideGateStatic: true,
  };

  /* ── 상태 ───────────────────────────────────────────────────────────── */
  var grid = new Uint8Array(N);
  var rowActive = new Uint8Array(H), rowNext = new Uint8Array(H);
  var simStep = 0;

  /* 작업 버퍼는 전부 사전 할당한다. 스텝마다 할당하면 GC 가 프레임을 씹는다. */
  var pSrc = new Int32Array(N), pDst = new Int32Array(N), pPrio = new Int32Array(N);
  var pRow = new Int32Array(N), pDRow = new Int32Array(N);
  var pN = 0;

  var mSrc = new Int32Array(N), mDst = new Int32Array(N);
  var mMat = new Uint8Array(N), mRow = new Int32Array(N), mDRow = new Int32Array(N);
  var mN = 0;

  var bestPrio = new Int32Array(N), bestStamp = new Int32Array(N);
  var stampCtr = 0;

  var visited = new Uint8Array(N), ffStack = new Int32Array(N);
  var tieMark = new Uint8Array(N);

  var lastMoved = 0, lastMobile = 0;
  var tieWatch = false, tieCount = 0;

  /* 순회 순서 — 자기검증에서만 바꾼다. 결과가 달라지면 절대 규칙 3 위반이다. */
  var ORD_FWD = 0, ORD_REV = 1, ORD_SPLIT = 2;
  var resolveOrder = ORD_FWD, proposeBottomUp = true;

  function orderAt(i, n) {
    if (resolveOrder === ORD_FWD) return i;
    if (resolveOrder === ORD_REV) return n - 1 - i;
    var half = (n + 1) >> 1;           // 짝수 인덱스 역순 → 홀수 인덱스 정순
    return i < half ? (half - 1 - i) * 2 : ((i - half) * 2) + 1;
  }

  /* ══ 결정론 해시 (§7.1 + 수정 3) ══════════════════════════════════════
     h = avalanche( fnv1a32( seed ^ x*0x9E3779B1 ^ y*0x85EBCA77 ^ step*0xC2B2AE3D ) )

     fnv1a32 은 위 u32 의 4바이트를 리틀엔디언 순으로 먹인다.
     JS 는 Math.imul + >>>0 으로 32비트를 강제한다. Python 은 numpy uint32 로 고정한다.

     확산 단계를 빼면 안 된다 — 이 파일 머리말 (3) 참조. */
  var FNV_OFF = 0x811C9DC5 | 0, FNV_PRM = 0x01000193 | 0;

  function hash32(seed, x, y, st) {
    var v = (seed ^ Math.imul(x, 0x9E3779B1) ^ Math.imul(y, 0x85EBCA77) ^ Math.imul(st, 0xC2B2AE3D)) >>> 0;
    var h = FNV_OFF;
    h = Math.imul(h ^ (v & 0xFF), FNV_PRM);
    h = Math.imul(h ^ ((v >>> 8) & 0xFF), FNV_PRM);
    h = Math.imul(h ^ ((v >>> 16) & 0xFF), FNV_PRM);
    h = Math.imul(h ^ ((v >>> 24) & 0xFF), FNV_PRM);
    /* 최종 확산 — 하위 비트까지 섞는다 */
    h = (h ^ (h >>> 15)) >>> 0;
    h = Math.imul(h, 0x2545F491) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 0x85EBCA6B) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  }

  /* ══ 체크섬 (§7.2) — 격자 전체를 idx 오름차순으로 FNV-1a ═══════════════ */
  function checksum() {
    var h = FNV_OFF;
    for (var i = 0; i < N; i++) h = Math.imul(h ^ grid[i], FNV_PRM);
    return h >>> 0;
  }

  function massCount() {
    var c = 0;
    for (var i = 0; i < N; i++) if (grid[i] !== EMPTY) c++;
    return c;
  }

  /* ── 활성 행 (§5.1 + 수정 4) ────────────────────────────────────────── */
  function markBandNext(a, b) {
    var lo = a - 1, hi = b + 1;
    if (lo < 0) lo = 0;
    if (hi > H - 1) hi = H - 1;
    for (var k = lo; k <= hi; k++) rowNext[k] = 1;
  }
  function markRows(a, b) {
    if (a < 0) a = 0;
    if (b > H - 1) b = H - 1;
    for (var y = a; y <= b; y++) rowActive[y] = 1;
  }
  function markAll() { rowActive.fill(1); }
  function clearActive() { rowActive.fill(0); }
  function activeRowCount() {
    var c = 0;
    for (var y = 0; y < H; y++) if (rowActive[y]) c++;
    return c;
  }

  /* ══════════════════════════════════════════════════════════════════════
     자동자 한 스텝 (§3)

     Phase 1(제안)은 격자를 읽기만 하고, Phase 2(해소)만 격자를 쓴다.
     두 단계 모두 순회 순서와 무관해야 한다 (절대 규칙 3).

     반환: { moved, mobile }
       moved  — 이번 스텝에 실제로 이동한 셀 수
       mobile — 어떤 해시 값에서든 이동할 수 있는 셀 수.
                mobile === 0 이 정착의 **정확한** 판정이다 (수정 4).
     ══════════════════════════════════════════════════════════════════════ */
  function step() {
    var st = simStep, seed = CFG.seed;
    /* Q8 → Q16. SCREE 는 0 이라 규칙 3 이 절대 성립하지 않는다 (terrain.md §3.1 게이트 5번) */
    var thrSand = CFG.slideSandQ8 << 8, thrSoil = CFG.slideSoilQ8 << 8;
    var both = CFG.bothDirections;
    var gateStatic = CFG.slideGateStatic;
    pN = 0; mN = 0;
    var mobile = 0;
    rowNext.fill(0);

    /* ── Phase 1 — Propose (읽기 전용) ───────────────────────────────── */
    var yFrom = proposeBottomUp ? H - 1 : 0;
    var yTo = proposeBottomUp ? -1 : H;
    var yInc = proposeBottomUp ? -1 : 1;

    for (var y = yFrom; y !== yTo; y += yInc) {
      if (!rowActive[y]) continue;
      var rowBase = y * W, belowBase = rowBase + W;
      var yOut = (y + 1 >= H);

      for (var x = 0; x < W; x++) {
        var idx = rowBase + x, m = grid[idx];
        if (m === EMPTY || m === ROCK || m === BEDROCK) continue;   // 낙하 재질만

        /* ── 규칙 1 — 자유낙하: below == EMPTY ───────────────────────── */
        if (yOut) {                                  // 아래가 격자 밖 → 소멸
          pushMove(idx, VOID, m, y, y);
          markBandNext(y, y); mobile++;
          continue;
        }
        if (grid[belowBase + x] === EMPTY) {
          pSrc[pN] = idx; pDst[pN] = belowBase + x; pPrio[pN] = PRIO_FALL;
          pRow[pN] = y; pDRow[pN] = y + 1; pN++;
          markBandNext(y, y + 1); mobile++;
          continue;
        }

        /* 규칙 2·3 은 둘 다 "그 방향의 같은 행 셀이 EMPTY"를 요구한다.
           좌우가 모두 막혔으면 어떤 해시 값에서도 불가능하다 → 비활성. */
        var cl = (x === 0) ? EMPTY : grid[idx - 1];
        var cr = (x === W - 1) ? EMPTY : grid[idx + 1];
        if (cl !== EMPTY && cr !== EMPTY) continue;

        /* 규칙 3 가능성.
           step 게이트면 통과 못한 셀도 다음 스텝엔 통과하므로 "언젠가 반드시
           움직인다" → 이동 가능으로 센다.
           static 게이트면 통과 여부가 위치로 고정되므로, 통과 못하는 자리의 셀은
           **영구히** 규칙 3 을 못 쓴다 → 이동 가능이 아니다. 이걸 반영하지 않으면
           정착 판정이 영원히 성립하지 않는다. */
        var thr = (m === SAND) ? thrSand : (m === SOIL ? thrSoil : (CFG.slideScreeQ8 << 8));
        var r3ok;
        if (thr === 0) r3ok = false;
        else if (gateStatic) r3ok = ((hash32(seed ^ 0x9E3779B9, x, y, 0) >>> 8) & 0xFFFF) < thr;
        else r3ok = true;

        /* ── 양방향을 기하로 평가한다 (확률 게이트는 제외) ─────────────
           rL/rR : 0=불가, 2=규칙2, 3=규칙3.   dL/dR : 목표 idx 또는 VOID */
        var rL = 0, dL = 0, rR = 0, dR = 0;

        if (x === 0) {                               // 왼쪽이 격자 밖 → 규칙 2 성립, 소멸
          rL = 2; dL = VOID;
        } else if (cl === EMPTY) {
          if (grid[belowBase + x - 1] === EMPTY) { rL = 2; dL = belowBase + x - 1; }
          else if (r3ok) {
            var xl2 = x - 2;
            if (xl2 < 0) { rL = 3; dL = idx - 1; }   // dir2·belowDir2 가 격자 밖 = EMPTY
            else if (grid[idx - 2] === EMPTY && grid[belowBase + xl2] === EMPTY) { rL = 3; dL = idx - 1; }
          }
        }
        if (x === W - 1) {
          rR = 2; dR = VOID;
        } else if (cr === EMPTY) {
          if (grid[belowBase + x + 1] === EMPTY) { rR = 2; dR = belowBase + x + 1; }
          else if (r3ok) {
            var xr2 = x + 2;
            if (xr2 >= W) { rR = 3; dR = idx + 1; }
            else if (grid[idx + 2] === EMPTY && grid[belowBase + xr2] === EMPTY) { rR = 3; dR = idx + 1; }
          }
        }

        if (rL === 0 && rR === 0) continue;          // 기하적으로 정지 → 비활성

        /* 여기까지 왔으면 어떤 해시 값에서는 반드시 움직인다. 다음 스텝도 활성. */
        mobile++;
        markBandNext(y, y + 1);

        /* ── 방향 선택 (§7.1: h & 1) ─────────────────────────────────── */
        var h = hash32(seed, x, y, st);
        var side = h & 1;                            // 1=우, 0=좌
        var rule, dst, usedSide;
        if (side) {
          rule = rR; dst = dR; usedSide = 1;
          if (rule === 0 && both) { rule = rL; dst = dL; usedSide = 0; }
        } else {
          rule = rL; dst = dL; usedSide = 0;
          if (rule === 0 && both) { rule = rR; dst = dR; usedSide = 1; }
        }
        if (rule === 0) continue;                    // 고른 방향이 막혔다

        /* ── 규칙 3 확률 게이트 (§7.1) ─────────────────────────────────
           static 모드의 통과 여부는 위에서 이미 구했다 (r3ok 에 반영됨). */
        if (rule === 3 && !gateStatic && ((h >>> 8) & 0xFFFF) >= thr) continue;

        var dRow = (rule === 3) ? y : y + 1;
        if (dst === VOID) { pushMove(idx, VOID, m, y, dRow); continue; }

        /* 목표 셀 기준 1비트로 승자 쪽을 뒤집어 편향을 없앤다 (수정 2) */
        var dstX = dst - (dRow * W);
        var flip = hash32(seed, dstX, dRow, st) & 1;
        pSrc[pN] = idx; pDst[pN] = dst; pRow[pN] = y; pDRow[pN] = dRow;
        pPrio[pN] = ((rule === 3 ? RW_CREEP : RW_DIAG) << 17)
                  | (((usedSide ^ flip) & 1) << 16)
                  | (h & 0xFFFF);
        pN++;
      }
    }

    /* ── Phase 2 — Resolve ───────────────────────────────────────────
       1) 목표별 최대 우선순위    2) 최대와 같은 제안자만 이동 */
    var n = pN, stamp = ++stampCtr, i, k, dst2;
    for (i = 0; i < n; i++) {
      k = orderAt(i, n); dst2 = pDst[k];
      if (bestStamp[dst2] !== stamp) { bestStamp[dst2] = stamp; bestPrio[dst2] = pPrio[k]; }
      else if (pPrio[k] > bestPrio[dst2]) bestPrio[dst2] = pPrio[k];
    }
    for (i = 0; i < n; i++) {
      k = orderAt(i, n); dst2 = pDst[k];
      if (pPrio[k] !== bestPrio[dst2]) continue;
      if (tieWatch) { if (tieMark[dst2]) tieCount++; else tieMark[dst2] = 1; }
      pushMove(pSrc[k], dst2, grid[pSrc[k]], pRow[k], pDRow[k]);
    }

    /* ── 적용: 전부 비운 뒤 전부 쓴다 ─────────────────────────────────
       src 집합과 dst 집합은 서로소다 — dst 는 제안 시점에 EMPTY 였고 src 는 아니었다.
       그래도 2패스로 나눠 순서 의존을 원천 차단한다. */
    for (i = 0; i < mN; i++) grid[mSrc[i]] = EMPTY;
    for (i = 0; i < mN; i++) if (mDst[i] !== VOID) grid[mDst[i]] = mMat[i];
    if (tieWatch) for (i = 0; i < mN; i++) if (mDst[i] !== VOID) tieMark[mDst[i]] = 0;

    rowActive.set(rowNext);

    lastMoved = mN; lastMobile = mobile;
    simStep = (simStep + 1) | 0;
    return { moved: mN, mobile: mobile };
  }

  function pushMove(src, dst, mat, srcRow, dRow) {
    mSrc[mN] = src; mDst[mN] = dst; mMat[mN] = mat; mRow[mN] = srcRow; mDRow[mN] = dRow; mN++;
  }

  /* ══ 폭발 카빙 (§8) ══════════════════════════════════════════════════ */
  var carveR2 = new Int32Array(6);
  function carveOnly(cx, cy, radius) {
    for (var mm = 1; mm <= 5; mm++) {
      var rm = (radius * CFG.blastResist[mm]) >> 8;
      carveR2[mm] = rm * rm;
    }
    var y0 = Math.max(0, cy - radius), y1 = Math.min(H - 1, cy + radius);
    var x0 = Math.max(0, cx - radius), x1 = Math.min(W - 1, cx + radius);
    var removed = 0, hitRock = false;
    for (var y = y0; y <= y1; y++) {
      var dy = y - cy, dy2 = dy * dy, base = y * W;
      for (var x = x0; x <= x1; x++) {
        var idx = base + x, m = grid[idx];
        if (m === EMPTY || m === BEDROCK) continue;      // BEDROCK 은 저항 ∞
        var dx = x - cx;
        if (dx * dx + dy2 <= carveR2[m]) {
          grid[idx] = EMPTY; removed++;
          if (m === ROCK) hitRock = true;
        }
      }
    }
    markRows(y0 - 2, y1 + 2);
    return { removed: removed, hitRock: hitRock };
  }

  /* 단일 폭발 편의 API. 동시 폭발은 `carveDeferred()` 를 전부 적용한 뒤
     `connectivity()` 를 정확히 한 번 부른다 (terrain.md §6.1·§8). */
  function carve(cx, cy, radius) {
    var r = carveOnly(cx, cy, radius);
    return { removed: r.removed, conv: r.hitRock ? connectivity() : 0 };
  }

  function carveDeferred(cx, cy, radius) {
    var r = carveOnly(cx, cy, radius);
    return { removed: r.removed, conv: 0 };
  }

  /* ══ 흙 쌓기 — deposit (§8 의 역연산) ═════════════════════════════════
     적층탄이 요구하는 유일한 "지형 추가" 연산이다 (game-design.md §6.1).
     terrain.md §8 에는 제거만 있었다 — `decisions.md` C9.

     규칙 (전부 자명한 것에서 따라온다. 새 결정을 만들지 않았다):
       · 반경 내 **EMPTY 셀만** 채운다. 비-EMPTY 를 덮어쓰지 않는다.
         덮어쓰면 BEDROCK 을 지우거나 ROCK 을 SOIL 로 바꿀 수 있고, 그건 §2 위반이다.
       · 판정식은 carve 와 같은 제곱 비교. 재질 저항은 없다 (쌓는 쪽이라 저항이 무의미하다).
       · 쌓은 영역을 활성화한다 → 자동자가 곧바로 안식각까지 흘러내린다.
         즉 "벽"이 아니라 "더미"가 만들어진다. SOIL 로 쌓으면 40.3° 언덕이 된다.
       · 연결성 검사를 부르지 않는다. ROCK 을 만들지 않으므로 §6 과 무관하다.
     반환: 실제로 채운 셀 수 */
  function deposit(cx, cy, radius, mat) {
    var r2 = radius * radius;
    var y0 = Math.max(0, cy - radius), y1 = Math.min(H - 1, cy + radius);
    var x0 = Math.max(0, cx - radius), x1 = Math.min(W - 1, cx + radius);
    var filled = 0;
    for (var y = y0; y <= y1; y++) {
      var dy = y - cy, dy2 = dy * dy, base = y * W;
      for (var x = x0; x <= x1; x++) {
        var idx = base + x;
        if (grid[idx] !== EMPTY) continue;
        var dx = x - cx;
        if (dx * dx + dy2 <= r2) { grid[idx] = mat; filled++; }
      }
    }
    markRows(y0 - 2, y1 + 2);
    return filled;
  }

  /* ══ 암반 구조 붕괴 (§6) ══════════════════════════════════════════════
     BEDROCK 을 시드로 ROCK ∪ BEDROCK 을 4방향 연결로 flood fill.
     도달하지 못한 ROCK 을 전부 SCREE 로 바꾼다.
     라벨링 순서는 무관하고 결과 집합만 같으면 된다 (§6.1). */
  function connectivity() {
    visited.fill(0);
    var sp = 0, i, j;
    for (i = 0; i < N; i++) if (grid[i] === BEDROCK) { visited[i] = 1; ffStack[sp++] = i; }
    while (sp > 0) {
      i = ffStack[--sp];
      var x = i % W;
      if (x > 0)     { j = i - 1; if (!visited[j] && (grid[j] === ROCK || grid[j] === BEDROCK)) { visited[j] = 1; ffStack[sp++] = j; } }
      if (x < W - 1) { j = i + 1; if (!visited[j] && (grid[j] === ROCK || grid[j] === BEDROCK)) { visited[j] = 1; ffStack[sp++] = j; } }
      if (i >= W)    { j = i - W; if (!visited[j] && (grid[j] === ROCK || grid[j] === BEDROCK)) { visited[j] = 1; ffStack[sp++] = j; } }
      if (i < N - W) { j = i + W; if (!visited[j] && (grid[j] === ROCK || grid[j] === BEDROCK)) { visited[j] = 1; ffStack[sp++] = j; } }
    }
    var conv = 0, minY = H, maxY = -1;
    for (var y = 0; y < H; y++) {
      var base = y * W;
      for (var xx = 0; xx < W; xx++) {
        var ii = base + xx;
        if (grid[ii] === ROCK && !visited[ii]) {
          grid[ii] = SCREE; conv++;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (conv > 0) markRows(minY - 1, maxY + 1);
    return conv;
  }

  /* ══ 진단: 이동 가능한 셀을 규칙별로 센다 ══════════════════════════════
     step() 의 mobile 카운트와 독립적으로 격자 전체를 훑는다.
     둘이 어긋나면 활성 행 최적화가 셀을 놓치고 있다는 뜻이다. */
  function countMobile() {
    var r1 = 0, r2 = 0, r3 = 0;
    var seed = CFG.seed, gateStatic = CFG.slideGateStatic;
    var thrSand = CFG.slideSandQ8 << 8, thrSoil = CFG.slideSoilQ8 << 8;
    for (var y = 0; y < H; y++) {
      var rowBase = y * W, belowBase = rowBase + W, yOut = (y + 1 >= H);
      for (var x = 0; x < W; x++) {
        var idx = rowBase + x, m = grid[idx];
        if (m === EMPTY || m === ROCK || m === BEDROCK) continue;
        if (yOut || grid[belowBase + x] === EMPTY) { r1++; continue; }
        /* step() 과 **동일한** 규칙 3 가능성 판정을 써야 한다 */
        var thr = (m === SAND) ? thrSand : (m === SOIL ? thrSoil : (CFG.slideScreeQ8 << 8));
        var r3ok = thr === 0 ? false
          : (gateStatic ? (((hash32(seed ^ 0x9E3779B9, x, y, 0) >>> 8) & 0xFFFF) < thr) : true);
        var hit = 0;
        for (var s = 0; s < 2 && !hit; s++) {
          var d = s ? 1 : -1, xd = x + d;
          if (xd < 0 || xd >= W) { hit = 2; break; }
          if (grid[idx + d] !== EMPTY) continue;
          if (grid[belowBase + xd] === EMPTY) { hit = 2; break; }
          if (!r3ok) continue;
          var xd2 = x + d + d;
          if (xd2 < 0 || xd2 >= W) { hit = 3; break; }
          if (grid[idx + d + d] === EMPTY && grid[belowBase + xd2] === EMPTY) { hit = 3; break; }
        }
        if (hit === 2) r2++;
        else if (hit === 3) r3++;
      }
    }
    return { rule1: r1, rule2: r2, rule3: r3, total: r1 + r2 + r3 };
  }

  /* ══ 스냅샷 ═══════════════════════════════════════════════════════════ */
  function snapshot() { return { g: grid.slice(), st: simStep, ra: rowActive.slice() }; }
  function restore(s) { grid.set(s.g); simStep = s.st; rowActive.set(s.ra); mN = 0; lastMoved = 0; }

  /* ══ 공개 API ═════════════════════════════════════════════════════════ */
  root.TalusSim = {
    W: W, H: H, N: N,
    EMPTY: EMPTY, SAND: SAND, SOIL: SOIL, SCREE: SCREE, ROCK: ROCK, BEDROCK: BEDROCK,
    MAT_NAME: MAT_NAME, VOID: VOID,
    ORD_FWD: ORD_FWD, ORD_REV: ORD_REV, ORD_SPLIT: ORD_SPLIT,

    CFG: CFG,
    grid: grid,
    rowActive: rowActive,

    step: step,
    carve: carve,
    carveDeferred: carveDeferred,
    deposit: deposit,
    connectivity: connectivity,
    countMobile: countMobile,
    checksum: checksum,
    massCount: massCount,
    hash32: hash32,

    markRows: markRows,
    markAll: markAll,
    clearActive: clearActive,
    activeRowCount: activeRowCount,

    snapshot: snapshot,
    restore: restore,

    getStep: function () { return simStep; },
    setStep: function (v) { simStep = v | 0; },
    getLastMoved: function () { return lastMoved; },
    getLastMobile: function () { return lastMobile; },

    setOrder: function (ro, bottomUp) { resolveOrder = ro; proposeBottomUp = bottomUp; },
    getOrder: function () { return { resolveOrder: resolveOrder, proposeBottomUp: proposeBottomUp }; },

    setTieWatch: function (on) { tieWatch = !!on; if (on) { tieCount = 0; tieMark.fill(0); } },
    getTieCount: function () { return tieCount; },

    /* 렌더러가 이동한 셀을 강조할 때 쓴다. 읽기만 한다. */
    moved: { src: mSrc, dst: mDst, row: mRow, drow: mDRow, mat: mMat },
    getMovedCount: function () { return mN; },
    setMovedCount: function (v) { mN = v | 0; },
  };
})(typeof globalThis !== "undefined" ? globalThis : this);

/* node 에서 `import` 로 쓸 수 있게 한다. 브라우저는 이 줄을 만나지 않는다. */
if (typeof module !== "undefined" && module.exports) module.exports = globalThis.TalusSim;
