"""정수 수학 헬퍼 — `client/src/sim/intmath.ts` 의 1:1 번역.

`docs/simulation.md` §2.2 · §5.1, `docs/terrain.md` §7

**`sim/` 안에서 나눗셈과 32비트 해시가 허용되는 유일한 모듈이다.**
`server/tests/test_determinism.py::test_no_float` 이 이 파일만 화이트리스트로 둔다.

────────────────────────────────────────────────────────────────────────────
numpy uint32 가 JS `Math.imul` 과 같은가 — 확인했다

    x = np.arange(4, dtype=np.uint32) * np.uint32(0x9E3779B1)
      → [0, 2654435761, 1013904226, 3668339987]
    JS: [0, 2654435761, 1013904226, 3668339987]

랩어라운드가 일치하고, uint32 의 ``>>`` 는 논리 시프트다. 그래서 해시를
JS 와 비트 단위로 같게 옮길 수 있다. 곱셈 오버플로 경고는 ``np.errstate`` 로 끈다 —
**랩어라운드가 버그가 아니라 사양이다.**
"""

from __future__ import annotations

import numpy as np
import numpy.typing as npt

U32 = np.uint32

FNV_OFFSET = 0x811C9DC5
FNV_PRIME = 0x01000193

_M1 = U32(0x9E3779B1)
_M2 = U32(0x85EBCA77)
_M3 = U32(0xC2B2AE3D)
_A1 = U32(0x2545F491)
_A2 = U32(0x85EBCA6B)
_PRIME = U32(FNV_PRIME)


def floor_div(a: int, b: int) -> int:
    """floor 나눗셈. `docs/simulation.md` §4.3 이 허용한 **유일한 나눗셈**이다.

    Python 의 ``//`` 가 이미 floor 이므로 그대로 쓰면 되지만, TS 쪽에
    ``floorDiv`` 헬퍼가 있으므로 이름을 맞춰 둔다 — 두 구현을 나란히 놓고
    읽을 때 대응이 눈에 보여야 한다.

        floor_div(-7, 2) == -4      (JS 의 (-7/2)|0 은 -3 이라 쓸 수 없다)
    """
    return a // b


def isqrt(n: int) -> int:
    """정수 제곱근. ``math.sqrt`` 금지 — libm 이 플랫폼마다 다를 수 있다.

    Python 표준 ``math.isqrt`` 는 정확하지만 ``math`` import 자체가
    `test_no_float` 에 걸린다. 뉴턴법을 직접 쓴다 (TS 쪽과 같은 절차).
    """
    if n <= 0:
        return 0
    if n < 4:
        return 1
    x = n
    y = (x + 1) >> 1
    while y < x:
        x = y
        y = (x + n // x) >> 1
    return x


def iabs(v: int) -> int:
    """절댓값. ``abs()`` 로 충분하지만 TS 쪽 ``iabs`` 와 이름을 맞춘다."""
    return -v if v < 0 else v


def clamp_int(v: int, lo: int, hi: int) -> int:
    """정수 클램프. TS 쪽 ``clampInt`` 와 1:1."""
    if v < lo:
        return lo
    if v > hi:
        return hi
    return v


def hash32_scalar(seed: int, x: int, y: int, step: int) -> int:
    """스칼라 해시. `docs/terrain.md` §7.1.

    벡터판(`hash32`)과 **같은 값**을 내야 한다 — 테스트가 대조한다.
    """
    v = (
        seed
        ^ ((x * 0x9E3779B1) & 0xFFFFFFFF)
        ^ ((y * 0x85EBCA77) & 0xFFFFFFFF)
        ^ ((step * 0xC2B2AE3D) & 0xFFFFFFFF)
    ) & 0xFFFFFFFF
    h = FNV_OFFSET
    for sh in (0, 8, 16, 24):
        h = ((h ^ ((v >> sh) & 0xFF)) * FNV_PRIME) & 0xFFFFFFFF
    h = (h ^ (h >> 15)) & 0xFFFFFFFF
    h = (h * 0x2545F491) & 0xFFFFFFFF
    h = (h ^ (h >> 13)) & 0xFFFFFFFF
    h = (h * 0x85EBCA6B) & 0xFFFFFFFF
    return (h ^ (h >> 16)) & 0xFFFFFFFF


def hash32(
    seed: int,
    x: npt.NDArray[np.uint32],
    y: npt.NDArray[np.uint32],
    step: int,
) -> npt.NDArray[np.uint32]:
    """벡터 해시. `x`, `y` 는 uint32 배열, `seed`·`step` 은 스칼라.

    **최종 확산 단계를 빼면 안 된다.** FNV-1a 는 하위 비트로 확산되지 않아
    ``h & 1`` 이 입력 비트의 XOR 패리티가 된다 — `terrain.md` §7.1.1 실측.
    """
    with np.errstate(over="ignore"):
        step_term = U32((step * 0xC2B2AE3D) & 0xFFFFFFFF)
        v = (x * _M1) ^ (y * _M2) ^ U32(seed & 0xFFFFFFFF) ^ step_term
        h = np.full(v.shape, FNV_OFFSET, dtype=U32)
        for sh in (0, 8, 16, 24):
            h = (h ^ ((v >> U32(sh)) & U32(0xFF))) * _PRIME
        h ^= h >> U32(15)
        h *= _A1
        h ^= h >> U32(13)
        h *= _A2
        h ^= h >> U32(16)
    return h


def fnv1a32(buf: bytes | bytearray | memoryview) -> int:
    """바이트열의 FNV-1a 32비트. `docs/terrain.md` §7.2.

    격자 체크섬이 이걸 쓴다. **순차 의존이라 벡터화할 수 없다** —
    519,400 바이트에 약 57 ms 다. 턴당 1회이므로 문제되지 않는다.
    """
    h = FNV_OFFSET
    for b in buf:
        h = ((h ^ b) * FNV_PRIME) & 0xFFFFFFFF
    return h


def hex8(u: int) -> str:
    return f"{u & 0xFFFFFFFF:08X}"
