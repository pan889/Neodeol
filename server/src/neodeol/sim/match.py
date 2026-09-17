"""라운드·턴·경제·승패 — ``client/src/sim/match.ts`` 의 1:1 미러."""

from __future__ import annotations

from dataclasses import dataclass, field

from neodeol import constants

from . import ballistics as B
from . import mapgen as M
from . import terrain as T
from . import weapons as Wp
from .intmath import clamp_int, floor_div, hash32_scalar

MATCH_VERSION = constants.MATCH_VERSION
AMMO_INFINITE = constants.AMMO_INFINITE


@dataclass(frozen=True)
class MatchRules:
    rounds: int = constants.MATCH_ROUNDS
    round_turn_cap: int = constants.ROUND_TURN_CAP
    start_gold: int = constants.START_GOLD
    gold_per_damage: int = constants.GOLD_PER_DAMAGE
    gold_per_kill: int = constants.GOLD_PER_KILL
    gold_survive: int = constants.GOLD_SURVIVE
    gold_last_place_bonus: int = constants.GOLD_LAST_PLACE_BONUS
    kill_score: int = constants.KILL_SCORE
    damage_score: int = constants.DAMAGE_SCORE
    survive_score: int = constants.SURVIVE_SCORE
    fuel_cells_per_unit: int = constants.FUEL_CELLS_PER_UNIT
    move_max_step_up: int = constants.MOVE_MAX_STEP_UP
    max_settle_steps: int = constants.MAX_SETTLE_STEPS
    connectivity_max_rounds: int = constants.CONNECTIVITY_MAX_ROUNDS


RULES = MatchRules()


@dataclass
class Intent:
    angle10: int
    power: int
    weapon_id: int
    move_dx: int
    use_shield: bool


@dataclass
class ItemCounts:
    shield: int = 0
    parachute: int = 0
    fuel: int = 0
    anemo: int = 0


@dataclass
class Player(B.Tank):
    is_ai: bool = False
    gold: int = constants.START_GOLD
    weapon_id: int = 0
    ammo: list[int] = field(default_factory=list)
    items: ItemCounts = field(default_factory=ItemCounts)
    score: int = 0
    kills: int = 0
    damage_done: int = 0
    intent: Intent | None = None
    shield_up: bool = False
    #: 이 플레이어를 묻은 폭발의 소유자. 매몰이 풀리면 `None` 으로 돌아간다.
    #: 매몰은 **과거 턴에 생긴 지속 상태**라 귀속도 그때 정해진다 — 매 턴 발사자로
    #: 갈아끼우면 남이 묻어놓은 적 쪽으로 아무 데나 쏘기만 해도 피해·킬을 가져간다.
    buried_by: int | None = None


@dataclass(frozen=True)
class PlayerSpec:
    name: str
    is_ai: bool = False


MatchEvent = dict[str, object]


@dataclass
class OwnedLeg:
    pts: list[tuple[int, int]]
    kind: str
    slot: int


@dataclass
class OwnedDetonation:
    x: int
    y: int
    weapon: Wp.Weapon
    owner: int


@dataclass
class ResolveTurnResult:
    legs: list[OwnedLeg] = field(default_factory=list)
    dets: list[OwnedDetonation] = field(default_factory=list)
    events: list[MatchEvent] = field(default_factory=list)


@dataclass
class ApplyDetonationsResult:
    events: list[MatchEvent]
    removed: int
    filled: int
    conv: int


@dataclass
class SettleResult:
    steps: int
    connectivity_rounds: int
    forced: bool


@dataclass
class RoundOutcome:
    over: bool
    reason: str | None = None
    winner: int | None = None


@dataclass
class MatchState:
    map_seed: int
    round_no: int
    turn_no: int
    round_turn: int
    active_slot: int
    wind: int
    spawn_cells: list[int]
    players: list[Player]
    phase: str
    over: bool


@dataclass
class CreateMatchResult:
    state: MatchState
    initial_settle: SettleResult


@dataclass
class MatchTurnResult:
    turn_no: int
    turn_seed: int
    wind: int
    legs: list[OwnedLeg]
    dets: list[OwnedDetonation]
    events: list[MatchEvent]
    removed: int
    filled: int
    conv: int
    settle: SettleResult
    last_blast_owner: int | None
    outcome: RoundOutcome
    round_events: list[MatchEvent]
    checksum: int
    mass: int


def _assert_players(players: list[Player]) -> None:
    if len(players) < 2 or len(players) > 6:
        raise ValueError("players length must be 2..6")
    for index, player in enumerate(players):
        if player.slot != index:
            raise ValueError("players must be contiguous slot order")


def _is_int(value: object) -> bool:
    return type(value) is int


def make_player(slot: int, name: str, is_ai: bool, x_sub: int) -> Player:
    tank = B.make_tank(slot, x_sub, name)
    ammo = [0] * len(Wp.WEAPONS)
    for weapon in Wp.WEAPONS:
        ammo[weapon.id] = -1 if weapon.ammo0 is None else weapon.ammo0
    return Player(
        slot=tank.slot,
        name=tank.name,
        x=tank.x,
        y=tank.y,
        hp=tank.hp,
        alive=tank.alive,
        buried=tank.buried,
        angle10=tank.angle10,
        power=tank.power,
        is_ai=is_ai,
        gold=RULES.start_gold,
        weapon_id=0,
        ammo=ammo,
    )


def ammo_of(player: Player, weapon_id: int) -> int:
    weapon = Wp.by_id(weapon_id)
    if weapon.ammo0 is None:
        return AMMO_INFINITE
    amount = player.ammo[weapon.id] if weapon.id < len(player.ammo) else 0
    return amount if amount >= 0 else 0


def can_fire(player: Player, weapon_id: int) -> bool:
    return ammo_of(player, weapon_id) > 0


def _spend_ammo(player: Player, weapon_id: int) -> None:
    weapon = Wp.by_id(weapon_id)
    if weapon.ammo0 is None:
        return
    amount = player.ammo[weapon.id] if weapon.id < len(player.ammo) else 0
    player.ammo[weapon.id] = amount - 1 if amount > 0 else 0


def effective_weapon(player: Player, weapon_id: int) -> Wp.Weapon:
    if (
        _is_int(weapon_id)
        and 0 <= weapon_id < len(Wp.WEAPONS)
        and can_fire(player, weapon_id)
    ):
        return Wp.by_id(weapon_id)
    return Wp.by_id(0)


def normalize_intent(player: Player, candidate: Intent | None) -> Intent:
    angle10 = (
        candidate.angle10
        if candidate is not None
        and _is_int(candidate.angle10)
        and 0 <= candidate.angle10 <= 1800
        else player.angle10
    )
    power = (
        candidate.power
        if candidate is not None
        and _is_int(candidate.power)
        and 0 <= candidate.power <= B.MAX_POWER
        else player.power
    )
    fallback_weapon = player.weapon_id if can_fire(player, player.weapon_id) else 0
    weapon_id = (
        candidate.weapon_id
        if candidate is not None
        and _is_int(candidate.weapon_id)
        and 0 <= candidate.weapon_id < len(Wp.WEAPONS)
        and can_fire(player, candidate.weapon_id)
        else fallback_weapon
    )
    move_dx = (
        clamp_int(candidate.move_dx, -T.W, T.W)
        if candidate is not None and _is_int(candidate.move_dx)
        else 0
    )
    use_shield = candidate is not None and candidate.use_shield is True
    return Intent(
        angle10=angle10,
        power=power,
        weapon_id=weapon_id,
        move_dx=move_dx,
        use_shield=use_shield,
    )


def set_intent(player: Player, candidate: Intent | None) -> Intent:
    intent = normalize_intent(player, candidate)
    player.angle10 = intent.angle10
    player.power = intent.power
    player.weapon_id = intent.weapon_id
    player.intent = intent
    return intent


def _apply_fall(
    players: list[Player], player: Player, fall: int, owner: int | None
) -> list[MatchEvent]:
    """재배치가 낸 낙하를 피해로 바꾼다. `apply_move` 와 `apply_phase` 가 **공유한다.**

    **떨어지면 원인과 무관하게 아프다.** 예전에는 `apply_move` 가 `reseat_tank()` 의
    반환값을 버려서, 연료로 절벽을 걸어 내려가면 무피해였다 — 같은 600 px 낙차를
    지형 붕괴로 떨어지면 288 피해로 즉사인데. 300골드 연료가 사실상 무제한 낙하 무효
    아이템이었다.

    두 호출부가 각자 계산하면 낙하산 소모·격자 이탈·이벤트 형식이 갈라진다.
    한 군데서만 판정한다.
    """
    events: list[MatchEvent] = []
    if fall < 0:
        player.hp = 0
        events.append({"t": "outofmap", "slot": player.slot})
        return events
    if fall == 0:
        return events
    damage = B.fall_damage(fall)
    if damage <= 0:
        return events
    if player.items.parachute > 0:
        player.items.parachute -= 1
        events.append({"t": "parachute", "slot": player.slot, "fallPx": fall})
        return events
    player.hp -= damage
    _credit_damage(players, owner, damage)
    events.append(
        {
            "t": "falldamage",
            "slot": player.slot,
            "fallPx": fall,
            "dmg": damage,
            "by": owner,
        }
    )
    return events


def apply_move(player: Player, dx_cells: int) -> tuple[int, int]:
    """연료로 좌우 이동. 반환은 `(이동 셀 수, 낙하 픽셀)`.

    **낙하 픽셀을 반드시 호출자에게 넘긴다.** 예전에는 여기서 `reseat_tank()` 를 부르고
    반환값을 버렸고, 그래서 절벽을 걸어 내려가면 낙하 피해가 0 이었다 (`match.md` §5.1).
    """
    if not player.alive or dx_cells == 0:
        return 0, 0
    budget = player.items.fuel * RULES.fuel_cells_per_unit
    wanted = -dx_cells if dx_cells < 0 else dx_cells
    if wanted > budget:
        wanted = budget
    direction = -1 if dx_cells < 0 else 1
    moved = 0
    for _ in range(wanted):
        next_x = player.x + direction * B.CELL_SUBPX
        if next_x < 0 or next_x >= B.MAP_W_SUB:
            break
        current_top = B.surface_sub_y(player.x)
        next_top = B.surface_sub_y(next_x)
        if current_top - next_top > RULES.move_max_step_up * B.CELL_SUBPX:
            break
        player.x = next_x
        moved += 1
    fall = 0
    if moved > 0:
        used = floor_div(moved + RULES.fuel_cells_per_unit - 1, RULES.fuel_cells_per_unit)
        player.items.fuel = player.items.fuel - used if player.items.fuel > used else 0
        fall = B.reseat_tank(player)
    return moved, fall


def resolve_turn(players: list[Player], wind: int) -> ResolveTurnResult:
    _assert_players(players)
    result = ResolveTurnResult()

    for player in players:
        if not player.alive or player.intent is None:
            continue
        moved, fall = apply_move(player, player.intent.move_dx)
        if moved > 0:
            result.events.append({"t": "move", "slot": player.slot, "cells": moved})
            # 스스로 걸어 내려간 낙하다 — 유발한 발사가 없으므로 귀속 대상도 없다
            # (이 시점에는 이번 턴의 폭발이 아직 하나도 없다).
            result.events.extend(_apply_fall(players, player, fall, None))
            if player.hp <= 0:
                player.hp = 0
                player.alive = False
                result.events.append({"t": "dead", "slot": player.slot, "by": None})
                continue
        player.shield_up = player.intent.use_shield and player.items.shield > 0
        if player.shield_up:
            player.items.shield -= 1
            result.events.append({"t": "shield", "slot": player.slot})

    for player in players:
        if not player.alive or player.intent is None:
            continue
        weapon = effective_weapon(player, player.intent.weapon_id)
        player.weapon_id = weapon.id
        _spend_ammo(player, weapon.id)
        pose = B.shot_pose(player, player.intent.angle10)
        plan = Wp.resolve_shot(
            pose.x,
            pose.y,
            pose.angle10,
            player.intent.power,
            wind,
            player.slot,
            players,
            weapon,
        )
        for leg in plan.legs:
            result.legs.append(OwnedLeg(pts=leg.pts, kind=leg.kind, slot=player.slot))
        for det in plan.dets:
            result.dets.append(
                OwnedDetonation(x=det.x, y=det.y, weapon=det.weapon, owner=player.slot)
            )
        result.events.append(
            {
                "t": "fire",
                "slot": player.slot,
                "weaponId": weapon.id,
                "angle10": player.intent.angle10,
                "power": player.intent.power,
            }
        )
    return result


def _credit_damage(players: list[Player], owner_slot: int | None, damage: int) -> None:
    if owner_slot is None or owner_slot < 0 or owner_slot >= len(players):
        return
    owner = players[owner_slot]
    if owner.slot != owner_slot:
        return
    owner.damage_done += damage
    owner.gold += damage * RULES.gold_per_damage


def _credit_kill(players: list[Player], owner_slot: int | None, victim_slot: int) -> None:
    if owner_slot is None or owner_slot == victim_slot or owner_slot < 0 or owner_slot >= len(players):
        return
    owner = players[owner_slot]
    if owner.slot != owner_slot:
        return
    owner.kills += 1
    owner.gold += RULES.gold_per_kill


def apply_detonations(
    players: list[Player], source: list[OwnedDetonation]
) -> ApplyDetonationsResult:
    _assert_players(players)
    dets = sorted(source, key=lambda det: det.owner)
    events: list[MatchEvent] = []
    pending: list[tuple[int, int, int, int]] = []

    for det in dets:
        if det.weapon.max_damage <= 0:
            continue
        for hit in B.compute_damage(det.x, det.y, det.weapon.to_damage(), players):
            pending.append((hit.idx, hit.dmg, hit.dist, det.owner))

    removed = 0
    filled = 0
    for det in dets:
        applied = Wp.apply_detonation(det)
        removed += applied.removed
        filled += applied.filled
    conv = T.connectivity()
    if conv > 0:
        events.append({"t": "conv", "cells": conv})

    for index, damage, distance, owner in pending:
        player = players[index]
        if not player.alive:
            continue
        # 피해 0 인 히트는 차폐막을 소모하지 않는다. 반경 경계 부근은 정수 시프트 때문에
        # `dmg = 0` 이 나오는데(반경 1024 무기의 1020~1023), 그걸로 600G 아이템이
        # 벗겨지면 **일부러 끄트머리에 떨어뜨리는 것이 공짜 해제**가 된다.
        if damage <= 0:
            continue
        if player.shield_up:
            player.shield_up = False
            events.append({"t": "blocked", "slot": player.slot})
            continue
        # **실제 깎인 만큼만 정산한다.** 계산상 피해 전량을 주면 빈사 상태 적에게 큰
        # 무기를 맞혔을 때 기여의 수십 배를 받는다 (남은 HP 3 에 핵포탄 → 960G).
        dealt = damage if damage < player.hp else player.hp
        player.hp -= damage
        _credit_damage(players, owner, dealt)
        events.append(
            {
                "t": "damage",
                "slot": player.slot,
                "dmg": damage,
                "by": owner,
                "distPx": distance >> B.PX_SHIFT,
            }
        )
    return ApplyDetonationsResult(
        events=events,
        removed=removed,
        filled=filled,
        conv=conv,
    )


def settle_terrain(
    max_steps: int = RULES.max_settle_steps,
    max_connectivity_rounds: int = RULES.connectivity_max_rounds,
) -> SettleResult:
    T.set_step(0)
    steps = 0
    connectivity_rounds = 0
    while steps < max_steps:
        steps += 1
        if T.step().mobile != 0:
            continue
        converted = T.connectivity()
        if converted == 0:
            return SettleResult(
                steps=steps,
                connectivity_rounds=connectivity_rounds,
                forced=False,
            )
        connectivity_rounds += 1
        if connectivity_rounds >= max_connectivity_rounds:
            return _forced_stop(steps, connectivity_rounds)
    return _forced_stop(steps, connectivity_rounds)


def _forced_stop(steps: int, connectivity_rounds: int) -> SettleResult:
    """강제 종료 — `terrain.md` §5.2 "격자를 그대로 확정하고 활성 행 마스크를 비운다".

    **비우지 않으면 lockstep 이 깨진다.** 활성 행 마스크는 시뮬레이션 상태인데 격자
    스냅샷에 안 들어간다. 서버는 매 턴 격자를 바이트에서 복원하며 마스크를 비우고
    (`room/simulation.py` `_restore_grid`), 클라이언트는 메모리에 그대로 이어간다.
    정상 종료는 가동 셀이 0이라 마스크도 비어 있어 양쪽이 같지만, 강제 종료는 마스크가
    남아서 **다음 턴부터 두 쪽이 다른 지형을 시뮬레이션한다.** 리싱크(`fullState`)도
    격자만 보내므로 같은 구멍이다.

    즉 이 한 줄이 "턴 경계에서 sim 상태는 격자 하나뿐" 이라는 불변식을 지킨다.
    """
    T.clear_active()
    return SettleResult(steps=steps, connectivity_rounds=connectivity_rounds, forced=True)


def apply_phase(players: list[Player], last_blast_owner: int | None) -> list[MatchEvent]:
    _assert_players(players)
    events: list[MatchEvent] = []
    for player in players:
        if not player.alive:
            continue
        events.extend(_apply_fall(players, player, B.reseat_tank(player), last_blast_owner))
        # 사망 귀속은 **마지막 타격을 넣은 쪽**이다. 낙하는 그 턴의 발사자,
        # 매몰은 묻은 사람이다 — 둘이 다를 수 있어서 따로 따라간다.
        killer = last_blast_owner

        buried_fraction = B.buried_fraction(player)
        was_buried = player.buried
        player.buried = buried_fraction >= B.CFG.burial_permille
        if player.buried:
            # **묻은 사람에게 귀속한다.** 매몰은 과거 턴에 생긴 지속 상태이므로 귀속도
            # 묻힌 그 순간에 정해진다. 매 턴 발사자로 갈아끼우면 남이 묻어놓은 적 쪽으로
            # 아무 데나 쏘기만 해도 턴당 피해와 처치 크레딧을 가져간다.
            if not was_buried:
                player.buried_by = last_blast_owner
            owner = player.buried_by
            dealt = (
                B.CFG.burial_damage if B.CFG.burial_damage < player.hp else player.hp
            )
            hp_before_burial = player.hp
            player.hp -= B.CFG.burial_damage
            _credit_damage(players, owner, dealt)
            if hp_before_burial > 0 and player.hp <= 0:
                killer = owner
            events.append(
                {
                    "t": "buried",
                    "slot": player.slot,
                    "pct": floor_div(buried_fraction, 10),
                    "dmg": B.CFG.burial_damage,
                    "by": owner,
                }
            )
        else:
            player.buried_by = None
            if was_buried:
                events.append({"t": "unburied", "slot": player.slot})

        if player.hp <= 0:
            player.hp = 0
            player.alive = False
            events.append({"t": "dead", "slot": player.slot, "by": killer})
            _credit_kill(players, killer, player.slot)
    return events


def effective_turn_cap(player_count: int) -> int:
    """플레이어 수로 나누어떨어지는 턴 상한.

    `ROUND_TURN_CAP` 은 **개별 발사 횟수** 40 인데 3인·6인으로 안 나뉜다. 그대로 두면
    캡으로 끝난 라운드에서 앞쪽 슬롯이 한 발을 더 쏘고, 그 라운드의 승자는 HP 로 정해지므로
    (`round_outcome`) 슬롯 번호가 그대로 유불리가 된다. 내림해서 균등하게 만든다.

        2인 40 · 3인 39 · 4인 40 · 5인 40 · 6인 36

    라운드 선공(`(roundNo - 1) % playerCount`)의 편차는 5라운드가 6인으로 안 나뉘어
    남지만, 그건 라운드 수를 인원마다 바꿔야 해서 매치 길이가 들쭉날쭉해진다.
    `decisions.md` B7.
    """
    cap = RULES.round_turn_cap
    return cap - (cap % player_count) if player_count > 0 else cap


def round_outcome(players: list[Player], round_turn: int) -> RoundOutcome:
    _assert_players(players)
    alive = [player for player in players if player.alive]
    if len(alive) <= 1:
        return RoundOutcome(
            over=True,
            reason="last" if len(alive) == 1 else "wipe",
            winner=alive[0].slot if len(alive) == 1 else None,
        )
    if round_turn >= effective_turn_cap(len(players)):
        best_hp = alive[0].hp
        for player in alive[1:]:
            if player.hp > best_hp:
                best_hp = player.hp
        leaders = [player for player in alive if player.hp == best_hp]
        return RoundOutcome(
            over=True,
            reason="turncap",
            winner=leaders[0].slot if len(leaders) == 1 else None,
        )
    return RoundOutcome(over=False)


def close_round(players: list[Player], outcome: RoundOutcome) -> list[MatchEvent]:
    _assert_players(players)
    events: list[MatchEvent] = []
    for player in players:
        player.score += player.kills * RULES.kill_score + player.damage_done * RULES.damage_score
        if player.alive:
            player.score += RULES.survive_score
            player.gold += RULES.gold_survive
            events.append({"t": "survive", "slot": player.slot})
        player.kills = 0
        player.damage_done = 0
    ranked = sorted(players, key=lambda player: (player.score, player.slot))
    for rank, player in enumerate(ranked):
        bonus = (len(ranked) - 1 - rank) * RULES.gold_last_place_bonus
        if bonus > 0:
            player.gold += bonus
    return events


def begin_round(players: list[Player], spawn_cells: list[int], rotation: int) -> None:
    """라운드 시작 배치. `rotation` 만큼 슬롯과 스폰 자리를 어긋나게 돌린다.

    스폰 자리는 x 오름차순이라 회전이 없으면 슬롯 0 이 매 라운드 왼쪽 끝을 받는다.
    지질 구역이 생긴 뒤로는 자리마다 발밑이 다르다 — 실측으로 `BEDROCK 52/60`
    (사실상 파괴 불가)부터 `SAND 40/60`(통째로 쓸려나감)까지 갈린다.
    회전이 없으면 **슬롯 번호가 5라운드 내내 고정 유불리**가 된다
    (실측 최대 격차 4580‰ → 회전 시 916‰).
    """
    _assert_players(players)
    if len(spawn_cells) != len(players):
        raise ValueError("spawn_cells length mismatch")
    shift = rotation % len(players)
    for index, player in enumerate(players):
        player.hp = B.MAX_HP
        player.alive = True
        player.buried = False
        player.buried_by = None
        player.shield_up = False
        player.intent = None
        player.x = spawn_cells[(index + shift) % len(players)] * B.CELL_SUBPX
        player.y = B.surface_sub_y(player.x)
        B.reseat_tank(player)


def buy_weapon(player: Player, weapon_id: int) -> bool:
    if not _is_int(weapon_id) or weapon_id < 0 or weapon_id >= len(Wp.WEAPONS):
        return False
    weapon = Wp.by_id(weapon_id)
    if weapon.ammo0 is None or player.gold < weapon.price:
        return False
    player.gold -= weapon.price
    player.ammo[weapon.id] += 1
    return True


def buy_item(player: Player, key: str) -> bool:
    item = next((candidate for candidate in Wp.ITEMS if candidate.key == key), None)
    if item is None or player.gold < item.price or not hasattr(player.items, key):
        return False
    player.gold -= item.price
    setattr(player.items, key, getattr(player.items, key) + 1)
    return True


def derive_turn_seed(map_seed: int, turn_no: int) -> int:
    return hash32_scalar(map_seed, turn_no, 0, 0)


def derive_wind(map_seed: int, turn_no: int, previous_wind: int = 0) -> int:
    max_wind = B.CFG.wind_max
    if max_wind <= 0:
        return 0
    roll = hash32_scalar(map_seed ^ 0x5715, turn_no, previous_wind, 0) % 20
    delta = -1 if roll < 4 else (1 if roll >= 16 else 0)
    return clamp_int(previous_wind + delta, -max_wind, max_wind)


def match_leaders(players: list[Player]) -> list[int]:
    _assert_players(players)
    best_score = players[0].score
    for player in players[1:]:
        if player.score > best_score:
            best_score = player.score
    return [player.slot for player in players if player.score == best_score]


def next_alive_slot(players: list[Player], current_slot: int) -> int:
    _assert_players(players)
    if not _is_int(current_slot) or current_slot < 0 or current_slot >= len(players):
        raise ValueError("current slot out of range")
    for offset in range(1, len(players) + 1):
        slot = (current_slot + offset) % len(players)
        if players[slot].alive:
            return slot
    raise RuntimeError("no alive players")


def create_match(map_seed: int, specs: list[PlayerSpec]) -> CreateMatchResult:
    if len(specs) < 2 or len(specs) > 6:
        raise ValueError("player specs length must be 2..6")
    T.CFG.seed = map_seed
    T.reset_gate_cache()
    T.grid[:] = M.build_map(map_seed)
    T.connectivity()
    T.mark_all()
    initial_settle = settle_terrain()
    if initial_settle.forced:
        raise RuntimeError("initial map settlement exceeded limit")
    spawn_cells = M.choose_spawn_cells(T.grid, len(specs), map_seed)
    players = [
        make_player(
            slot=index,
            name=spec.name,
            is_ai=spec.is_ai,
            x_sub=spawn_cells[index] * B.CELL_SUBPX,
        )
        for index, spec in enumerate(specs)
    ]
    begin_round(players, spawn_cells, 0)
    state = MatchState(
        map_seed=map_seed,
        round_no=1,
        turn_no=0,
        round_turn=0,
        active_slot=0,
        wind=derive_wind(map_seed, 1, 0),
        spawn_cells=spawn_cells,
        players=players,
        phase="aim",
        over=False,
    )
    return CreateMatchResult(state=state, initial_settle=initial_settle)


def resolve_match_turn(
    state: MatchState, intent: Intent | None
) -> MatchTurnResult:
    if state.over or state.phase != "aim":
        raise RuntimeError("match is not accepting intents")
    _assert_players(state.players)
    if not _is_int(state.active_slot) or state.active_slot < 0 or state.active_slot >= len(state.players):
        raise ValueError("active slot out of range")
    active_player = state.players[state.active_slot]
    if not active_player.alive:
        raise RuntimeError("active player is not alive")
    turn_wind = state.wind
    state.turn_no += 1
    state.round_turn += 1
    turn_seed = derive_turn_seed(state.map_seed, state.turn_no)
    T.CFG.seed = turn_seed
    T.reset_gate_cache()
    for player in state.players:
        player.intent = None
    set_intent(active_player, intent)

    resolved = resolve_turn(state.players, turn_wind)
    applied = apply_detonations(state.players, resolved.dets)
    settle = settle_terrain()
    last_blast_owner = resolved.dets[-1].owner if resolved.dets else None
    phase_events = apply_phase(state.players, last_blast_owner)
    outcome = round_outcome(state.players, state.round_turn)
    round_events = close_round(state.players, outcome) if outcome.over else []
    if outcome.over:
        if state.round_no >= RULES.rounds * 1000:
            state.over = True
            state.phase = "done"
        else:
            state.phase = "shop"
    else:
        state.active_slot = next_alive_slot(state.players, state.active_slot)
        state.wind = derive_wind(state.map_seed, state.turn_no + 1, turn_wind)
        state.phase = "aim"

    events = [*resolved.events, *applied.events, *phase_events]
    if settle.forced:
        events.append({"t": "settlecap", "cells": settle.steps})
    return MatchTurnResult(
        turn_no=state.turn_no,
        turn_seed=turn_seed,
        wind=turn_wind,
        legs=resolved.legs,
        dets=resolved.dets,
        events=events,
        removed=applied.removed,
        filled=applied.filled,
        conv=applied.conv,
        settle=settle,
        last_blast_owner=last_blast_owner,
        outcome=outcome,
        round_events=round_events,
        checksum=T.checksum(),
        mass=T.mass_count(),
    )


def start_next_round(state: MatchState) -> None:
    if state.over or state.phase != "shop":
        raise RuntimeError("match is not between rounds")
    state.round_no += 1
    state.round_turn = 0
    state.active_slot = (state.round_no - 1) % len(state.players)
    state.spawn_cells = M.choose_spawn_cells(T.grid, len(state.players), state.map_seed)
    begin_round(state.players, state.spawn_cells, state.round_no - 1)
    state.wind = derive_wind(state.map_seed, state.turn_no + 1, state.wind)
    state.phase = "aim"
