"""결정론적 초기 맵 생성 — ``docs/mapgen.md`` 의 Python 미러."""

from __future__ import annotations

import numpy as np
import numpy.typing as npt

from talus import constants

from .intmath import clamp_int, hash32_scalar, iabs
from .terrain import BEDROCK, EMPTY, H, N, ROCK, SAND, SCREE, SOIL, W

MAPGEN_VERSION = constants.MAPGEN_VERSION
NOISE_SHIFT = 7
SURFACE_BASE = 170
SURFACE_AMP = 60
BEDROCK_Y = 522

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


def _generated_surface(map_seed: int, x: int) -> int:
    sample = x >> NOISE_SHIFT
    fraction = x & NOISE_MASK
    a = hash32_scalar(map_seed, sample, NOISE_SALT, 0) & 0xFFFF
    b = hash32_scalar(map_seed, sample + 1, NOISE_SALT, 0) & 0xFFFF
    noise = a + (((b - a) * fraction) >> NOISE_SHIFT)
    return clamp_int(SURFACE_BASE + (((noise - 32768) * SURFACE_AMP) >> 16), 96, 260)


def _build_layers(target: npt.NDArray[np.uint8], surface: list[int]) -> None:
    for x in range(W):
        y = surface[x]
        _fill_vertical(target, x, y, y + 17, SAND)
        y += 18
        _fill_vertical(target, x, y, y + 27, SOIL)
        y += 28
        _fill_vertical(target, x, y, y + 9, SAND)
        y += 10
        _fill_vertical(target, x, y, y + 11, SCREE)
        y += 12
        _fill_vertical(target, x, y, y + 39, SOIL)
        y += 40
        _fill_vertical(target, x, y, BEDROCK_Y - 1, ROCK)
        _fill_vertical(target, x, BEDROCK_Y, H - 1, BEDROCK)


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
    _build_layers(target, surface)
    _add_anchors(target, surface, map_seed)
    _add_arch(target, surface, map_seed)
    _seal_edges(target.reshape(N))
    return target.reshape(N)


def choose_spawn_cells(source: npt.NDArray[np.uint8], player_count: int) -> list[int]:
    if source.size != N:
        raise ValueError("grid length must be 960 * 540")
    if player_count < 2 or player_count > 6:
        raise ValueError("player_count must be 2..6")

    selected: list[int] = []
    for slot in range(player_count):
        target = ((slot + 1) * W) // (player_count + 1)
        start = clamp_int(target - 72, 16, W - 17)
        end = clamp_int(target + 72, 16, W - 17)
        best_x = -1
        best_score = 0x7FFFFFFF

        for x in range(start, end + 1):
            separated = True
            for other in selected:
                if iabs(x - other) < 96:
                    separated = False
                    break
            if not separated:
                continue

            y = surface_cell_y(source, x)
            flatness = iabs(surface_cell_y(source, x - 6) - y) + iabs(
                surface_cell_y(source, x + 6) - y
            )
            score = flatness * 256 + iabs(x - target)
            if score < best_score:
                best_score = score
                best_x = x

        selected.append(clamp_int(target, 16, W - 17) if best_x < 0 else best_x)

    selected.sort()
    return selected
