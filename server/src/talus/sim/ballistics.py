"""탄도 · 탱크 — `client/src/sim/ballistics.ts` 의 1:1 번역.

`docs/simulation.md` §2 §4 §5 §6 / `docs/roadmap.md` Phase 3

**창의성을 발휘하지 않는다.** 규칙을 다시 설계하면 Phase 0~1 의 실측 검증이 무효가 된다.
TS 와 다른 것은 언어 관용구뿐이고, 연산 순서·시프트·클램프는 한 글자도 바꾸지 않는다.

────────────────────────────────────────────────────────────────────────────
자동자와 달리 여기는 numpy 벡터화를 하지 않는다

궤적은 **순차 의존**이다 — 틱 t 의 위치가 t+1 의 충돌 판정을 정한다. 벡터화할 축이
없고, 한 발이 최대 1,800틱이라 순수 Python 루프로 충분하다. 자동자는 매 스텝 519k 셀을
독립적으로 훑기 때문에 벡터화가 필수였던 것이고, 그 이유가 여기엔 없다.

────────────────────────────────────────────────────────────────────────────
정수 폭

TS 는 ``>>`` 가 int32 로 강제 절단하는데 Python 정수는 무한 정밀도다. 실제 값이
int32 를 넘으면 **두 구현이 갈라진다.** 넘지 않음을 확인해 둔다 (§8 상수 기준):

    v0 = (power * 624) >> 10        power ≤ 1000  →  v0 ≤ 609
    v0 * COS                        ≤ 609 * 4096 = 2,494,464
    vx * k                          ≤ 609 * 39   =    23,751
    dx*dx + dy*dy                   ≤ 30720² + 17280² = 1,242,316,800  < 2³¹

경계에 여유가 큰 쪽은 아니므로, 상수를 키울 때(특히 ``POWER_SCALE``, 맵 크기)
이 표를 다시 계산한다. ``test_ballistics_fits_int32`` 가 이걸 지킨다.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from talus import constants

from . import trig
from .intmath import clamp_int, floor_div, iabs, isqrt
from .terrain import EMPTY, H, W, grid

# ── 좌표계 (§2.1) ──────────────────────────────────────────────────────────
SUBPX = 16
CELL_SUBPX = 32  # 2 px
CELL_SHIFT = 5  # subpx → cell 은 >> 5
PX_SHIFT = 4  # subpx → px 는 >> 4
MAP_W_SUB = W * CELL_SUBPX  # 30720
MAP_H_SUB = H * CELL_SUBPX  # 17280

TANK_W = 384  # 24 px
TANK_H = 256  # 16 px
MAX_HP = 100
TANK_TILT_MAX10 = 140  # ±14.0°
TANK_TILT_SAMPLE = (TANK_W * 7) >> 4


# ── 상수 (§8). `talus/constants.py` 가 기계 판독 사본이다 ──────────────────
@dataclass
class BallisticsConfig:
    gravity: int = 12
    power_scale: int = 624  # B12 확정 — 최대 파워 45° 사거리 = 맵 폭
    wind_max: int = 4
    drag_q16: int = 0
    max_flight_ticks: int = 1800
    self_hit_ignore: int = 8
    barrel_len: int = constants.BARREL_LEN_SUBPX
    fall_safe_px: int = 24
    fall_damage_num: int = 1
    fall_damage_shift: int = 1
    burial_permille: int = 800
    burial_damage: int = 6


CFG = BallisticsConfig()


# ── 셀 조회. 격자 밖 규칙은 `terrain.md` §1.1 ─────────────────────────────
def solid_at_sub(xs: int, ys: int) -> bool:
    if ys < 0:
        return False  # 위쪽 밖은 통과
    if xs < 0 or xs >= MAP_W_SUB:
        return False  # 좌우 밖은 통과
    if ys >= MAP_H_SUB:
        return False  # 아래쪽 밖은 소멸로 따로 처리
    cx = xs >> CELL_SHIFT
    cy = ys >> CELL_SHIFT
    return bool(grid[cy * W + cx] != EMPTY)


@dataclass
class Tank:
    slot: int
    name: str
    x: int
    y: int
    hp: int = MAX_HP
    alive: bool = True
    buried: bool = False
    angle10: int = 450
    power: int = 600


@dataclass
class ShotResult:
    path: list[tuple[int, int]] = field(default_factory=list)
    hit: str = "timeout"  # "terrain" | "tank" | "void" | "timeout"
    hit_x: int = 0
    hit_y: int = 0
    hit_tank: int = -1
    apex_reached: bool = False
    apex_x: int = 0
    apex_y: int = 0
    apex_vx: int = 0
    apex_vy: int = 0


def simulate_shot(
    x0: int,
    y0: int,
    angle10: int,
    power: int,
    wind: int,
    shooter_idx: int,
    tanks: list[Tank] | None,
    stop_at_apex: bool = False,
) -> ShotResult:
    """발사. 궤적 전체를 한 번에 계산해 돌려준다.

    서버가 계산하고 클라가 재생하는 netcode 구조(§2.3)와 같은 모양이다 —
    클라가 주장하는 것은 각도·파워·무기뿐이고 착탄점은 여기서 나온다
    (CLAUDE.md 절대 규칙 5).
    """
    v0 = (power * CFG.power_scale) >> 10
    vx = (v0 * trig.cos_q12(angle10)) >> 12
    vy = -((v0 * trig.sin_q12(angle10)) >> 12)  # 괄호 필수 — §2.2
    return _integrate(x0, y0, vx, vy, wind, shooter_idx, tanks, stop_at_apex)


def continue_shot(
    x0: int, y0: int, vx: int, vy: int, wind: int, shooter_idx: int, tanks: list[Tank] | None
) -> ShotResult:
    """자탄용 — 이미 정해진 속도에서 이어 적분한다 (분열탄)."""
    return _integrate(x0, y0, vx, vy, wind, shooter_idx, tanks, False)


def _integrate(
    x0: int,
    y0: int,
    vx0: int,
    vy0: int,
    wind: int,
    shooter_idx: int,
    tanks: list[Tank] | None,
    stop_at_apex: bool,
) -> ShotResult:
    vx, vy = vx0, vy0
    x, y = x0, y0
    res = ShotResult()

    for t in range(CFG.max_flight_ticks):
        # 틱당 순서를 고정한다 (§4.2). 순서가 바뀌면 궤적이 달라진다.
        vx += wind
        vy += CFG.gravity
        if CFG.drag_q16 != 0:
            vx -= (vx * CFG.drag_q16) >> 16

        # §4.3 — 틱 내 세분화. 잔차를 없애려 **절대 위치**로 누적한다.
        # 차분(pos += floor_div(v, steps))을 반복하면 틱당 최대 4% 를 잃는다.
        length = iabs(vx) + iabs(vy)
        steps = (length >> CELL_SHIFT) + 1  # 이동량이 항상 32 subpx 이하
        sx, sy = x, y
        done = False

        for k in range(1, steps + 1):
            x = sx + floor_div(vx * k, steps)
            y = sy + floor_div(vy * k, steps)

            if y >= MAP_H_SUB:
                res.hit = "void"
                done = True
                break
            if solid_at_sub(x, y):
                res.hit = "terrain"
                done = True
                break

            if tanks is not None:
                for i, tk in enumerate(tanks):
                    if not tk.alive:
                        continue
                    if i == shooter_idx and t < CFG.self_hit_ignore:
                        continue
                    if (
                        tk.x - (TANK_W >> 1) <= x <= tk.x + (TANK_W >> 1)
                        and tk.y - TANK_H <= y <= tk.y
                    ):
                        res.hit = "tank"
                        res.hit_tank = i
                        done = True
                        break
                if done:
                    break

        if len(res.path) < 2048:
            res.path.append((x, y))
        if done:
            break

        # 정점 — vy 가 처음 0 이상이 되는 틱. 분열탄이 거기서 갈라진다.
        if stop_at_apex and not res.apex_reached and vy >= 0:
            res.apex_reached = True
            res.apex_x, res.apex_y = x, y
            res.apex_vx, res.apex_vy = vx, vy
            break

    res.hit_x, res.hit_y = x, y
    return res


def flat_range_px(angle10: int, power: int, wind: int) -> int:
    """평지 사거리 (px). §8.1

    지형을 무시하고 "발사 높이로 되돌아온 순간"까지의 수평 거리다.
    `tools/ballistics-check.mjs` 와 **같은 정의**여야 문서 표와 대조할 수 있다.
    """
    v0 = (power * CFG.power_scale) >> 10
    vx = (v0 * trig.cos_q12(angle10)) >> 12
    vy = -((v0 * trig.sin_q12(angle10)) >> 12)
    x = 0
    y = 0
    for _t in range(CFG.max_flight_ticks):
        vx += wind
        vy += CFG.gravity
        if CFG.drag_q16 != 0:
            vx -= (vx * CFG.drag_q16) >> 16
        length = iabs(vx) + iabs(vy)
        steps = (length >> CELL_SHIFT) + 1
        sx, sy = x, y
        for k in range(1, steps + 1):
            x = sx + floor_div(vx * k, steps)
            y = sy + floor_div(vy * k, steps)
            if y >= 0 and vy > 0:
                return x >> PX_SHIFT
    return x >> PX_SHIFT


def _support_y_at_tank(tank: Tank, x_sub: int) -> int:
    cx = clamp_int(x_sub >> CELL_SHIFT, 0, W - 1)
    foot = clamp_int(tank.y >> CELL_SHIFT, 0, H - 1)
    start = max(0, foot - 8)
    end = min(H - 1, foot + 16)
    for y in range(start, end + 1):
        if grid[y * W + cx] != EMPTY:
            return y
    return foot


def tank_tilt10(tank: Tank) -> int:
    """좌우 궤도 지지점으로 계산한 차체 경사. +는 화면 기준 시계 방향."""
    left_x = clamp_int((tank.x - TANK_TILT_SAMPLE) >> CELL_SHIFT, 0, W - 1)
    right_x = clamp_int((tank.x + TANK_TILT_SAMPLE) >> CELL_SHIFT, 0, W - 1)
    run = right_x - left_x
    if run <= 0:
        return 0
    rise = _support_y_at_tank(tank, tank.x + TANK_TILT_SAMPLE) - _support_y_at_tank(
        tank, tank.x - TANK_TILT_SAMPLE
    )
    if rise == 0:
        return 0
    magnitude = iabs(rise)
    best_angle = 0
    best_error = 0x7FFFFFFF
    for angle10 in range(TANK_TILT_MAX10 + 1):
        error = iabs(
            magnitude * trig.cos_q12(angle10) - run * trig.sin_q12(angle10)
        )
        if error < best_error:
            best_error = error
            best_angle = angle10
    return -best_angle if rise < 0 else best_angle


def effective_angle10(tank: Tank, angle10: int) -> int:
    """차체 기준 상대 조준각을 월드 절대각으로 변환한다."""
    return clamp_int(angle10 - tank_tilt10(tank), 0, 1800)


@dataclass(frozen=True)
class ShotPose:
    x: int
    y: int
    angle10: int
    tilt10: int


def shot_pose(tank: Tank, angle10: int) -> ShotPose:
    """기울어진 포탑 중심과 실제 월드 발사각으로 계산한 포신 끝."""
    tilt10 = tank_tilt10(tank)
    abs_tilt10 = iabs(tilt10)
    tilt_sin = trig.sin_q12(abs_tilt10)
    if tilt10 < 0:
        tilt_sin = -tilt_sin
    anchor_x = tank.x + ((TANK_H * tilt_sin) >> 12)
    anchor_y = tank.y - ((TANK_H * trig.cos_q12(abs_tilt10)) >> 12)
    shot_angle10 = clamp_int(angle10 - tilt10, 0, 1800)
    return ShotPose(
        x=anchor_x + ((CFG.barrel_len * trig.cos_q12(shot_angle10)) >> 12),
        y=anchor_y - ((CFG.barrel_len * trig.sin_q12(shot_angle10)) >> 12),
        angle10=shot_angle10,
        tilt10=tilt10,
    )


def muzzle(tank: Tank, angle10: int) -> tuple[int, int]:
    pose = shot_pose(tank, angle10)
    return pose.x, pose.y


# ══ 피해 (§5.1) ═══════════════════════════════════════════════════════════
@dataclass
class WeaponDamage:
    max_damage: int
    blast_radius: int  # subpx. **2의 거듭제곱 강제**
    damage_shift: int  # = log2(blast_radius)


@dataclass
class DamageHit:
    idx: int
    dmg: int
    dist: int


def compute_damage(cx: int, cy: int, weapon: WeaponDamage, tanks: list[Tank]) -> list[DamageHit]:
    """피해를 계산만 한다. **적용하지 않는다.**

    §5.2 대로 카빙 전 위치 기준으로 전부 계산한 뒤 한꺼번에 적용해야 한다.
    순차 적용하면 슬롯 1번 폭발로 밀린 탱크가 2번을 피해 슬롯 순서가 유불리를 만든다.
    """
    out: list[DamageHit] = []
    for i, tk in enumerate(tanks):
        if not tk.alive:
            continue
        dx = tk.x - cx
        dy = tk.y - (TANK_H >> 1) - cy
        dist = isqrt(dx * dx + dy * dy)
        if dist >= weapon.blast_radius:
            continue
        out.append(
            DamageHit(
                idx=i,
                dmg=(weapon.max_damage * (weapon.blast_radius - dist)) >> weapon.damage_shift,
                dist=dist,
            )
        )
    return out


# ══ 탱크 재배치 (§6.1) ════════════════════════════════════════════════════
def reseat_tank(tank: Tank) -> int:
    """정착이 **완전히** 끝난 뒤 한 번만 부른다 — 연결성 재검사 루프까지 끝난 뒤다.

    반환: 낙하 픽셀. 화면 밖으로 나갔으면 -1.
    """
    start_y = tank.y
    guard = 0
    while guard < H * 2:
        guard += 1
        if tank.y >= MAP_H_SUB:
            return -1  # 화면 아래 이탈 → 즉사
        if supported(tank):
            break
        tank.y += CELL_SUBPX
    # 발밑이 솟아올랐으면 밀어올린다.
    # 임계는 **매몰 판정과 같은 값**이다 (`decisions.md` B13). 예전에는 1000‰ 에서만
    # 밀어올려서, 800~999‰ 에 안착하면 탈출 경로가 원리적으로 없었다 —
    # 턴당 6 피해로 약 17턴 확정사였고, B13 이 경계한 "묻히는 것이 즉사와 다름없으면
    # 매몰을 별도 상태로 둔 의미가 없다"가 정확히 그 상태다.
    guard = 0
    while guard < H * 2 and buried_fraction(tank) >= CFG.burial_permille:
        guard += 1
        tank.y -= CELL_SUBPX
    fall_px = (tank.y - start_y) >> PX_SHIFT
    return fall_px if fall_px > 0 else 0


def supported(tank: Tank) -> bool:
    half_w = TANK_W >> 1
    foot_y = tank.y
    if foot_y >= MAP_H_SUB:
        return False
    xs = tank.x - half_w
    while xs <= tank.x + half_w:
        if solid_at_sub(xs, foot_y):
            return True
        xs += CELL_SUBPX
    return False


def buried_fraction(tank: Tank) -> int:
    """AABB 안에서 비-EMPTY 셀의 비율 (‰). 매몰 판정용 (§6.1)."""
    half_w = TANK_W >> 1
    filled = 0
    total = 0
    ys = tank.y - TANK_H
    while ys < tank.y:
        xs = tank.x - half_w
        while xs <= tank.x + half_w:
            total += 1
            if solid_at_sub(xs, ys):
                filled += 1
            xs += CELL_SUBPX
        ys += CELL_SUBPX
    return 0 if total == 0 else floor_div(filled * 1000, total)


def fall_damage(fall_px: int) -> int:
    if fall_px <= CFG.fall_safe_px:
        return 0
    return ((fall_px - CFG.fall_safe_px) * CFG.fall_damage_num) >> CFG.fall_damage_shift


def surface_sub_y(x_sub: int) -> int:
    """그 열의 지표면 y (subpx). 지형이 없으면 맵 바닥."""
    cx = clamp_int(x_sub >> CELL_SHIFT, 0, W - 1)
    for cy in range(H):
        if grid[cy * W + cx] != EMPTY:
            return cy * CELL_SUBPX
    return MAP_H_SUB


def make_tank(slot: int, x_sub: int, name: str) -> Tank:
    return Tank(
        slot=slot,
        name=name,
        x=x_sub,
        y=surface_sub_y(x_sub),
        hp=MAX_HP,
        alive=True,
        buried=False,
        angle10=450 if slot % 2 == 0 else 1350,
        power=600,
    )
