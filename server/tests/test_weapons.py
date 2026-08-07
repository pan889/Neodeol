"""무기 경제와 후반 병기 규칙."""

from talus.sim import match as Match
from talus.sim import weapons as Wp


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
