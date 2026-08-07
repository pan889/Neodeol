"""매치 진행 규칙의 작은 불변식."""

from talus.sim import ballistics as B
from talus.sim import match as Match


def test_turn_wind_changes_gradually_and_varies() -> None:
    wind = 0
    seen = {wind}
    deltas: list[int] = []
    for turn_no in range(1, 257):
        next_wind = Match.derive_wind(0x55, turn_no, wind)
        assert -B.CFG.wind_max <= next_wind <= B.CFG.wind_max
        deltas.append(next_wind - wind)
        assert abs(next_wind - wind) <= 3
        wind = next_wind
        seen.add(wind)

    assert len(seen) >= 7
    assert any(value < 0 for value in seen)
    assert any(value > 0 for value in seen)
    assert any(abs(delta) >= 2 for delta in deltas)
    assert sum(abs(delta) >= 2 for delta in deltas) < len(deltas) // 5


# ══════════════════════════════════════════════════════════════════════════
# 턴 경계 불변식 — sim 상태는 격자 하나뿐이다 (`terrain.md` §5.2)
#
# 활성 행 마스크는 격자 스냅샷에 안 들어간다. 서버는 매 턴 격자를 바이트에서 복원하며
# 마스크를 비우고, 클라이언트는 메모리에 그대로 이어간다. 턴 경계에서 마스크가 비어
# 있지 않으면 **두 쪽이 다음 턴부터 다른 지형을 시뮬레이션한다.**
#
# 실제로 그랬다: 강제 종료(`forced=True`) 경로가 마스크를 안 비워서, 상한에 걸린
# 다음 턴에 체크섬이 갈라졌다 (활성 68행, 정착 2970 vs 2952 스텝).
# 교차 검증 골든은 `forced` 를 한 번도 안 밟아서 잡지 못했다.
# ══════════════════════════════════════════════════════════════════════════
import pathlib

import pytest

from talus.sim import terrain as T
from talus.sim import trig


def _find_trig() -> bytes | None:
    here = pathlib.Path(__file__).resolve()
    for p in (here, *here.parents):
        candidate = p / "tables" / "trig.bin"
        if candidate.is_file():
            return candidate.read_bytes()
    return None


def _unstable_grid(seed: int) -> None:
    """정착이 오래 걸리는 지형. 상한을 낮게 주면 확실히 강제 종료된다."""
    import numpy as np

    T.CFG.seed = seed
    T.reset_gate_cache()
    T.grid.fill(T.EMPTY)
    g2 = T.grid.reshape(T.H, T.W)
    xs = np.arange(200, 760, dtype=np.uint32)
    for row in range(200, 460):
        h = T.hash32(np.uint32(seed), xs, np.uint32(row), np.uint32(0))
        keep = (h >> np.uint32(9)) % np.uint32(3) != 0
        g2[row, 200:760] = np.where(keep, (h % 4 + 1).astype(np.uint8), T.EMPTY)
    g2[522:, :] = T.BEDROCK
    T.connectivity()
    T.mark_all()
    T.set_step(0)


def test_settle_leaves_no_active_rows_when_forced() -> None:
    """강제 종료도 활성 마스크를 비운다 — 안 비우면 lockstep 이 깨진다."""
    _unstable_grid(0x91)
    result = Match.settle_terrain(40, 8)
    assert result.forced, "상한 40 스텝인데 정착했다 — 시나리오가 약하다"
    assert T.active_row_count() == 0, (
        f"강제 종료 후 활성 행이 {T.active_row_count()}개 남았다 — "
        "격자 스냅샷에 없는 상태가 턴을 넘어간다 (terrain.md §5.2)"
    )


def test_settle_leaves_no_active_rows_when_natural() -> None:
    """정상 종료도 마찬가지다. 가동 셀 0이면 자연히 비지만 명시적으로 못박는다."""
    _unstable_grid(0x92)
    result = Match.settle_terrain()
    assert not result.forced
    assert T.active_row_count() == 0


def test_forced_settle_does_not_desync_snapshot_roundtrip() -> None:
    """강제 종료 뒤 **격자 바이트만으로** 다음 턴이 재현된다.

    경로 A = 클라이언트(메모리 유지), 경로 B = 서버(`_restore_grid` 로 복원).
    둘이 갈라지면 그 턴부터 두 플레이어가 다른 게임을 한다.
    """
    import copy

    blob = _find_trig()
    if blob is None:
        pytest.skip("tables/trig.bin 을 못 찾았다")
    trig.load_trig(blob)

    original = Match.settle_terrain
    Match.settle_terrain = lambda *a, **k: original(60, 8)  # type: ignore[assignment]
    try:
        made = Match.create_match(
            0x515,
            [Match.PlayerSpec(name="A", is_ai=True), Match.PlayerSpec(name="B", is_ai=True)],
        )
        state = made.state
        first = Match.resolve_match_turn(
            state,
            Match.Intent(angle10=520, power=780, weapon_id=1, move_dx=0, use_shield=False),
        )
        assert first.settle.forced, "상한 60 스텝인데 정착했다 — 시나리오가 약하다"
    finally:
        Match.settle_terrain = original  # type: ignore[assignment]

    snapshot = T.grid.tobytes()
    base = copy.deepcopy(state)
    intent = Match.Intent(angle10=1300, power=700, weapon_id=0, move_dx=0, use_shield=False)

    a_state = copy.deepcopy(base)
    a = Match.resolve_match_turn(a_state, copy.deepcopy(intent))

    # 서버가 하는 일 그대로 — room/simulation.py `_restore_grid`
    import numpy as np

    T.grid[:] = np.frombuffer(snapshot, dtype=np.uint8)
    T.clear_active()
    T.set_step(0)
    T.reset_gate_cache()
    b_state = copy.deepcopy(base)
    b = Match.resolve_match_turn(b_state, copy.deepcopy(intent))

    assert a.checksum == b.checksum, (
        f"강제 종료 다음 턴이 갈라졌다: 메모리 유지 {a.checksum:08X} vs "
        f"바이트 복원 {b.checksum:08X} — 격자에 없는 상태에 결과가 의존한다"
    )
    assert a.settle.steps == b.settle.steps
    assert a.mass == b.mass


# ══════════════════════════════════════════════════════════════════════════
# 낙하는 원인을 가리지 않는다 · 매몰은 반드시 풀린다  (decisions.md B13, match.md §5.1)
# ══════════════════════════════════════════════════════════════════════════


def _cliff() -> None:
    """왼쪽 고지(y=200) · 오른쪽 저지(y=500) 절벽."""
    T.CFG.seed = 1
    T.reset_gate_cache()
    T.grid.fill(T.EMPTY)
    g2 = T.grid.reshape(T.H, T.W)
    g2[200:522, :480] = T.ROCK
    g2[500:522, 480:] = T.ROCK
    g2[522:, :] = T.BEDROCK
    T.connectivity()
    T.mark_all()
    T.set_step(0)


def test_fuel_walk_off_cliff_hurts_like_a_collapse() -> None:
    """연료로 걸어 내려간 낙하도 지형 붕괴와 **같은 피해**를 받는다.

    예전에는 `apply_move` 가 `reseat_tank()` 의 반환값을 버려서 600 px 절벽이 무피해였다.
    300골드 연료가 무제한 낙하 무효 아이템이었다.
    """
    _cliff()
    walker = Match.make_player(0, "A", False, 460 * B.CELL_SUBPX)
    walker.y = B.surface_sub_y(walker.x)
    walker.items.fuel = 3
    other = Match.make_player(1, "B", False, 100 * B.CELL_SUBPX)
    other.y = B.surface_sub_y(other.x)

    moved, fall = Match.apply_move(walker, 28)
    assert moved == 28, f"절벽을 넘어가지 못했다: {moved}셀"
    assert fall > 500, f"낙하가 안 잡혔다: {fall} px"

    walker.intent = Match.Intent(
        angle10=450, power=500, weapon_id=0, move_dx=0, use_shield=False
    )
    # resolve_turn 이 이동 낙하를 피해로 바꾼다
    _cliff()
    w2 = Match.make_player(0, "A", False, 460 * B.CELL_SUBPX)
    w2.y = B.surface_sub_y(w2.x)
    w2.items.fuel = 3
    w2.intent = Match.Intent(
        angle10=450, power=500, weapon_id=0, move_dx=28, use_shield=False
    )
    o2 = Match.make_player(1, "B", False, 100 * B.CELL_SUBPX)
    o2.y = B.surface_sub_y(o2.x)
    o2.intent = None
    result = Match.resolve_turn([w2, o2], 0)

    kinds = [e["t"] for e in result.events]
    assert "falldamage" in kinds, f"낙하 피해 이벤트가 없다: {kinds}"
    assert w2.hp < 100, f"이동 낙하가 아프지 않다: hp {w2.hp}"
    # 귀속 대상이 없다 — 아무도 골드를 못 받는다
    fall_ev = next(e for e in result.events if e["t"] == "falldamage")
    assert fall_ev["by"] is None, f"자발적 낙하에 귀속이 붙었다: {fall_ev['by']}"
    assert o2.gold == Match.RULES.start_gold, "남이 골드를 챙겼다"


def test_parachute_saves_a_walked_fall_too() -> None:
    """낙하산은 원인을 가리지 않는다 — 걸어 내려간 낙하에도 발동한다."""
    _cliff()
    p = Match.make_player(0, "A", False, 460 * B.CELL_SUBPX)
    p.y = B.surface_sub_y(p.x)
    p.items.fuel = 3
    p.items.parachute = 1
    p.intent = Match.Intent(angle10=450, power=500, weapon_id=0, move_dx=28, use_shield=False)
    o = Match.make_player(1, "B", False, 100 * B.CELL_SUBPX)
    o.y = B.surface_sub_y(o.x)
    o.intent = None

    result = Match.resolve_turn([p, o], 0)
    kinds = [e["t"] for e in result.events]
    assert "parachute" in kinds, f"낙하산이 안 폈다: {kinds}"
    assert p.hp == 100, f"낙하산을 쓰고도 아팠다: hp {p.hp}"
    assert p.items.parachute == 0, "낙하산이 소모되지 않았다"


def test_burial_always_has_an_exit() -> None:
    """매몰 판정을 받는 상태는 반드시 밀어올려진다 (`decisions.md` B13).

    임계가 갈라져 있으면(판정 800‰ · 밀어올리기 1000‰) 그 사이 구간에 갇혀
    턴당 지속 피해로 확정사한다. 실측 875‰ 고착이 그 상태였다.
    """
    import numpy as np

    T.CFG.seed = 1
    T.reset_gate_cache()
    T.grid.fill(T.EMPTY)
    g2 = T.grid.reshape(T.H, T.W)
    g2[300:522, :] = T.SOIL
    g2[522:, :] = T.BEDROCK
    T.connectivity()
    T.mark_all()
    T.set_step(0)

    p = Match.make_player(0, "A", False, 400 * B.CELL_SUBPX)
    p.y = B.surface_sub_y(p.x)
    top = p.y >> B.CELL_SHIFT
    g2[top - 7 : top, 388:412] = T.SOIL  # 탱크를 흙에 파묻는다

    before = B.buried_fraction(p)
    assert before >= B.CFG.burial_permille, f"시나리오가 약하다: {before}‰"
    assert before < 1000, f"1000‰ 이면 옛 임계로도 풀린다 — 검사 의미가 없다: {before}‰"

    B.reseat_tank(p)
    after = B.buried_fraction(p)
    assert after < B.CFG.burial_permille, (
        f"매몰이 안 풀렸다: {before}‰ → {after}‰ (임계 {B.CFG.burial_permille}‰) — "
        "밀어올리기 임계가 매몰 판정과 다르면 그 사이 구간이 확정사가 된다"
    )
