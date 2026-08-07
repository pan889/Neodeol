"""모래 붕괴 자동자 — numpy 벡터 구현.  `docs/terrain.md` §1~§8

`client/src/sim/terrain.ts` 의 **1:1 번역이며 창의성을 발휘하지 않는다**
(`docs/roadmap.md` Phase 3). 규칙을 다시 설계하면 Phase 0 의 실측 검증이 무효가 된다.
여기서 하는 유일한 창의는 **같은 규칙을 벡터로 표현하는 방법**이다.

────────────────────────────────────────────────────────────────────────────
벡터화가 왜 성립하는가

`terrain.md` §3 이 제안/해소를 **순서 독립**으로 정의했기 때문이다.
제안 단계가 격자를 읽기만 하므로 전 셀을 동시에 평가할 수 있고, 해소가
"목표별 최댓값 승자"라서 ``np.maximum.at`` 한 번으로 끝난다.
순서 의존 규칙이었다면 numpy 로 옮기는 것 자체가 불가능했다.

────────────────────────────────────────────────────────────────────────────
TS 와 비트 단위로 같게 만들기 위해 지킨 것

* uint32 랩어라운드 곱셈이 JS ``Math.imul`` 과 일치한다 (`intmath.py` 참조)
* uint32 의 ``>>`` 는 논리 시프트다 — 해시가 JS ``>>>`` 와 같다
* 우선순위는 int32 범위 안에 들어간다 (최대 ``3 << 17 = 393216``)
* 정적 게이트 해시는 ``step`` 을 안 쓰므로 **시드가 바뀔 때 한 번만** 계산한다.
  이건 최적화이지 규칙 변경이 아니다 — 값이 같다
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import numpy.typing as npt
from scipy import ndimage

from .intmath import U32, fnv1a32, hash32

# ── 격자 (§1) ───────────────────────────────────────────────────────────
W = 960
H = 540
N = W * H

# ── 재질 (§2) ───────────────────────────────────────────────────────────
EMPTY = 0
SAND = 1
SOIL = 2
SCREE = 3
ROCK = 4
BEDROCK = 5
MATERIAL_NAME = ("EMPTY", "SAND", "SOIL", "SCREE", "ROCK", "BEDROCK")

VOID = -1  # 격자 밖 목표. §1.1 — 떨어져 나가면 소멸한다

# 해소 우선순위 가중치 — 큰 값이 이긴다. **규칙번호의 역순이다** (§3.2)
RW_FALL = 3
RW_DIAG = 2
RW_CREEP = 1
PRIO_FALL = RW_FALL << 17

ORD_FWD = 0
ORD_REV = 1
ORD_SPLIT = 2


@dataclass
class TerrainConfig:
    """`client/src/sim/terrain.ts` 의 `CFG` 와 같은 값을 유지한다."""

    slide_sand_q8: int = 256   # 26.6°
    slide_soil_q8: int = 48    # 40.3°
    slide_scree_q8: int = 0    # 44.2° (규칙 3 미적용)
    seed: int = 0x55
    # `BEDROCK` 키가 **없는 것이 규칙**이다 — 0 은 무적이 아니라 "반경 0" 이다 (§8)
    blast_resist_q8: dict[int, int] = field(
        default_factory=lambda: {SAND: 256, SOIL: 208, SCREE: 256, ROCK: 140}
    )
    both_directions: bool = False   # decisions.md A2 확정
    slide_gate_static: bool = True  # decisions.md A1 확정


CFG = TerrainConfig()

# ── 상태 ─────────────────────────────────────────────────────────────────
grid: npt.NDArray[np.uint8] = np.zeros(N, dtype=np.uint8)
row_active: npt.NDArray[np.bool_] = np.zeros(H, dtype=bool)
_sim_step = 0
_last_moved = 0
_last_mobile = 0

# 좌표 격자는 한 번만 만든다
_YY, _XX = np.meshgrid(
    np.arange(H, dtype=np.uint32), np.arange(W, dtype=np.uint32), indexing="ij"
)
_XX_FLAT = _XX.ravel()
_YY_FLAT = _YY.ravel()
_IDX = np.arange(N, dtype=np.int64)

# 정적 게이트 마스크 — 시드/확률이 바뀔 때만 다시 만든다 (§4.2)
_gate_key: tuple[int, int, int, int] | None = None
_gate_ok: npt.NDArray[np.bool_] | None = None


def _grid2d() -> npt.NDArray[np.uint8]:
    return grid.reshape(H, W)


def _slide_threshold(mat: int) -> int:
    if mat == SAND:
        return CFG.slide_sand_q8 << 8
    if mat == SOIL:
        return CFG.slide_soil_q8 << 8
    return CFG.slide_scree_q8 << 8


def _gate_mask() -> npt.NDArray[np.bool_]:
    """정적 게이트 통과 여부. 재질별로 임계가 달라 `(6, N)` 로 만든다.

    ``step`` 을 안 쓰므로 시드·확률이 그대로면 재사용한다. 이건 최적화이고
    값은 매번 계산한 것과 같다 — TS 는 매 셀 계산하지만 결과가 동일하다.
    """
    global _gate_key, _gate_ok
    key = (CFG.seed, CFG.slide_sand_q8, CFG.slide_soil_q8, CFG.slide_scree_q8)
    if _gate_key == key and _gate_ok is not None:
        return _gate_ok
    h = hash32(CFG.seed ^ 0x9E3779B9, _XX_FLAT, _YY_FLAT, 0)
    gv = ((h >> U32(8)) & U32(0xFFFF)).astype(np.int64)
    ok = np.zeros((6, N), dtype=bool)
    for mat in (SAND, SOIL, SCREE):
        ok[mat] = gv < _slide_threshold(mat)
    _gate_key = key
    _gate_ok = ok
    return ok


def reset_gate_cache() -> None:
    """`CFG` 를 직접 수정했을 때 부른다."""
    global _gate_key
    _gate_key = None


# ── 활성 행 (§5.1) ───────────────────────────────────────────────────────
def mark_rows(a: int, b: int) -> None:
    a = max(a, 0)
    b = min(b, H - 1)
    if a <= b:
        row_active[a : b + 1] = True


def mark_all() -> None:
    row_active[:] = True


def clear_active() -> None:
    row_active[:] = False


def active_row_count() -> int:
    return int(row_active.sum())


def checksum() -> int:
    """§7.2 — 격자 전체를 idx 오름차순으로 FNV-1a."""
    return fnv1a32(grid.tobytes())


def mass_count() -> int:
    return int(np.count_nonzero(grid))


def get_step() -> int:
    return _sim_step


def set_step(v: int) -> None:
    global _sim_step
    _sim_step = int(v)


def get_last_moved() -> int:
    return _last_moved


def get_last_mobile() -> int:
    return _last_mobile


_resolve_order = ORD_FWD
_propose_bottom_up = True


def set_order(ro: int, bottom_up: bool) -> None:
    """자기검증 전용. 결과가 달라지면 절대 규칙 3 위반이다.

    벡터 구현에서는 순회 순서 자체가 없다 — ``np.maximum.at`` 은 순서에
    무관하다. 그래서 이 설정을 받아도 **결과가 바뀌지 않는 것이 정상**이고,
    그 사실 자체가 순서 독립성의 증거다.
    """
    global _resolve_order, _propose_bottom_up
    _resolve_order = ro
    _propose_bottom_up = bottom_up


@dataclass(slots=True)
class StepResult:
    moved: int
    mobile: int


def step() -> StepResult:
    """자동자 한 스텝. `docs/terrain.md` §3.

    반환의 ``mobile`` 이 0 이면 정착이다 — 근사가 아니라 **정확한 판정**이다 (§5.2).
    """
    global _sim_step, _last_moved, _last_mobile

    st = _sim_step
    seed = CFG.seed
    g2 = _grid2d()

    # ── 활성 행 밴드로 좁힌다 ────────────────────────────────────────────
    # 전 격자를 매 스텝 돌 이유가 없다. 후보는 `act` 로 **정확한 행 집합**을 AND
    # 하므로, 중간 배열을 활성 행을 포함하는 연속 밴드에서 계산해도 결과가 같다.
    # (§5.1 이 금지한 것은 *규칙 적용 대상*의 과대 포함이지 중간 계산 범위가 아니다)
    rows = np.flatnonzero(row_active)
    if rows.size == 0:
        _last_moved = 0
        _last_mobile = 0
        _sim_step = (_sim_step + 1) & 0xFFFFFFFF
        return StepResult(moved=0, mobile=0)
    b0 = int(rows[0])
    b1 = int(rows[-1]) + 1
    nb = b1 - b0
    base = b0 * W

    gb = g2[b0:b1]
    below = np.empty_like(gb)
    if nb > 1:
        below[:-1] = g2[b0 + 1 : b1]
    below[-1] = g2[b1] if b1 < H else EMPTY

    def _shift_l(a):
        o = np.empty_like(a)
        o[:, 1:] = a[:, :-1]
        o[:, 0] = EMPTY
        return o

    def _shift_r(a):
        o = np.empty_like(a)
        o[:, :-1] = a[:, 1:]
        o[:, -1] = EMPTY
        return o

    def _shift_l2(a):
        o = np.empty_like(a)
        o[:, 2:] = a[:, :-2]
        o[:, :2] = EMPTY
        return o

    def _shift_r2(a):
        o = np.empty_like(a)
        o[:, :-2] = a[:, 2:]
        o[:, -2:] = EMPTY
        return o

    left = _shift_l(gb)
    right = _shift_r(gb)
    below_left = _shift_l(below)
    below_right = _shift_r(below)
    left2 = _shift_l2(gb)
    right2 = _shift_r2(gb)
    below_left2 = _shift_l2(below)
    below_right2 = _shift_r2(below)

    col = _COL[:nb]
    x_is_0 = col == 0
    x_is_last = col == W - 1
    y_is_last = np.zeros((nb, W), dtype=bool)
    if b1 == H:
        y_is_last[-1, :] = True

    # ── 후보 ────────────────────────────────────────────────────────────
    act = row_active[b0:b1][:, None]
    is_fall = (gb >= SAND) & (gb <= SCREE)
    cand = is_fall & act

    r1 = cand & (below == EMPTY)
    rest = cand & ~r1 & ((left == EMPTY) | (right == EMPTY))

    gate = _gate_mask().reshape(6, H, W)
    r3ok = np.zeros((nb, W), dtype=bool)
    for mat in (SAND, SOIL, SCREE):
        if _slide_threshold(mat) == 0:
            continue
        sel = gb == mat
        r3ok |= sel & (gate[mat, b0:b1] if CFG.slide_gate_static else True)

    l_open = (left == EMPTY) | x_is_0
    l_r2 = rest & l_open & ((below_left == EMPTY) | x_is_0)
    l_r3 = (
        rest & l_open & ~l_r2 & r3ok
        & ((left2 == EMPTY) | (col < 2))
        & ((below_left2 == EMPTY) | (col < 2))
    )
    r_open = (right == EMPTY) | x_is_last
    r_r2 = rest & r_open & ((below_right == EMPTY) | x_is_last)
    r_r3 = (
        rest & r_open & ~r_r2 & r3ok
        & ((right2 == EMPTY) | (col >= W - 2))
        & ((below_right2 == EMPTY) | (col >= W - 2))
    )

    l_any = l_r2 | l_r3
    r_any = r_r2 | r_r3

    # ── 가동 판정 (§5.1) — 이동한 셀이 아니라 **이동할 수 있는 셀** ────
    mobile_mask = r1 | l_any | r_any
    mobile = int(mobile_mask.sum())

    rows_with = np.flatnonzero(mobile_mask.any(axis=1)) + b0
    nxt = np.zeros(H, dtype=bool)
    for d in (-1, 0, 1, 2):
        if rows_with.size:
            rr = rows_with + d
            rr = rr[(rr >= 0) & (rr < H)]
            nxt[rr] = True

    # ── 방향 선택 (§7.1: h & 1). 한 방향만 시도한다 (A2 확정) ──────────
    sel_flat = np.flatnonzero((l_any | r_any).ravel())
    src_list: list[npt.NDArray[np.int64]] = []
    dst_list: list[npt.NDArray[np.int64]] = []
    prio_list: list[npt.NDArray[np.int64]] = []

    r1_flat = np.flatnonzero(r1.ravel())
    if r1_flat.size:
        falls_out = y_is_last.ravel()[r1_flat]
        keep = ~falls_out
        if keep.any():
            s = r1_flat[keep] + base
            src_list.append(s)
            dst_list.append(s + W)
            prio_list.append(np.full(s.size, PRIO_FALL, dtype=np.int64))
        void_src_r1 = r1_flat[falls_out] + base
    else:
        void_src_r1 = np.empty(0, dtype=np.int64)

    void_src_dir = np.empty(0, dtype=np.int64)
    if sel_flat.size:
        sx = (sel_flat % W).astype(np.int64)
        sy = (sel_flat // W).astype(np.int64) + b0
        h = hash32(seed, sx.astype(np.uint32), sy.astype(np.uint32), st)
        side = (h & U32(1)).astype(np.int64)

        lr2 = l_r2.ravel()[sel_flat]
        lr3 = l_r3.ravel()[sel_flat]
        rr2 = r_r2.ravel()[sel_flat]
        rr3 = r_r3.ravel()[sel_flat]
        l_rule = np.where(lr2, 2, np.where(lr3, 3, 0))
        r_rule = np.where(rr2, 2, np.where(rr3, 3, 0))

        rule = np.where(side == 1, r_rule, l_rule)
        used = side.copy()
        if CFG.both_directions:
            fb = rule == 0
            rule = np.where(fb, np.where(side == 1, l_rule, r_rule), rule)
            used = np.where(fb, 1 - side, side)

        ok = rule != 0
        if ok.any():
            gsrc = sel_flat[ok] + base
            ru = rule[ok]
            us = used[ok]
            hh = h[ok]
            gx = sx[ok]
            gy = sy[ok]
            dirv = np.where(us == 1, 1, -1)
            d_row = np.where(ru == 3, gy, gy + 1)
            d_col = gx + dirv
            out_of_grid = (d_col < 0) | (d_col >= W) | (d_row >= H)

            inb = ~out_of_grid
            if inb.any():
                dcol = d_col[inb]
                drow = d_row[inb]
                flip = (
                    hash32(seed, dcol.astype(np.uint32), drow.astype(np.uint32), st)
                    & U32(1)
                ).astype(np.int64)
                weight = np.where(ru[inb] == 3, RW_CREEP, RW_DIAG)
                src_list.append(gsrc[inb])
                dst_list.append(drow * W + dcol)
                prio_list.append(
                    (weight << 17)
                    | (((us[inb] ^ flip) & 1) << 16)
                    | (hh[inb] & U32(0xFFFF)).astype(np.int64)
                )
            void_src_dir = gsrc[out_of_grid]

    # ── 해소 (§3.2) — 목표별 최댓값 승자 ────────────────────────────────
    if src_list:
        src = np.concatenate(src_list)
        dst = np.concatenate(dst_list)
        prio = np.concatenate(prio_list)
        best = np.zeros(N, dtype=np.int64)
        np.maximum.at(best, dst, prio)
        win = prio == best[dst]
        wsrc = src[win]
        wdst = dst[win]
    else:
        wsrc = np.empty(0, dtype=np.int64)
        wdst = np.empty(0, dtype=np.int64)

    # ── 커밋 (§3.3) — 전부 비운 뒤 전부 쓴다 ────────────────────────────
    void_src = np.concatenate([void_src_r1, void_src_dir])
    mats_moved = grid[wsrc].copy()
    grid[wsrc] = EMPTY
    grid[void_src] = EMPTY
    grid[wdst] = mats_moved

    row_active[:] = nxt
    _last_moved = int(wsrc.size + void_src.size)
    _last_mobile = mobile
    _sim_step = (_sim_step + 1) & 0xFFFFFFFF
    return StepResult(moved=_last_moved, mobile=mobile)


_COL = np.arange(W)[None, :].repeat(H, axis=0)


def _col_lt(v: int) -> npt.NDArray[np.bool_]:
    return _COL < v


def _col_ge(v: int) -> npt.NDArray[np.bool_]:
    return _COL >= v


# ══ 폭발 카빙 (§8) ═══════════════════════════════════════════════════════
def carve(cx: int, cy: int, radius_cells: int) -> tuple[int, int]:
    """반환 ``(removed, conv)``."""
    y0 = max(0, cy - radius_cells)
    y1 = min(H - 1, cy + radius_cells)
    x0 = max(0, cx - radius_cells)
    x1 = min(W - 1, cx + radius_cells)
    if y0 > y1 or x0 > x1:
        return 0, 0

    g2 = _grid2d()
    sub = g2[y0 : y1 + 1, x0 : x1 + 1]
    yy = np.arange(y0, y1 + 1)[:, None] - cy
    xx = np.arange(x0, x1 + 1)[None, :] - cx
    d2 = yy * yy + xx * xx

    remove = np.zeros(sub.shape, dtype=bool)
    for mat, resist in CFG.blast_resist_q8.items():
        rm = (radius_cells * resist) >> 8
        remove |= (sub == mat) & (d2 <= rm * rm)
    # `BEDROCK` 은 표에 없으므로 자동으로 제외된다 — 0 을 넣으면 중심 1셀이 지워진다

    removed = int(remove.sum())
    hit_rock = bool(((sub == ROCK) & remove).any())
    sub[remove] = EMPTY
    mark_rows(y0 - 2, y1 + 2)
    conv = connectivity() if hit_rock else 0
    return removed, conv


# ══ 흙 쌓기 (§8.1) ═══════════════════════════════════════════════════════
def deposit(cx: int, cy: int, radius_cells: int, mat: int) -> int:
    y0 = max(0, cy - radius_cells)
    y1 = min(H - 1, cy + radius_cells)
    x0 = max(0, cx - radius_cells)
    x1 = min(W - 1, cx + radius_cells)
    if y0 > y1 or x0 > x1:
        return 0
    g2 = _grid2d()
    sub = g2[y0 : y1 + 1, x0 : x1 + 1]
    yy = np.arange(y0, y1 + 1)[:, None] - cy
    xx = np.arange(x0, x1 + 1)[None, :] - cx
    fill = (sub == EMPTY) & (yy * yy + xx * xx <= radius_cells * radius_cells)
    filled = int(fill.sum())
    sub[fill] = mat
    mark_rows(y0 - 2, y1 + 2)
    return filled


# ══ 암반 구조 붕괴 (§6) ══════════════════════════════════════════════════
_STRUCT4 = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], dtype=bool)


def connectivity() -> int:
    """`BEDROCK` 에서 4방향으로 못 닿는 `ROCK` 을 `SCREE` 로 바꾼다.

    `scipy.ndimage.label` 을 쓴다. §6.1 이 "결과 집합만 같으면 되고 **라벨링
    순서는 상관없다**"고 명시했으므로 TS 의 스택 flood fill 과 구현이 달라도 된다.
    """
    g2 = _grid2d()
    rocky = (g2 == ROCK) | (g2 == BEDROCK)
    if not rocky.any():
        return 0
    labels, n = ndimage.label(rocky, structure=_STRUCT4)
    if n == 0:
        return 0
    anchored = np.zeros(n + 1, dtype=bool)
    anchored[np.unique(labels[g2 == BEDROCK])] = True
    anchored[0] = True  # 배경
    floating = (g2 == ROCK) & ~anchored[labels]
    conv = int(floating.sum())
    if conv:
        g2[floating] = SCREE
        rows = np.flatnonzero(floating.any(axis=1))
        mark_rows(int(rows[0]) - 1, int(rows[-1]) + 1)
    return conv


# ══ 진단 — 격자 전체에서 이동 가능한 셀을 센다 ═══════════════════════════
def count_mobile() -> int:
    """`step()` 의 ``mobile`` 과 어긋나면 활성 행이 셀을 굶기고 있다는 뜻이다."""
    saved = row_active.copy()
    mark_all()
    g_before = grid.copy()
    st_before = _sim_step
    r = step()
    grid[:] = g_before
    set_step(st_before)
    row_active[:] = saved
    return r.mobile


# ══ 스냅샷 ═══════════════════════════════════════════════════════════════
def snapshot() -> tuple[npt.NDArray[np.uint8], int, npt.NDArray[np.bool_]]:
    return grid.copy(), _sim_step, row_active.copy()


def restore(snap: tuple[npt.NDArray[np.uint8], int, npt.NDArray[np.bool_]]) -> None:
    g, st, ra = snap
    grid[:] = g
    set_step(st)
    row_active[:] = ra
