"""지질 구역의 실측 성질을 고정한다 — `docs/mapgen.md` §4.

이 파일은 "지층을 만졌을 때 무엇이 깨지면 안 되는가"를 잡는다. 특히 **초기 정착 예산**은
`create_match` 가 상한을 넘으면 예외를 던져 **매치가 아예 안 만들어지므로**, 여유가
사라지는 것을 조용히 넘기면 안 된다.
"""

from __future__ import annotations

import numpy as np
import pytest

from talus import constants
from talus.sim import mapgen as M
from talus.sim import terrain as T

SEEDS = [0x1000 + i * 7919 for i in range(10)]


def _load(map_seed: int) -> None:
    T.CFG.seed = map_seed
    T.reset_gate_cache()
    T.grid[:] = M.build_map(map_seed)


def _settle(limit: int = 40000) -> int:
    for step in range(1, limit + 1):
        if T.step().mobile == 0:
            return step
    return -1


@pytest.mark.determinism
@pytest.mark.parametrize("map_seed", SEEDS)
def test_initial_settle_stays_far_under_the_cap(map_seed: int) -> None:
    """생성 직후 지형은 거의 정착해 있다.

    **표면 형상을 안 건드리는 것이 지질 구역 설계의 핵심**이고, 이 검사가 그걸 지킨다.
    지층 두께만 바뀌면 새로 노출되는 경사가 없어 정착 비용이 안 는다 (실측 최악 9스텝).
    여기가 무너지면 `create_match` 가 `RuntimeError` 를 던져 방 생성이 실패한다.
    """
    _load(map_seed)
    T.connectivity()
    T.mark_all()
    T.set_step(0)
    steps = _settle()
    assert steps > 0, "정착하지 않았다"
    # 상한의 1% 이내여야 한다. 실측 최악 9 / 12000
    assert steps <= constants.MAX_SETTLE_STEPS // 100, (
        f"초기 정착이 {steps} 스텝이다 (상한 {constants.MAX_SETTLE_STEPS}). "
        "지층이 지표에 새 경사를 만들고 있다 — mapgen.md §4.4"
    )


@pytest.mark.determinism
@pytest.mark.parametrize("map_seed", SEEDS)
def test_generated_rock_is_never_born_disconnected(map_seed: int) -> None:
    """생성 직후 끊긴 `ROCK` 이 없다.

    있으면 매치 시작과 동시에 통째로 `SCREE` 로 뒤집혀 무너진다. 암반 선반 구역이
    기반암을 끌어올리므로 여기가 실제 위험 지점이다.
    """
    _load(map_seed)
    converted = T.connectivity()
    assert converted == 0, f"생성 직후 {converted} 셀이 끊겨 있다 — 시작하자마자 무너진다"


@pytest.mark.determinism
@pytest.mark.parametrize("map_seed", SEEDS)
def test_every_map_shows_all_four_provinces(map_seed: int) -> None:
    """한 맵에 네 지질이 전부 나온다 (`mapgen.md` §4.2 의 순열).

    구역마다 독립 추첨하면 시드에 따라 맵 전체가 한 지질로 덮인다 (실측 모래 809열/960).
    **다양성이 이 변경의 전부**라 우연에 맡기지 않는다.
    """
    order = M._province_order(map_seed)
    assert sorted(order) == [0, 1, 2, 3], f"순열이 아니다: {order}"


@pytest.mark.determinism
@pytest.mark.parametrize("map_seed", SEEDS)
def test_surface_materials_are_actually_varied(map_seed: int) -> None:
    """지표 재질이 실제로 갈린다 — 보이지 않으면 전술이 되지 않는다.

    첫 판에서는 네 구역이 모두 `SAND` 로 시작해 화면상 전부 모래였다.
    """
    _load(map_seed)
    grid2d = T.grid.reshape(T.H, T.W)
    seen: dict[int, int] = {}
    for x in range(4, T.W - 4):
        column = grid2d[:, x]
        top = int(np.argmax(column != T.EMPTY))
        material = int(column[top])
        seen[material] = seen.get(material, 0) + 1
    fallable = {m: c for m, c in seen.items() if m in (T.SAND, T.SOIL, T.SCREE)}
    assert len(fallable) >= 3, f"지표 재질이 {len(fallable)}종뿐이다: {seen}"
    # 어느 하나가 맵을 독점하지 않는다
    assert max(fallable.values()) <= T.W * 3 // 4, f"한 재질이 지표를 독점한다: {fallable}"


@pytest.mark.determinism
def test_spawn_rotation_evens_out_the_ground() -> None:
    """슬롯 배정 회전이 발밑 유불리를 실제로 줄인다 (`mapgen.md` §9.1).

    회전이 없으면 슬롯 0 이 매 라운드 같은 자리를 받아 5라운드 내내 고정 유불리가 된다.
    """

    def hardness(map_seed: int, x_cell: int) -> int:
        """발밑 60셀 중 ROCK·BEDROCK 비율 (‰). 높을수록 안전한 땅."""
        grid2d = T.grid.reshape(T.H, T.W)
        column = grid2d[:, x_cell]
        top = int(np.argmax(column != T.EMPTY))
        window = column[top : min(T.H, top + 60)]
        if window.size == 0:
            return 0
        hard = int(np.count_nonzero((window == T.ROCK) | (window == T.BEDROCK)))
        return hard * 1000 // int(window.size)

    worst_rotated = 0
    worst_fixed = 0
    for map_seed in SEEDS:
        _load(map_seed)
        spawns = M.choose_spawn_cells(T.grid, 4)
        hard = [hardness(map_seed, x) for x in spawns]

        rotated = [0, 0, 0, 0]
        for round_no in range(1, 6):
            shift = (round_no - 1) % 4
            for slot in range(4):
                rotated[slot] += hard[(slot + shift) % 4]
        worst_rotated = max(worst_rotated, max(rotated) - min(rotated))

        fixed = [h * 5 for h in hard]
        worst_fixed = max(worst_fixed, max(fixed) - min(fixed))

    assert worst_rotated * 2 < worst_fixed, (
        f"회전이 유불리를 못 줄인다: 회전 {worst_rotated}‰ vs 고정 {worst_fixed}‰"
    )
    assert worst_rotated <= 1200, f"회전을 해도 격차가 {worst_rotated}‰ 다"
