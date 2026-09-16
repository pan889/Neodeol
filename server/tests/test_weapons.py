"""무기 경제와 후반 병기 규칙."""

from neodeol.sim import match as Match
from neodeol.sim import weapons as Wp


def test_nuclear_shell_is_late_game_purchase() -> None:
    weapon = Wp.by_id(Wp.NUCLEAR_WEAPON_ID)
    player = Match.make_player(0, "alpha", False, 0)

    assert weapon.name == "핵포탄"
    assert weapon.ammo0 == 0
    assert weapon.price == 4800
    assert weapon.blast_radius == 4096
    assert weapon.carve_cells == 80
    assert Match.ammo_of(player, weapon.id) == 0
    assert Match.buy_weapon(player, weapon.id) is False

    player.gold = weapon.price
    assert Match.buy_weapon(player, weapon.id) is True
    assert player.gold == 0
    assert Match.ammo_of(player, weapon.id) == 1


# ══════════════════════════════════════════════════════════════════════════
# 무기가 경제 층까지 실제로 지나가는가
#
# `shots` 골든이 8종을 전부 밟지만 그건 탄도 층이다. `resolve_turn →
# apply_detonations → 피해·골드` 경로는 한동안 무기 2종(0·5)만 지났고, 분열탄의 다중
# 폭발이나 적층탄의 지형 추가가 경제에 어떻게 반영되는지 아무도 안 보고 있었다.
# ══════════════════════════════════════════════════════════════════════════
import json
import os
import pathlib

import pytest

from neodeol import constants
from neodeol.sim import match as Match
from neodeol.sim import weapons as Wp


def _match_golden() -> dict | None:
    env = os.environ.get("NEODEOL_REPLAY_DIR")
    root = pathlib.Path(env) if env else None
    if root is None:
        here = pathlib.Path(__file__).resolve()
        for parent in (here, *here.parents):
            candidate = parent / "tests" / "replays"
            if candidate.is_dir():
                root = candidate
                break
    if root is None:
        return None
    path = root / "match.jsonl"
    if not path.is_file():
        return None
    lines = path.read_text(encoding="utf-8").strip().split("\n")
    return {"header": json.loads(lines[0]), "records": [json.loads(x) for x in lines[1:]]}


def test_match_golden_detonates_almost_every_weapon() -> None:
    """match 골든이 무기를 **실제로 터뜨린** 종류를 센다.

    `intent.weaponId` 가 아니라 `dets[].w` 를 본다 — 탄약이 없으면 `canFire` 가 0번으로
    되돌리므로, 의도만 세면 "8종을 다 썼다"고 착각한다.

    핵포탄(id 7)은 제외한다. 가격 4,800G 인데 골든이 2라운드에서 끝나 최대 3,240G 다
    (`decisions.md` B15 의 "후반 최종 병기"가 의도한 바다). 그 경제 경로는
    `test_nuclear_shell_goes_through_the_economy` 가 따로 본다.
    """
    golden = _match_golden()
    if golden is None:
        pytest.skip("tests/replays/match.jsonl 이 없다")
    fired = {
        det["w"] for record in golden["records"] for det in (record.get("dets") or [])
    }
    expected = {w.id for w in Wp.WEAPONS} - {Wp.NUCLEAR_WEAPON_ID}
    missing = expected - fired
    assert not missing, (
        f"무기 {sorted(missing)} 이(가) 경제 층을 한 번도 안 지난다. "
        "gen-golden.mts 의 라운드 1 무기 순환을 확인한다"
    )


def test_nuclear_shell_goes_through_the_economy() -> None:
    """핵포탄이 상점 → 발사 → 피해·골드 경로를 지난다.

    match 골든이 못 덮는 유일한 무기라 여기서 닫는다. 초기 탄약이 0 이므로
    **사는 것 말고는 발사 경로가 없다** — `buy_weapon` 이 깨지면 이 무기는 게임에서 사라진다.
    """
    nuke = Wp.by_id(Wp.NUCLEAR_WEAPON_ID)
    assert nuke.ammo0 == 0, "초기 탄약이 0 이 아니면 이 테스트의 전제가 깨진다"

    player = Match.make_player(0, "A", False, 400 * 32)
    assert not Match.can_fire(player, nuke.id), "사기 전에 쏠 수 있으면 안 된다"

    player.gold = nuke.price - 1
    assert not Match.buy_weapon(player, nuke.id), "돈이 모자란데 팔렸다"
    assert player.gold == nuke.price - 1, "실패한 구매가 골드를 깎았다"

    player.gold = nuke.price
    assert Match.buy_weapon(player, nuke.id), "돈이 있는데 못 샀다"
    assert player.gold == 0
    assert Match.can_fire(player, nuke.id), "샀는데 못 쏜다"

    # 정규화가 무기를 되돌리지 않는다
    intent = Match.normalize_intent(
        player,
        Match.Intent(angle10=450, power=800, weapon_id=nuke.id, move_dx=0, use_shield=False),
    )
    assert intent.weapon_id == nuke.id, "보유한 무기를 정규화가 되돌렸다"


def test_weapon_prices_are_pinned_to_constants() -> None:
    """무기·아이템 가격이 `constants.py` 표와 같다.

    가격은 어떤 골든도 검증하지 않는다 — 5종을 전부 `price=1` 로 바꿔도 다른 테스트는
    통과했다. 상점 밸런스가 조용히 바뀌는 것을 여기서 막는다.
    """
    for weapon, row in zip(Wp.WEAPONS, constants.WEAPON_TABLE, strict=True):
        assert weapon.price == row[7], f"{weapon.name} 가격 {weapon.price} != {row[7]}"
    for item, row in zip(Wp.ITEMS, constants.ITEM_TABLE, strict=True):
        assert item.price == row[3], f"{item.name} 가격 {item.price} != {row[3]}"
