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
