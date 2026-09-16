/* ═══════════════════════════════════════════════════════════════════════════
   Neodeol — 샌드박스 실험 도구  [TOOL]

   프리셋, 계측, 검증 스위트. **여기는 float 를 써도 된다.**
   계측 결과를 시뮬레이션에 되먹이지 않는 것만 지킨다 (절대 규칙 6).

   index.html(브라우저 UI)과 harness.mjs(헤드리스)가 같은 이 파일을 쓴다.
   나눈 이유: 두 곳에 프리셋과 측정을 각각 두면 "브라우저에서는 되는데
   헤드리스에서는 안 되는" 상태가 만들어진다.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  "use strict";
  var S = root.NeodeolSim;
  if (!S) throw new Error("automaton.js 를 먼저 로드해야 한다");

  var W = S.W, H = S.H, N = S.N, grid = S.grid;
  var EMPTY = S.EMPTY, SAND = S.SAND, SOIL = S.SOIL, SCREE = S.SCREE, ROCK = S.ROCK, BEDROCK = S.BEDROCK;

  /* ── 지형 편집 원시 함수 ────────────────────────────────────────────── */
  function fillRect(x0, y0, x1, y1, m) {
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > W - 1) x1 = W - 1;
    if (y1 > H - 1) y1 = H - 1;
    for (var y = y0; y <= y1; y++) {
      var b = y * W;
      for (var x = x0; x <= x1; x++) grid[b + x] = m;
    }
  }
  function isqrt(n) {
    if (n <= 0) return 0;
    var x = n, y = (x + 1) >> 1;
    while (y < x) { x = y; y = (x + Math.floor(n / x)) >> 1; }
    return x;
  }
  /* 정수 값노이즈 0..65535 — 프리셋 생성용. 결정론적이지만 sim 에 들어가지 않는다. */
  function noiseAt(seed, x, shift, salt) {
    var i = x >> shift, f = x - (i << shift);
    var a = S.hash32(seed, i, salt, 0) & 0xFFFF;
    var b = S.hash32(seed, i + 1, salt, 0) & 0xFFFF;
    return a + (((b - a) * f) >> shift);
  }
  function ridge(seed, x, salt, amp, shift) {
    return ((noiseAt(seed, x, shift, salt) - 32768) * amp) >> 16;
  }

  /* ── 대형 붕괴 무대 좌표 (버튼과 프리셋이 공유) ─────────────────────── */
  var LEG = { x0: 470, y0: 356, x1: 489, y1: 469 };
  var COLLAPSE_BLOCK_CELLS = 560 * 232;      // 129,920 = 격자의 25.1%

  var PRESETS = {
    empty: function () { grid.fill(EMPTY); },

    flat: function () {
      grid.fill(EMPTY);
      fillRect(0, 300, W - 1, 317, SAND);
      fillRect(0, 318, W - 1, 400, SOIL);
      fillRect(0, 401, W - 1, 519, ROCK);
      fillRect(0, 520, W - 1, H - 1, BEDROCK);
    },

    /* 지층 노출 확인용 — 파면 아래에서 다른 색이 나온다 (rendering.md §1.1) */
    layers: function () {
      grid.fill(EMPTY);
      var s = S.CFG.seed;
      var bands = [[SAND, 16], [SOIL, 30], [SAND, 10], [SCREE, 14], [SOIL, 44], [ROCK, 26], [SOIL, 22], [ROCK, 60]];
      for (var x = 0; x < W; x++) {
        var y = Math.max(20, 190 + ridge(s, x, 11, 70, 7) + ridge(s, x, 12, 26, 5));
        for (var bi = 0; bi < bands.length; bi++) {
          var m = bands[bi][0], t = bands[bi][1] + ridge(s, x, m * 7 + bands[bi][1], 14, 6);
          for (var k = 0; k < t && y < H; k++, y++) grid[y * W + x] = m;
        }
        for (; y < H; y++) grid[y * W + x] = ROCK;
      }
      fillRect(0, 522, W - 1, H - 1, BEDROCK);
    },

    hills: function () {
      grid.fill(EMPTY);
      var s = S.CFG.seed;
      for (var x = 0; x < W; x++) {
        var top = 250 + ridge(s, x, 3, 150, 8) + ridge(s, x, 4, 46, 6) + ridge(s, x, 5, 14, 4);
        var soilT = top + 20 + ridge(s, x, 6, 18, 6);
        var rockT = soilT + 90 + ridge(s, x, 7, 40, 7);
        for (var y = Math.max(0, top); y < H; y++)
          grid[y * W + x] = y < soilT ? SAND : (y < rockT ? SOIL : ROCK);
      }
      fillRect(0, 524, W - 1, H - 1, BEDROCK);
    },

    /* 다리를 부수면 연결성 검사가 아치 전체를 SCREE 로 바꾼다 — §6.2 */
    arch: function () {
      grid.fill(EMPTY);
      fillRect(0, 524, W - 1, H - 1, BEDROCK);
      var flanks = [[0, 189, 21], [770, W - 1, 22]];
      for (var fi = 0; fi < flanks.length; fi++) {
        for (var x = flanks[fi][0]; x <= flanks[fi][1]; x++) {
          var top = 330 + ridge(S.CFG.seed, x, flanks[fi][2], 30, 6);
          for (var y = Math.max(0, top); y < 524; y++)
            grid[y * W + x] = y < top + 14 ? SAND : (y < top + 70 ? SOIL : ROCK);
        }
      }
      var CX = 480, CY = 430, RO = 200, RI = 152;
      for (var yy = CY - RO; yy <= CY; yy++) {              // 상반원 아치
        var dy = CY - yy, base = yy * W;
        for (var xx = CX - RO; xx <= CX + RO; xx++) {
          var dx = xx - CX, d2 = dx * dx + dy * dy;
          if (d2 <= RO * RO && d2 >= RI * RI) grid[base + xx] = ROCK;
        }
      }
      fillRect(CX - RO, CY + 1, CX - RI, 523, ROCK);        // 왼쪽 다리
      fillRect(CX + RI, CY + 1, CX + RO, 523, ROCK);        // 오른쪽 다리
      for (var x3 = CX - RO; x3 <= CX + RO; x3++) {         // 아치 위 모래 담요
        var kk = RO * RO - (x3 - CX) * (x3 - CX);
        if (kk < 0) continue;
        var t2 = CY - isqrt(kk);
        for (var y3 = Math.max(0, t2 - 30); y3 < t2; y3++) grid[y3 * W + x3] = SAND;
      }
    },

    /* 기둥을 y 250~379 사이에서 끊으면 캔틸레버 슬랩이 SCREE 가 된다 */
    overhang: function () {
      grid.fill(EMPTY);
      fillRect(0, 524, W - 1, H - 1, BEDROCK);
      fillRect(0, 380, 300, 523, ROCK);
      fillRect(0, 356, 300, 379, SOIL);
      fillRect(0, 340, 300, 355, SAND);
      fillRect(300, 250, 340, 523, ROCK);                   // 수직 기둥
      fillRect(341, 250, 720, 286, ROCK);                   // 캔틸레버 슬랩
      fillRect(300, 220, 720, 249, SOIL);
      fillRect(300, 196, 720, 219, SAND);
      fillRect(760, 300, W - 1, 523, ROCK);
      fillRect(760, 276, W - 1, 299, SOIL);
      fillRect(760, 258, W - 1, 275, SAND);
    },

    /* 화면 1/4 규모 (129,920셀 = 25.1%).
       선반(ROCK)이 다리 하나로만 BEDROCK 에 붙어 있다. 다리를 끊으면 §6 이 선반
       전체를 SCREE 로 바꾸고 위의 흙이 통째로 내려온다.
       이 자동자에는 응집력이 없어 SAND/SOIL 만으로는 오버행이 성립하지 않는다 —
       그래서 지지 구조를 ROCK 으로 만들어야 한다. */
    collapse: function () {
      grid.fill(EMPTY);
      fillRect(0, 524, W - 1, H - 1, BEDROCK);
      fillRect(0, 470, W - 1, 523, ROCK);                   // 착지면
      fillRect(200, 340, 759, 355, ROCK);                   // 선반
      fillRect(LEG.x0, LEG.y0, LEG.x1, LEG.y1, ROCK);       // 유일한 지지 다리
      fillRect(200, 108, 759, 239, SOIL);
      fillRect(200, 240, 759, 339, SAND);
    },
  };

  /* ══ 좌우 경계 봉인 ═══════════════════════════════════════════════════
     terrain.md §1.1 — 격자 밖은 EMPTY 라서 최외곽 열의 낙하 재질은 매 스텝
     절반의 확률로 흘러나간다. §1.1 은 "맵 생성기가 좌우 끝을 BEDROCK/ROCK 으로
     막기 때문에 문제되지 않는다"고 적었지만 **막는 코드가 없었다.**

     실측: hills 프리셋을 21,728스텝 정착시키니 x=0 의 표면이 322px → 652px 로
     내려앉았다. 맵 양끝에 300px 깊이의 구멍이 파이고, 그 위로 쏜 포탄이 지형에
     맞지 않고 격자 밖으로 빠져나가 게임이 성립하지 않았다.

     그래서 최외곽 `EDGE_SEAL_COLS` 열을 그 열의 표면부터 바닥까지 BEDROCK 으로 채운다.
     BEDROCK 은 낙하하지 않고 비-EMPTY 장애물이므로, 안쪽 열의 흙이 좌우로 미끄러질
     때 `dir == EMPTY` 조건이 깨져 유출이 원천 차단된다.
     `decisions.md` B1-4 가 이 규칙을 맵 생성 명세에 넣을 것을 요구한다. */
  var EDGE_SEAL_COLS = 2;

  function sealEdges() {
    for (var i = 0; i < EDGE_SEAL_COLS; i++) {
      sealColumn(i, EDGE_SEAL_COLS);                       // 왼쪽
      sealColumn(W - 1 - i, W - 1 - EDGE_SEAL_COLS);       // 오른쪽
    }
  }
  /* 봉인할 열 x 를, 참조 열 ref 의 표면 높이에 맞춰 BEDROCK 으로 채운다.
     자기 열의 표면을 쓰면 이미 비어 있을 수 있어 참조 열을 본다. */
  function sealColumn(x, ref) {
    if (x < 0 || x >= W) return;
    var top = H;
    for (var y = 0; y < H; y++) {
      if (grid[y * W + ref] !== EMPTY) { top = y; break; }
    }
    for (var yy = top; yy < H; yy++) grid[yy * W + x] = BEDROCK;
  }

  function loadPreset(name) {
    (PRESETS[name] || PRESETS.layers)();
    sealEdges();
    S.connectivity();
    S.markAll();
    S.setStep(0);
  }

  /* ══ 정착 (§5.2) ══════════════════════════════════════════════════════
     정착 판정은 "이동 셀 0" 이 아니라 **"이동 가능한 셀 0"** 이다.
     전자는 확률 게이트에 막힌 스텝을 정착으로 오인한다 (automaton.js 머리말 4). */
  function settleHeadless(maxSteps) {
    maxSteps = maxSteps || 20000;
    var t0 = now();
    var steps = 0, moved = 0, r;
    while (steps < maxSteps) {
      r = S.step();
      steps++; moved += r.moved;
      if (r.mobile === 0) break;
    }
    return {
      steps: steps, moved: moved, ms: now() - t0,
      forced: steps >= maxSteps,
      mobileAtEnd: S.getLastMobile(),
    };
  }

  /* ══ 안식각 계측 (§4) ═════════════════════════════════════════════════ */
  function detectFloor() {
    for (var y = 0; y < H; y++) {
      var c = 0, b = y * W;
      for (var x = 0; x < W; x++) if (grid[b + x] === BEDROCK) c++;
      if (c > (W >> 1)) return y;
    }
    return H - 1;
  }
  function surfaceProfile(floorY) {
    var hh = new Int32Array(W);
    for (var x = 0; x < W; x++) {
      var top = -1;
      for (var y = 0; y < floorY; y++) if (grid[y * W + x] !== EMPTY) { top = y; break; }
      hh[x] = top < 0 ? 0 : (floorY - top);
    }
    return hh;
  }
  /* 사면 하나를 최소제곱으로 적합한다.
     정점 반올림과 발끝(toe) 효과를 피해 높이의 22~82% 구간만 쓴다. */
  function fitFlank(hh, apex, dir, maxH) {
    var lo = maxH * 0.22, hi = maxH * 0.82;
    var sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
    for (var x = apex; x >= 0 && x < W; x += dir) {
      var v = hh[x];
      if (v <= 0) break;
      if (v >= lo && v <= hi) { sx += x; sy += v; sxx += x * x; sxy += x * v; n++; }
    }
    if (n < 8) return null;
    var den = n * sxx - sx * sx;
    if (Math.abs(den) < 1e-9) return null;
    var slope = (n * sxy - sx * sy) / den;
    return {
      angle: Math.atan(Math.abs(slope)) * 180 / Math.PI,
      n: n, slope: slope, inter: (sy - slope * sx) / n,
    };
  }
  function measureRepose() {
    var floorY = detectFloor(), hh = surfaceProfile(floorY);
    var apex = 0, maxH = 0;
    for (var x = 0; x < W; x++) if (hh[x] > maxH) { maxH = hh[x]; apex = x; }
    if (maxH < 12) return { ok: false, maxH: maxH, floorY: floorY, reason: "더미가 12셀 미만" };
    var L = fitFlank(hh, apex, -1, maxH), R = fitFlank(hh, apex, +1, maxH);
    /* 열 간 낙차 분포 — 규칙 2 만 쓰면 |낙차| ≤ 1 이어야 한다. 검산용. */
    var x0 = W, x1 = 0;
    for (var i = 0; i < W; i++) if (hh[i] > 0) { if (i < x0) x0 = i; if (i > x1) x1 = i; }
    var maxDrop = 0;
    for (var j = x0; j < x1; j++) {
      var d = Math.abs(hh[j + 1] - hh[j]);
      if (d > maxDrop) maxDrop = d;
    }
    return {
      ok: true, floorY: floorY, apex: apex, maxH: maxH,
      toe: [x0, x1], width: x1 - x0, maxDrop: maxDrop,
      L: L, R: R,
      angle: (L && R) ? (L.angle + R.angle) / 2 : (L ? L.angle : (R ? R.angle : null)),
    };
  }

  /* 안식각 시험 더미: 기둥으로 쌓아 무너뜨린다.
     최종 더미가 확실히 삼각형이 되도록 기둥 폭을 잡는다 (h_초기 ≈ 2 × h_최종). */
  function buildPile(mat, cells) {
    grid.fill(EMPTY);
    fillRect(0, 500, W - 1, H - 1, BEDROCK);
    var w = Math.max(20, Math.min(400, Math.round(Math.sqrt(cells / 2))));
    var h = Math.min(496, Math.round(cells / w));
    var x0 = (W >> 1) - (w >> 1);
    fillRect(x0, 500 - h, x0 + w - 1, 499, mat);
    S.connectivity();
    S.markAll();
    S.setStep(0);
    return { w: w, h: h, cells: w * h };
  }

  /* ══ 검증 스위트 ══════════════════════════════════════════════════════ */
  function runN(n) {
    for (var k = 0; k < n; k++) S.step();
    return S.checksum();
  }

  function testRepro(steps) {
    var s = S.snapshot();
    var a = runN(steps), ma = S.massCount();
    S.restore(s);
    var b = runN(steps), mb = S.massCount();
    S.restore(s);
    return { pass: a === b && ma === mb, a: a, b: b, massA: ma, massB: mb };
  }

  function testOrder(steps) {
    var s = S.snapshot();
    S.setOrder(S.ORD_FWD, true);   var a = runN(steps); S.restore(s);
    S.setOrder(S.ORD_REV, false);  var b = runN(steps); S.restore(s);
    S.setOrder(S.ORD_SPLIT, true); var c = runN(steps); S.restore(s);
    S.setOrder(S.ORD_FWD, true);
    return { pass: a === b && a === c, fwd: a, rev: b, split: c };
  }

  function testTies(steps) {
    var s = S.snapshot();
    S.setTieWatch(true);
    runN(steps);
    S.setTieWatch(false);
    var t = S.getTieCount();
    S.restore(s);
    return { pass: t === 0, ties: t };
  }

  /* 활성 행 최적화가 이동 가능한 셀을 놓치지 않는지.
     step() 이 센 mobile 과 격자 전체 스캔이 일치해야 한다.
     어긋나면 §5.1 활성 집합이 셀을 굶기고 있다 (거짓 정착의 원인). */
  function testMobileConsistency(steps) {
    var s = S.snapshot();
    var worst = 0, bad = 0, firstBad = null;
    for (var k = 0; k < steps; k++) {
      /* 순서가 중요하다. step() 의 mobile 은 **이동 전** 격자를 센 값이므로
         전체 스캔도 이동 전에 해야 한다. 스텝 뒤에 스캔하면 다른 격자를 비교한다. */
      var full = S.countMobile().total;
      var r = S.step();
      if (r.mobile !== full) {
        bad++;
        var gap = Math.abs(full - r.mobile);
        if (gap > worst) worst = gap;
        if (firstBad === null) firstBad = { step: k, scan: full, counted: r.mobile };
      }
    }
    S.restore(s);
    return { pass: bad === 0, mismatchSteps: bad, worstGap: worst, steps: steps, firstBad: firstBad };
  }

  /* 해시 품질 — 방향 선택이 무작위인지.
     FNV-1a 만 쓰면 bit0 이 입력 비트의 XOR 패리티라 100% 예측 가능하고,
     step 을 1 올리면 격자 전체 방향이 동시에 반전한다. 확산 단계가 이걸 없앤다. */
  function testHashQuality(samples) {
    samples = samples || 200000;
    var par = function (a) { return ((a ^ (a >>> 8) ^ (a >>> 16) ^ (a >>> 24)) & 1); };
    var seed = S.CFG.seed;
    var linear = 0, ones = 0;
    for (var t = 0; t < samples; t++) {
      var x = (t * 37) % W, y = (t * 53) % H;
      var v = (seed ^ Math.imul(x, 0x9E3779B1) ^ Math.imul(y, 0x85EBCA77) ^ Math.imul(t, 0xC2B2AE3D)) >>> 0;
      var h = S.hash32(seed, x, y, t);
      if ((h & 1) === (1 ^ par(v))) linear++;
      ones += h & 1;
    }
    /* 같은 행에서 step 을 올릴 때 방향 패턴이 통째로 뒤집히는지 */
    var flipRates = [];
    for (var st = 0; st < 6; st++) {
      var flips = 0;
      for (var xx = 300; xx < 700; xx++) {
        if ((S.hash32(seed, xx, 400, st) & 1) !== (S.hash32(seed, xx, 400, st + 1) & 1)) flips++;
      }
      flipRates.push(flips / 400);
    }
    /* 공간 상관: 인접 x 의 방향 비트가 같은 비율 (0.5 가 이상적) */
    var same = 0, tot = 0;
    for (var y2 = 0; y2 < H; y2 += 7) {
      for (var x2 = 0; x2 < W - 1; x2++) {
        if ((S.hash32(seed, x2, y2, 11) & 1) === (S.hash32(seed, x2 + 1, y2, 11) & 1)) same++;
        tot++;
      }
    }
    return {
      linearPredictRate: linear / samples,       // 0.5 근처여야 한다. 1.0 이면 선형
      bit0OnesRate: ones / samples,              // 0.5 근처
      stepFlipRates: flipRates,                  // 각각 0.5 근처. 0 이나 1 이면 전역 반전
      neighbourSameRate: same / tot,             // 0.5 근처
      pass: Math.abs(linear / samples - 0.5) < 0.02
         && Math.abs(ones / samples - 0.5) < 0.01
         && flipRates.every(function (r) { return Math.abs(r - 0.5) < 0.05; })
         && Math.abs(same / tot - 0.5) < 0.02,
    };
  }

  function now() {
    return (typeof performance !== "undefined" && performance.now)
      ? performance.now() : Number(process.hrtime.bigint() / 1000n) / 1000;
  }

  root.NeodeolLab = {
    fillRect: fillRect, isqrt: isqrt, ridge: ridge,
    PRESETS: PRESETS, loadPreset: loadPreset, LEG: LEG,
    sealEdges: sealEdges, EDGE_SEAL_COLS: EDGE_SEAL_COLS,
    COLLAPSE_BLOCK_CELLS: COLLAPSE_BLOCK_CELLS,
    settleHeadless: settleHeadless,
    detectFloor: detectFloor, surfaceProfile: surfaceProfile,
    fitFlank: fitFlank, measureRepose: measureRepose, buildPile: buildPile,
    runN: runN,
    testRepro: testRepro, testOrder: testOrder, testTies: testTies,
    testMobileConsistency: testMobileConsistency, testHashQuality: testHashQuality,
    now: now,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);

if (typeof module !== "undefined" && module.exports) module.exports = globalThis.NeodeolLab;
