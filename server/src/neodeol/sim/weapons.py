"""무기 8종 — `client/src/sim/weapons.ts` 의 1:1 번역.

`docs/game-design.md` §6.1 · `docs/decisions.md` C1 C9 · `docs/roadmap.md` Phase 3

**창의성을 발휘하지 않는다.** 규칙과 상수는 TS 쪽이 기준이고 여기는 번역이다.

────────────────────────────────────────────────────────────────────────────
무기 설계 원칙: **모든 무기는 지형을 다르게 바꾼다.** 데미지만 다른 무기는 없다.

값은 전부 **잠정**이다 (`decisions.md` C1). 스키마만 확정으로 취급한다.

    max_damage    dist=0 에서의 피해
    blast_radius  피해 반경 (subpx). **2의 거듭제곱 강제** — simulation.md §5.1
    damage_shift  = log2(blast_radius). 생성 시점에 강제한다
    carve_cells   카빙 반경 (셀). blast_radius 와 독립이다 (성형탄이 이걸 쓴다)
    ammo0         라운드 1 시작 시 보유량. None = 무한
    price         상점 1발 가격

────────────────────────────────────────────────────────────────────────────
난수를 쓰는 곳은 한 군데뿐이다

전복탄이 좌우 낙차가 **같을 때** 방향을 고르는 지점. `hash32_scalar(seed, x, y, k)`
를 쓰므로 재생 가능하다. 분열탄의 산개는 좌우 대칭 고정 오프셋이라 난수가 아예 없다.
`random` 은 이 파일 어디에도 없다 (절대 규칙 1).

────────────────────────────────────────────────────────────────────────────
TS 와 다른 것이 하나 있다 — 궤적 버퍼

TS 의 `ShotResult.xs/ys` 는 **모듈 전역 버퍼를 공유**해서 다음 발사가 덮어쓴다.
Python 의 `ShotResult.path` 는 발사마다 새 리스트다. 결과는 같지만, TS 쪽에서만
"복사를 늦게 해서 깨지는" 버그가 가능하다 — 그리고 그건 교차 검증이 못 잡는다
(Python 은 애초에 안 깨지므로 대조가 성립하지 않는다). TS 쪽 `copyPts` 주석 참조.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from neodeol import constants

from . import ballistics as B
from . import terrain as T
from .intmath import hash32_scalar

WeaponKind = str  # "plain" | "split" | "burrow" | "roll" | "deposit"


def shift_of(r: int) -> int:
    """log2 검증 — 2의 거듭제곱이 아니면 dist=0 피해가 `max_damage` 가 아니다."""
    s = 0
    v = r
    while v > 1:
        v >>= 1
        s += 1
    if (1 << s) != r:
        raise ValueError(f"blast_radius 가 2의 거듭제곱이 아니다: {r}")
    return s


@dataclass(frozen=True)
class Weapon:
    id: int
    name: str
    kind: WeaponKind
    max_damage: int
    blast_radius: int
    carve_cells: int
    ammo0: int | None
    price: int
    desc: str
    split_count: int = 0
    split_spread: int = 0
    burrow_cells: int = 0
    roll_cells: int = 0
    deposit_cells: int = 0
    deposit_mat: int = 0

    @property
    def damage_shift(self) -> int:
        return shift_of(self.blast_radius)

    def to_damage(self) -> B.WeaponDamage:
        """`ballistics.compute_damage` 가 받는 형태로 좁힌다."""
        return B.WeaponDamage(
            max_damage=self.max_damage,
            blast_radius=self.blast_radius,
            damage_shift=self.damage_shift,
        )


def _from_table() -> list[Weapon]:
    """`constants.WEAPON_TABLE` 에서 무기 표를 만든다.

    **값을 여기 적지 않는다.** 그 전에는 `weapons.ts`/`weapons.py` 에만 있어서 밸런스를
    바꿔도 `SIM_VERSION` 이 안 바뀌었고, 규칙이 다른 두 클라이언트가 같은 방에 들어갈 수
    있었다. 이제 `constants.py` 가 유일한 사본이고 해시에 들어간다.
    TS 쪽 하드코딩이 여기와 같은지는 골든 헤더 대조가 본다.
    """
    out: list[Weapon] = []
    for row in constants.WEAPON_TABLE:
        (
            wid, name, kind, max_damage, blast_radius, carve_cells, ammo0, price,
            split_count, split_spread, burrow_cells, roll_cells, deposit_cells, deposit_mat,
        ) = row
        out.append(
            Weapon(
                id=wid,
                name=name,
                kind=kind,
                max_damage=max_damage,
                blast_radius=blast_radius,
                carve_cells=carve_cells,
                ammo0=None if ammo0 < 0 else ammo0,
                price=price,
                desc=WEAPON_DESC[wid],
                split_count=split_count,
                split_spread=split_spread,
                burrow_cells=burrow_cells,
                roll_cells=roll_cells,
                deposit_cells=deposit_cells,
                deposit_mat=deposit_mat,
            )
        )
    return out


#: 설명문은 표현 텍스트라 상수 해시에 넣지 않는다 — 번역해도 규칙이 안 바뀐다.
WEAPON_DESC: tuple[str, ...] = (
    "작은 원형 구덩이. 무한",
    "큰 구덩이 + 넓은 붕괴 유발",
    "정점에서 5발로 갈라져 산개",
    "지면에 박힌 뒤 아래로 파고들어 폭발",
    "착탄 후 경사를 따라 굴러가서 폭발",
    "피해 높고 구덩이는 아주 작다. 지형 보존",
    "폭발 대신 흙을 쌓는다. 유일한 지형 추가",
    "최대 200 피해 · 광역 파괴 · 버섯구름. 초기 0발",
)

WEAPONS: list[Weapon] = _from_table()

NUCLEAR_WEAPON_ID = 7


@dataclass(frozen=True)
class Item:
    id: int
    key: str
    name: str
    price: int
    desc: str


#: 비-포탄 아이템 (`game-design.md` §6.2).
#: **측풍계가 정보를 숨기지 않는 이유**: 모든 클라가 같은 입력으로 같은 계산을 하므로
#: "나만 정확한 바람 값을 안다"는 것이 원리적으로 불가능하다. 서버가 누군가에게 다른
#: 값을 보내면 그 사람의 재생이 갈라진다. 현재 값은 모두 표시하고 다음 턴을 예보하는 UI 아이템이다.
#: 설명문은 표현 텍스트라 해시 대상이 아니다.
ITEM_DESC: tuple[str, ...] = (
    "1회 피격 무효",
    "낙하 피해 무효. 자동 발동",
    "턴당 좌우 이동",
    "다음 턴 바람의 세기와 방향을 예보",
)

ITEMS: list[Item] = [
    Item(id=i, key=k, name=n, price=p, desc=ITEM_DESC[i])
    for i, k, n, p in constants.ITEM_TABLE
]


def by_id(wid: int) -> Weapon:
    return WEAPONS[wid] if 0 <= wid < len(WEAPONS) else WEAPONS[0]


# ══ 발사 해결 — 발사 1회가 **폭발 여러 개**를 만들 수 있다 ════════════════
@dataclass
class Leg:
    pts: list[tuple[int, int]]
    kind: str  # "main" | "split" | "burrow" | "roll"


@dataclass
class Detonation:
    x: int
    y: int
    weapon: Weapon


@dataclass
class ShotPlan:
    legs: list[Leg] = field(default_factory=list)
    dets: list[Detonation] = field(default_factory=list)


def _push_det(dets: list[Detonation], s: B.ShotResult, weapon: Weapon) -> None:
    if s.hit in ("void", "timeout"):
        return
    dets.append(Detonation(x=s.hit_x, y=s.hit_y, weapon=weapon))


def resolve_shot(
    x0: int,
    y0: int,
    angle10: int,
    power: int,
    wind: int,
    shooter_idx: int,
    tanks: list[B.Tank] | None,
    weapon: Weapon,
) -> ShotPlan:
    """발사 1회를 궤적 조각과 폭발 지점 목록으로 푼다.

    `dets` 는 **모든 leg 재생이 끝난 뒤 한꺼번에** 적용한다
    (`simulation.md` §5.2 — 피해는 카빙 전 위치 기준으로 전부 계산).
    """
    plan = ShotPlan()

    s = B.simulate_shot(
        x0, y0, angle10, power, wind, shooter_idx, tanks, weapon.kind == "split"
    )
    plan.legs.append(Leg(pts=list(s.path), kind="main"))

    if weapon.kind == "split" and s.apex_reached:
        # 정점에서 갈라진다. 부모는 여기서 소멸하고 자탄 N 발이 이어받는다.
        # 산개는 좌우 대칭 고정 오프셋이라 난수가 없다 — 결정론이 유지된다.
        n = weapon.split_count
        half = (n - 1) >> 1
        ax, ay, avx, avy = s.apex_x, s.apex_y, s.apex_vx, s.apex_vy
        for i in range(n):
            dvx = (i - half) * weapon.split_spread
            sub = B.continue_shot(ax, ay, avx + dvx, avy, wind, shooter_idx, tanks)
            plan.legs.append(Leg(pts=list(sub.path), kind="split"))
            _push_det(plan.dets, sub, weapon)
        return plan

    if s.hit in ("void", "timeout"):
        return plan

    half_cell = B.CELL_SUBPX >> 1

    if weapon.kind == "burrow":
        # 착탄 지점에서 아래로 파고든다. 지형을 뚫고 내려가되 BEDROCK 은 못 뚫는다.
        bx = s.hit_x >> B.CELL_SHIFT
        by = s.hit_y >> B.CELL_SHIFT
        tail: list[tuple[int, int]] = []
        for _d in range(weapon.burrow_cells):
            ny = by + 1
            if ny >= T.H:
                break
            if T.grid[ny * T.W + bx] == T.BEDROCK:
                break
            by = ny
            tail.append((bx * B.CELL_SUBPX + half_cell, by * B.CELL_SUBPX + half_cell))
        if tail:
            plan.legs.append(Leg(pts=tail, kind="burrow"))
        plan.dets.append(
            Detonation(
                x=bx * B.CELL_SUBPX + half_cell,
                y=by * B.CELL_SUBPX + half_cell,
                weapon=weapon,
            )
        )
        return plan

    if weapon.kind == "roll":
        # 표면을 따라 낮은 쪽으로 굴러간다.
        # 매 스텝: 아래가 비면 낙하, 아니면 좌·우 중 **더 낮은 쪽**으로 한 칸.
        # 양쪽이 같으면 §7.1 해시로 결정론적으로 고른다. 내려갈 곳이 없으면 멈춘다.
        rx = s.hit_x >> B.CELL_SHIFT
        ry = s.hit_y >> B.CELL_SHIFT
        trail: list[tuple[int, int]] = []
        for k in range(weapon.roll_cells):
            if ry + 1 < T.H and T.grid[(ry + 1) * T.W + rx] == T.EMPTY:
                ry += 1
            else:
                dl = drop_depth(rx - 1, ry)
                dr = drop_depth(rx + 1, ry)
                if dl == 0 and dr == 0:
                    break  # 양쪽이 다 막혔다
                if dl > dr:
                    go_left = True
                elif dr > dl:
                    go_left = False
                else:
                    go_left = (hash32_scalar(T.CFG.seed, rx, ry, k) & 1) == 0
                rx += -1 if go_left else 1
                if rx < 0 or rx >= T.W:
                    break  # 격자 밖으로 굴러 나갔다
            trail.append((rx * B.CELL_SUBPX + half_cell, ry * B.CELL_SUBPX + half_cell))
        if trail:
            plan.legs.append(Leg(pts=trail, kind="roll"))
        plan.dets.append(
            Detonation(
                x=rx * B.CELL_SUBPX + half_cell,
                y=ry * B.CELL_SUBPX + half_cell,
                weapon=weapon,
            )
        )
        return plan

    # plain / deposit — 착탄 지점 그대로
    plan.dets.append(Detonation(x=s.hit_x, y=s.hit_y, weapon=weapon))
    return plan


def drop_depth(x: int, y: int) -> int:
    """(x, y) 에서 아래로 몇 셀 비어 있는가. 0 이면 그 방향으로 못 간다."""
    if x < 0 or x >= T.W or y + 1 >= T.H:
        return 0
    if T.grid[y * T.W + x] != T.EMPTY:
        return 0  # 그 칸 자체가 막혔다
    d = 0
    while y + 1 + d < T.H and T.grid[(y + 1 + d) * T.W + x] == T.EMPTY and d < 8:
        d += 1
    return d + 1


# ══ 폭발 적용 — 카빙/적층 ═════════════════════════════════════════════════
@dataclass
class DetResult:
    removed: int
    conv: int
    filled: int


def apply_detonation(det: Detonation) -> DetResult:
    """피해 계산은 호출자가 **이 함수를 부르기 전에** 전부 끝내야 한다.

    `simulation.md` §5.2 — 순차 적용하면 슬롯 1번 폭발로 밀린 탱크가 2번을 피해
    슬롯 순서가 유불리를 만든다.
    """
    w = det.weapon
    cx = det.x >> B.CELL_SHIFT
    cy = det.y >> B.CELL_SHIFT
    cx = 0 if cx < 0 else (T.W - 1 if cx > T.W - 1 else cx)
    cy = 0 if cy < 0 else (T.H - 1 if cy > T.H - 1 else cy)

    if w.kind == "deposit":
        filled = T.deposit(cx, cy, w.deposit_cells, w.deposit_mat)
        return DetResult(removed=0, conv=0, filled=filled)
    removed, _conv = T.carve_deferred(cx, cy, w.carve_cells)
    return DetResult(removed=removed, conv=0, filled=0)
