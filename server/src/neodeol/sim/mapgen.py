"""결정론적 초기 맵 생성 — ``docs/mapgen.md`` 의 Python 미러."""

from __future__ import annotations

import numpy as np
import numpy.typing as npt

from neodeol import constants

from .intmath import clamp_int, floor_div, hash32_scalar, iabs
from .terrain import BEDROCK, EMPTY, H, N, ROCK, SAND, SCREE, SOIL, W

MAPGEN_VERSION = constants.MAPGEN_VERSION
NOISE_SHIFT = constants.NOISE_SHIFT
SURFACE_BASE = constants.SURFACE_BASE
SURFACE_AMP = constants.SURFACE_AMP
BEDROCK_Y = constants.MAPGEN_BEDROCK_Y
SPAWN_MIN_GAP = constants.SPAWN_MIN_GAP
SPAWN_MAX_RELIEF = constants.SPAWN_MAX_RELIEF

NOISE_MASK = 127
NOISE_SALT = 0x4D47
ANCHOR_SALT = 0xA11C
ARCH_SALT = 0xA2C4
ANCHOR_BASE_X = (160, 320, 640, 800)


def _fill_vertical(
    target: npt.NDArray[np.uint8],
    x: int,
    y_start: int,
    y_end: int,
    material: int,
) -> None:
    start = clamp_int(y_start, 0, H - 1)
    end = clamp_int(y_end, 0, H - 1)
    if start <= end:
        target[start : end + 1, x] = material


def _peak_at(column: int, center: int, width: int, amplitude: int) -> int:
    return clamp_int(width - iabs(column - center), 0, width) * amplitude // width


def _generated_surface(map_seed: int, column: int) -> int:
    sample = column >> NOISE_SHIFT
    fraction = column & NOISE_MASK
    start = hash32_scalar(map_seed, sample, NOISE_SALT, 0) & 0xFFFF
    end = hash32_scalar(map_seed, sample + 1, NOISE_SALT, 0) & 0xFFFF
    noise = start + (((end - start) * fraction) >> NOISE_SHIFT)
    main_seed = hash32_scalar(map_seed, 0, 0x504B, 0)
    side_seed = hash32_scalar(map_seed, 1, 0x504B, 0)
    valley_seed = hash32_scalar(map_seed, 2, 0x504B, 0)
    main_center = clamp_int(240 + (main_seed & 511), 240, 720)
    side_center = (770 if main_center < 480 else 190) + ((side_seed >> 16) & 63) - 31
    main_peak = _peak_at(column, main_center, 145 + ((main_seed >> 9) & 127), 148 + ((main_seed >> 16) & 63))
    side_peak = _peak_at(column, side_center, 120 + (side_seed & 63), 76 + ((side_seed >> 6) & 47))
    valley = _peak_at(column, (main_center + side_center) // 2, 110 + (valley_seed & 63), 32 + ((valley_seed >> 6) & 31))
    return clamp_int(SURFACE_BASE + (((noise - 32768) * SURFACE_AMP) >> 16) - main_peak - side_peak + valley, 72, 342)


# ══ 지질 구역 (mapgen.md §3.1) ═══════════════════════════════════════════
# `client/src/sim/mapgen.ts` 의 1:1 번역. 맵을 좌우로 나눠 구역마다 다른 지층을 깐다.
#
# 그 전에는 960열 전부가 같은 지층이라 안식각 26.6°/40.3°/44.2° 가 전술적으로 아무
# 일도 하지 않았다 — 어디를 파도 같은 것이 나오니 서 있는 자리가 의미가 없었다.

#: 구역 프로파일. `(bands, bedrock_depth)`.
#: bands 는 위에서부터 [SAND, SOIL, SAND, SCREE, SOIL] 두께이고 남는 깊이는 ROCK 이 채운다.
#: bedrock_depth 가 0 이면 `BEDROCK_Y` 를 그대로 쓴다.
#:
#: **표면 재질이 구역마다 다르다.** 앞 밴드를 0 으로 두어 아래 재질을 노출시킨다 —
#: 전부 SAND 로 시작하면 화면상 구분이 안 되고, 보이지 않으면 전술이 되지 않는다.
#: 지질 구역 프로파일. **값은 `constants.PROVINCE_TABLE` 이 유일한 사본이다** —
#: 여기 적으면 `SIM_VERSION` 이 안 따라온다. mapgen.md §4.1
PROVINCES: tuple[tuple[tuple[int, int, int, int, int], int], ...] = tuple(
    ((row[0], row[1], row[2], row[3], row[4]), row[5]) for row in constants.PROVINCE_TABLE
)

PROVINCE_SALT = 0x9E07
#: 구역 경계가 지층을 수직으로 자르지 않게 섞는 폭 (셀)
PROVINCE_BLEND = constants.PROVINCE_BLEND


def _province_order(map_seed: int) -> list[int]:
    """구역 배치 순열. **한 맵 안에 네 지질이 전부 나오는 것을 보장한다.**

    구역마다 독립 추첨하면 시드에 따라 맵 전체가 한 지질로 덮인다
    (실측: 모래 809열 / 960). 다양성이 이 변경의 전부라 우연에 맡기지 않는다.
    정수 전용 Fisher-Yates 이고 `hash32` 만 쓴다.
    """
    order = [0, 1, 2, 3]
    for i in range(len(order) - 1, 0, -1):
        j = hash32_scalar(map_seed, i, PROVINCE_SALT, 1) % (i + 1)
        order[i], order[j] = order[j], order[i]
    return order


def _province_at(map_seed: int, x: int) -> tuple[int, int, int]:
    """열 `x` 의 구역과 경계 혼합 가중치. 반환 `(a, b, t)`."""
    count = 4 + (hash32_scalar(map_seed, 0, PROVINCE_SALT, 0) & 1)
    width = W // count
    index = x // width
    if index >= count:
        index = count - 1
    local_x = x - index * width
    order = _province_order(map_seed)

    here = order[index % len(PROVINCES)]
    if local_x >= PROVINCE_BLEND or index == 0:
        return here, here, 0
    return order[(index - 1) % len(PROVINCES)], here, local_x


def _blend_band(a: int, b: int, t: int) -> int:
    """두 프로파일을 정수 가중 평균한다. `floor_div` 로 나눈다 (음수 대비)."""
    return a + floor_div((b - a) * t, PROVINCE_BLEND)


def _build_layers(
    target: npt.NDArray[np.uint8], surface: list[int], map_seed: int
) -> None:
    order = (SAND, SOIL, SAND, SCREE, SOIL)
    for x in range(W):
        pa_i, pb_i, t = _province_at(map_seed, x)
        pa_bands, pa_depth = PROVINCES[pa_i]
        pb_bands, pb_depth = PROVINCES[pb_i]
        relief = max(abs(surface[max(0, x - 6)] - surface[x]), abs(surface[min(W - 1, x + 6)] - surface[x]))
        mantle_scale = 0 if relief > 3 else 16 if relief == 3 else 64
        bands = [_blend_band(pa_bands[i], pb_bands[i], t) * mantle_scale // 64 for i in range(5)]
        bedrock_depth = _blend_band(pa_depth, pb_depth, t)

        y = surface[x]
        for i in range(5):
            if bands[i] <= 0:
                continue
            _fill_vertical(target, x, y, y + bands[i] - 1, order[i])
            y += bands[i]

        bedrock_top = BEDROCK_Y
        if bedrock_depth > 0:
            shelf = surface[x] + bedrock_depth
            if shelf < bedrock_top:
                bedrock_top = shelf
        if y < bedrock_top:
            _fill_vertical(target, x, y, bedrock_top - 1, ROCK)
        _fill_vertical(target, x, bedrock_top, H - 1, BEDROCK)


def _add_anchors(
    target: npt.NDArray[np.uint8], surface: list[int], map_seed: int
) -> None:
    for index, base_x in enumerate(ANCHOR_BASE_X):
        jitter = (hash32_scalar(map_seed, index, ANCHOR_SALT, 0) & 31) - 15
        x = clamp_int(base_x + jitter, 24, 935)
        top = clamp_int(surface[x] + 96, 220, 500)
        for column in range(x - 3, x + 3):
            _fill_vertical(target, column, top, H - 1, BEDROCK)


def _add_arch(target: npt.NDArray[np.uint8], surface: list[int], map_seed: int) -> None:
    center = 480 + ((hash32_scalar(map_seed, 0, ARCH_SALT, 0) & 127) - 63)
    left = center - 72
    right = center + 72
    deepest_surface = surface[left]
    for x in range(left + 1, right + 1):
        if surface[x] > deepest_surface:
            deepest_surface = surface[x]
    roof_y = deepest_surface + 24
    leg_bottom = roof_y + 64
    left_bottom = surface[left] + 112
    right_bottom = surface[right] + 112
    if left_bottom > leg_bottom:
        leg_bottom = left_bottom
    if right_bottom > leg_bottom:
        leg_bottom = right_bottom
    leg_bottom = clamp_int(leg_bottom, roof_y + 64, 510)

    for x in range(left, right + 1):
        _fill_vertical(target, x, roof_y, roof_y + 7, ROCK)
    for x in range(left + 8, right - 7):
        _fill_vertical(target, x, roof_y + 8, roof_y + 56, EMPTY)
    for x in range(left, left + 8):
        _fill_vertical(target, x, roof_y, leg_bottom, ROCK)
    for x in range(right - 7, right + 1):
        _fill_vertical(target, x, roof_y, leg_bottom, ROCK)


def surface_cell_y(source: npt.NDArray[np.uint8], x: int) -> int:
    column = clamp_int(x, 0, W - 1)
    source_2d = source.reshape(H, W)
    for y in range(H):
        if int(source_2d[y, column]) != EMPTY:
            return y
    return H - 1


def _seal_edges(target: npt.NDArray[np.uint8]) -> None:
    left_top = surface_cell_y(target, 2)
    right_top = surface_cell_y(target, W - 3)
    target_2d = target.reshape(H, W)
    for x in range(2):
        _fill_vertical(target_2d, x, left_top, H - 1, BEDROCK)
    for x in range(W - 2, W):
        _fill_vertical(target_2d, x, right_top, H - 1, BEDROCK)


def build_map(map_seed: int) -> npt.NDArray[np.uint8]:
    target = np.zeros((H, W), dtype=np.uint8)
    surface = [_generated_surface(map_seed, x) for x in range(W)]
    _build_layers(target, surface, map_seed)
    _add_anchors(target, surface, map_seed)
    _add_arch(target, surface, map_seed)
    _seal_edges(target.reshape(N))
    return target.reshape(N)


def choose_spawn_cells(source: npt.NDArray[np.uint8], player_count: int, spawn_seed: int = 0) -> list[int]:
    if source.size != N:
        raise ValueError("grid length must be 960 * 540")
    if player_count < 2 or player_count > 6:
        raise ValueError("player_count must be 2..6")

    surface = [surface_cell_y(source, column) for column in range(W)]
    selected: list[int] = []
    layout = hash32_scalar(spawn_seed, player_count, 0x5A17, 0) % 3
    center = 80 + hash32_scalar(spawn_seed, 0, 0x5A17, 1) % (W - 160)
    cluster_radius = 48 + player_count * 24
    for slot in range(player_count):
        target = 32 + slot * (W - 64) // (player_count - 1)
        best_x = -1
        best_score = 0x7FFFFFFF
        for search_pass in range(2):
            for column in range(20, W - 20):
                if surface[column] >= H - 12:
                    continue
                if any(iabs(column - other) < SPAWN_MIN_GAP for other in selected):
                    continue
                relief = iabs(surface[column - 6] - surface[column]) + iabs(surface[column + 6] - surface[column])
                if search_pass == 0 and relief > SPAWN_MAX_RELIEF:
                    continue
                distance = iabs(column - center) - cluster_radius if layout == 0 else iabs(column - target) - 64 if layout == 1 else 0
                score = max(0, distance) * 65536 + (hash32_scalar(spawn_seed, column, slot, 0x5A17) & 65535)
                if score < best_score:
                    best_score = score
                    best_x = column
            if best_x >= 0:
                break
        if best_x < 0:
            raise ValueError("not enough separated ground for spawning")
        selected.append(best_x)
    for index in range(len(selected) - 1, 0, -1):
        other = hash32_scalar(spawn_seed, index, 0x5A17, 2) % (index + 1)
        selected[index], selected[other] = selected[other], selected[index]
    return selected
