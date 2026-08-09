"""매치 진행 규칙의 작은 불변식."""

from talus.sim import ballistics as B
from talus.sim import match as Match
from talus.sim import weapons as Wp


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

    # **한 번에 다 빼내지는 않는다.** 즉시 임계 밑으로 올리면 `apply_phase` 가 매 턴
    # reseat 를 먼저 부르므로 `player.buried` 가 참이 될 수 없고 매몰이 사라진다.
    # 여기서 볼 것은 "즉시 탈출"이 아니라 **유한 턴 안에 반드시 풀리는가** 다.
    turns = 0
    while B.buried_fraction(p) >= B.CFG.burial_permille and turns < 20:
        B.reseat_tank(p)
        turns += 1
    after = B.buried_fraction(p)
    assert after < B.CFG.burial_permille, (
        f"매몰이 {turns}턴에도 안 풀렸다: {before}‰ → {after}‰ — "
        "밀어올리기가 진행하지 않으면 확정사가 된다"
    )
    assert 0 < turns <= 8, f"탈출에 {turns}턴 걸렸다 (1~8 이 정상)"


# ══════════════════════════════════════════════════════════════════════════
# 턴 상한 · 귀속 · 오버킬 · 차폐막  (decisions.md B7 · C10)
#
# 턴 상한 분기는 **죽은 코드였고 그 안에 실제 이탈이 숨어 있었다** —
# Python 은 `round_turn_cap * 1000`, TS 는 `roundTurnCap` 을 썼다. 턴 40 에서
# TS 는 라운드를 끝내고 Python 은 계속 갔다. match 골든이 턴 11 까지만 가서
# 교차 검증이 못 잡았다.
# ══════════════════════════════════════════════════════════════════════════


def _players(count: int) -> list[Match.Player]:
    return [
        Match.make_player(slot, chr(65 + slot), False, (160 + slot * 200) * B.CELL_SUBPX)
        for slot in range(count)
    ]


def test_turn_cap_divides_evenly_by_player_count() -> None:
    """턴 상한이 인원수로 나누어떨어진다 — 안 그러면 앞 슬롯이 한 발 더 쏜다."""
    for count in range(2, 7):
        cap = Match.effective_turn_cap(count)
        assert cap % count == 0, f"{count}인 상한 {cap} 이 안 나뉜다"
        assert cap <= Match.RULES.round_turn_cap
        assert cap > Match.RULES.round_turn_cap - count, f"{count}인에서 너무 많이 깎였다"


def test_turn_cap_actually_ends_the_round() -> None:
    """상한에 닿으면 라운드가 **실제로** 끝난다.

    `* 1000` 이 들어가 있던 시절에는 40,000 턴까지 안 끝났다. 그 분기를 밟는 테스트가
    없어서 아무도 몰랐다.
    """
    players = _players(2)
    cap = Match.effective_turn_cap(2)
    assert not Match.round_outcome(players, cap - 1).over, "상한 직전에 끝났다"
    outcome = Match.round_outcome(players, cap)
    assert outcome.over and outcome.reason == "turncap", f"상한에서 안 끝났다: {outcome}"


def test_turn_cap_winner_is_the_highest_hp_or_a_draw() -> None:
    """상한 종료의 승자는 최고 HP 이고, 동점이면 무승부다 (슬롯 유불리 없음)."""
    players = _players(3)
    cap = Match.effective_turn_cap(3)
    assert Match.round_outcome(players, cap).winner is None, "전원 동점인데 승자가 나왔다"
    players[1].hp = 90
    players[2].hp = 80
    assert Match.round_outcome(players, cap).winner == 0


def test_overkill_credits_only_what_was_actually_removed() -> None:
    """빈사 상태 적에게 큰 무기를 맞혀도 실제로 깎인 만큼만 정산한다.

    예전에는 남은 HP 3 인 적에게 핵포탄(120 피해)을 맞히면 960G·120점을 받았다.
    """
    T.grid.fill(T.EMPTY)
    players = _players(2)
    players[1].hp = 3
    gold_before = players[0].gold
    nuke = Wp.by_id(Wp.NUCLEAR_WEAPON_ID)
    det = Match.OwnedDetonation(x=players[1].x, y=players[1].y - (B.TANK_H >> 1), weapon=nuke, owner=0)

    Match.apply_detonations(players, [det])

    assert players[1].hp <= 0
    assert players[0].damage_done == 3, f"기여가 {players[0].damage_done} 로 잡혔다 (3 이어야 한다)"
    assert players[0].gold - gold_before == 3 * Match.RULES.gold_per_damage


def test_zero_damage_graze_does_not_burn_the_shield() -> None:
    """반경 끄트머리의 피해 0 히트가 차폐막을 소모하지 않는다.

    정수 시프트 때문에 반경 1024 무기는 1020~1023 거리에서 `dmg = 0` 이 나온다.
    그걸로 600G 아이템이 벗겨지면 **일부러 끄트머리에 떨어뜨리는 것이 공짜 해제**가 된다.
    """
    T.grid.fill(T.EMPTY)
    players = _players(2)
    players[1].shield_up = True
    weapon = Wp.by_id(0)  # 반경 1024

    # 피해가 0 이 나오는 거리에 떨어뜨린다
    target_y = players[1].y - (B.TANK_H >> 1)
    det = Match.OwnedDetonation(x=players[1].x + 1022, y=target_y, weapon=weapon, owner=0)
    hits = B.compute_damage(det.x, det.y, weapon.to_damage(), players)
    assert any(h.idx == 1 and h.dmg == 0 for h in hits), f"피해 0 히트가 안 나온다: {hits}"

    Match.apply_detonations(players, [det])
    assert players[1].shield_up is True, "피해 0 인데 차폐막이 벗겨졌다"
    assert players[1].hp == B.MAX_HP


def test_burial_damage_goes_to_whoever_buried_them() -> None:
    """매몰 지속 피해와 처치가 **묻은 사람**에게 간다.

    예전에는 매 턴 발사자로 갈아끼워져서, 남이 묻어놓은 적 쪽으로 아무 데나 쏘기만 해도
    턴당 피해와 킬을 가져갔다.
    """
    T.grid.fill(T.EMPTY)
    g2 = T.grid.reshape(T.H, T.W)
    g2[300:522, :] = T.SOIL
    g2[522:, :] = T.BEDROCK

    players = _players(3)
    victim = players[1]
    victim.y = B.surface_sub_y(victim.x)
    top = victim.y >> B.CELL_SHIFT
    g2[top - 12 : top, (victim.x >> B.CELL_SHIFT) - 12 : (victim.x >> B.CELL_SHIFT) + 12] = T.SOIL

    # 슬롯 2 가 묻었다
    Match.apply_phase(players, last_blast_owner=2)
    assert victim.buried, "매몰 시나리오가 성립하지 않았다"
    assert victim.buried_by == 2
    assert players[2].damage_done > 0

    # 다음 턴은 슬롯 0 이 쐈다 — 그래도 매몰 피해는 슬롯 2 공이다
    burier_before = players[2].damage_done
    shooter_before = players[0].damage_done
    Match.apply_phase(players, last_blast_owner=0)
    assert players[2].damage_done > burier_before, "묻은 사람이 공을 못 받았다"
    assert players[0].damage_done == shooter_before, "그 턴 발사자가 남의 공을 가져갔다"

    # 매몰로 죽으면 킬도 묻은 사람에게
    victim.hp = 1
    kills_before = players[2].kills
    Match.apply_phase(players, last_blast_owner=0)
    assert not victim.alive
    assert players[2].kills == kills_before + 1, "매몰 처치가 묻은 사람에게 안 갔다"
    assert players[0].kills == 0
