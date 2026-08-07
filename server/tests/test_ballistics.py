"""탄도 이식 검증 — `client/src/sim/ballistics.ts` 와 같은 수를 내는가.

`docs/simulation.md` §8.1 의 사거리 표가 기준이다. 표는 `tools/ballistics-check.mjs`
가 정수 적분으로 실제 계산해 채운 것이므로, 여기가 어긋나면 **문서가 맞고 코드가 틀렸다.**

교차 검증(`test_cross_sim.py`)이 지형만 대조하는 이유는 골든 리플레이 포맷이 아직
지형 전용(`kind: "terrain-only"` / `"terrain-turns"`)이기 때문이다. 탄도까지 담는
리플레이는 `match.py` 가 생기면 추가한다 — 그때까지 이 파일이 그 자리를 메운다.
"""

from __future__ import annotations

import pathlib

import pytest

from talus.sim import ballistics as B
from talus.sim import trig


def _find_repo_root() -> pathlib.Path | None:
    here = pathlib.Path(__file__).resolve()
    for p in (here, *here.parents):
        if (p / "CLAUDE.md").is_file() or (p / "tables").is_dir():
            return p
    return None


REPO = _find_repo_root()
TRIG_BIN = (REPO / "tables" / "trig.bin") if REPO else None

pytestmark = pytest.mark.skipif(
    TRIG_BIN is None or not TRIG_BIN.is_file(),
    reason="tables/trig.bin 을 못 찾았다",
)


@pytest.fixture(autouse=True)
def _load() -> None:
    if not trig.is_loaded():
        trig.load_trig(TRIG_BIN.read_bytes())  # type: ignore[union-attr]


@pytest.mark.determinism
def test_flat_range_matches_doc_table() -> None:
    """평지 사거리가 `simulation.md` §8.1 과 일치한다.

    1,899 px 는 TS 쪽 `client/tests/determinism.mts` §7 이 내는 값과 **같은 수**여야 한다.
    두 언어가 여기서 1 px 이라도 갈라지면 같은 조준이 다른 곳에 떨어진다.
    """
    assert B.flat_range_px(450, 1000, 0) == 1899, "최대 파워 45° 사거리"


@pytest.mark.determinism
def test_range_is_quadratic_in_power() -> None:
    """항력이 0 이므로 파워 절반이면 사거리는 1/4 이다 (§8.1).

    이게 깨지면 `drag_q16` 이 0 이 아니거나 세분화(§4.3)가 잔차를 흘리고 있다.
    """
    full = B.flat_range_px(450, 1000, 0)
    half = B.flat_range_px(450, 500, 0)
    # 정수 절단 때문에 정확히 1/4 은 아니다. 24~25% 안에 들어와야 한다
    assert 24 * full <= half * 100 <= 25 * full, f"{half}/{full} = {half * 100 // full}%"


@pytest.mark.determinism
def test_range_is_symmetric_about_45deg() -> None:
    """30° 와 60° 의 사거리가 비슷하다 — 대칭성이 깨지면 삼각표가 어긋난 것이다."""
    a30 = B.flat_range_px(300, 1000, 0)
    a60 = B.flat_range_px(600, 1000, 0)
    assert abs(a30 - a60) * 20 <= a30, f"30° {a30} vs 60° {a60} — 대칭이 심하게 깨졌다"
    assert a30 < B.flat_range_px(450, 1000, 0), "45° 가 최대여야 한다"


@pytest.mark.determinism
def test_wind_pushes_both_ways() -> None:
    """바람이 좌우 대칭으로 먹는다."""
    base = B.flat_range_px(450, 1000, 0)
    assert B.flat_range_px(450, 1000, 2) > base
    assert B.flat_range_px(450, 1000, -2) < base


@pytest.mark.determinism
def test_ballistics_fits_int32() -> None:
    """중간값이 int32 를 넘지 않는다.

    TS 의 ``>>`` 는 int32 로 절단하는데 Python 정수는 무한 정밀도다. 넘는 순간
    **두 구현이 조용히 갈라진다** — 그리고 그건 상수를 키울 때 일어난다.
    ``ballistics.py`` 모듈 docstring 의 표와 같은 계산이다.
    """
    limit = 1 << 31
    v0 = (1000 * B.CFG.power_scale) >> 10
    assert v0 * trig.TRIG_SCALE < limit, "v0 * COS 가 int32 를 넘는다"
    # vx * k — k 는 steps 이하이고 steps 는 (|vx|+|vy|)>>5 + 1
    length = 2 * v0
    steps = (length >> B.CELL_SHIFT) + 1
    assert v0 * steps < limit, "vx * k 가 int32 를 넘는다"
    # 피해 계산의 거리 제곱
    assert B.MAP_W_SUB**2 + B.MAP_H_SUB**2 < limit, "dx²+dy² 가 int32 를 넘는다"


@pytest.mark.determinism
def test_shot_is_reproducible() -> None:
    """같은 입력이 같은 궤적을 낸다. 100회."""
    from talus.sim import terrain as T

    T.grid.fill(T.EMPTY)
    T.grid.reshape(T.H, T.W)[400:, :] = T.ROCK

    def once() -> tuple:
        r = B.simulate_shot(2000, 12000, 450, 800, 1, 0, None, False)
        return (len(r.path), r.hit, r.hit_x, r.hit_y, r.path[-1])

    base = once()
    assert base[1] == "terrain", f"평지에 쐈는데 {base[1]} 로 끝났다"
    assert base[0] > 5, "궤적이 너무 짧다"
    for i in range(1, 100):
        assert once() == base, f"{i}회차에서 궤적이 갈라졌다"


@pytest.mark.determinism
def test_reseat_drops_tank_onto_terrain() -> None:
    """지형이 깎이면 탱크가 그 위로 내려앉는다 (§6.1)."""
    from talus.sim import terrain as T

    T.grid.fill(T.EMPTY)
    T.grid.reshape(T.H, T.W)[400:, :] = T.ROCK

    tank = B.make_tank(0, 5000, "t")
    assert tank.y == 400 * B.CELL_SUBPX, "지표면 위에 놓여야 한다"

    T.grid.reshape(T.H, T.W)[400:450, :] = T.EMPTY  # 발밑을 50셀 파낸다
    fall = B.reseat_tank(tank)
    assert tank.y == 450 * B.CELL_SUBPX, f"내려앉지 않았다: y={tank.y}"
    assert fall == (50 * B.CELL_SUBPX) >> B.PX_SHIFT, f"낙하 픽셀이 다르다: {fall}"
    assert B.fall_damage(fall) > 0, "100 px 낙하는 피해가 있어야 한다"


@pytest.mark.determinism
def test_damage_is_computed_before_application() -> None:
    """`compute_damage` 는 계산만 하고 탱크를 건드리지 않는다 (§5.2).

    순차 적용하면 먼저 밀린 탱크가 뒤 폭발을 피해 **슬롯 순서가 유불리를 만든다.**
    """
    from talus.sim import terrain as T

    T.grid.fill(T.EMPTY)
    tanks = [B.make_tank(0, 5000, "a"), B.make_tank(1, 5100, "b")]
    before = [(t.hp, t.x, t.y) for t in tanks]
    w = B.WeaponDamage(max_damage=100, blast_radius=1024, damage_shift=10)
    hits = B.compute_damage(5000, tanks[0].y - (B.TANK_H >> 1), w, tanks)
    assert [(t.hp, t.x, t.y) for t in tanks] == before, "compute_damage 가 상태를 바꿨다"
    assert hits and hits[0].idx == 0 and hits[0].dmg > 0
    # 가까울수록 아프다
    assert all(a.dmg >= b.dmg for a, b in zip(hits, hits[1:], strict=False)) or len(hits) < 2
