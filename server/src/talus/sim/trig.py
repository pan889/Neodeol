"""고정소수점 삼각함수 — `client/src/sim/trig.ts` 의 1:1 번역. `docs/simulation.md` §3

**런타임에 `math.sin()` / `math.cos()` 를 호출하지 않는다.** libm 구현이 플랫폼마다
마지막 자리에서 다를 수 있고, 그 한 자리가 lockstep 을 깬다. 서버와 클라이언트가
**같은 파일** `tables/trig.bin` 을 본다.

형식 (생성기: `tools/gen_trig.py`)

    레이아웃   SIN 배열 1801개  →  COS 배열 1801개   (연속, 헤더 없음)
    인덱스    0 ~ 1800         (데시도. 각도 × 10)
    값        int16 리틀엔디언  sin/cos × 4096  (Q12)
    크기      7,204 바이트

**파일을 여기서 읽지 않는다.** `sim/` 은 I/O 를 하지 않는다 (CLAUDE.md 절대 규칙 1).
읽기는 호출자 책임이고 이 모듈은 검증과 조회만 한다 — TS 쪽과 같은 구조다.

    from talus.sim import trig
    trig.load_trig(pathlib.Path("tables/trig.bin").read_bytes())
    vx = (v0 * trig.cos_q12(angle10)) >> 12
    vy = -((v0 * trig.sin_q12(angle10)) >> 12)   # 괄호 필수 — §2.2

각도 단위는 **데시도(0~1800)** 로 통일한다. 라디안이 sim 안에 등장하면 안 된다.
"""

from __future__ import annotations

import numpy as np
import numpy.typing as npt

TRIG_DECIDEG_MAX = 1800
TRIG_COUNT = TRIG_DECIDEG_MAX + 1  # 1801
TRIG_SHIFT = 12
TRIG_SCALE = 1 << TRIG_SHIFT  # 4096
TRIG_BYTES = TRIG_COUNT * 2 * 2  # 7204

_SIN: npt.NDArray[np.int16] | None = None
_COS: npt.NDArray[np.int16] | None = None


def load_trig(data: bytes | bytearray | memoryview) -> None:
    """표를 적재하고 경계값을 검증한다.

    검증을 여기서 하는 이유: 표가 조용히 틀리면 증상이 "가끔 안 맞음"으로 나타난다.
    0°/45°/90°/180° 네 점만 봐도 스케일·엔디언·배열 순서가 어긋난 것은 전부 잡힌다.
    """
    global _SIN, _COS
    if len(data) != TRIG_BYTES:
        raise ValueError(f"trig.bin 크기가 다르다: {len(data)} (기대 {TRIG_BYTES})")
    arr = np.frombuffer(bytes(data), dtype="<i2")
    sin = arr[:TRIG_COUNT].copy()
    cos = arr[TRIG_COUNT:].copy()

    checks = (
        (0, sin[0], 0, "sin 0°"),
        (0, cos[0], TRIG_SCALE, "cos 0°"),
        (450, sin[450], 2896, "sin 45°"),
        (450, cos[450], 2896, "cos 45°"),
        (900, sin[900], TRIG_SCALE, "sin 90°"),
        (900, cos[900], 0, "cos 90°"),
        (1800, sin[1800], 0, "sin 180°"),
        (1800, cos[1800], -TRIG_SCALE, "cos 180°"),
    )
    for _idx, got, want, label in checks:
        if int(got) != want:
            raise ValueError(f"trig.bin {label} 이 {got} 이다 (기대 {want})")

    _SIN, _COS = sin, cos


def is_loaded() -> bool:
    return _SIN is not None


def sin_q12(deg10: int) -> int:
    """sin(deg10/10°) × 4096. 데시도는 0~1800 이어야 한다."""
    if _SIN is None:
        raise RuntimeError("load_trig() 를 먼저 부른다 — sim/ 은 파일을 직접 안 읽는다")
    if deg10 < 0 or deg10 > TRIG_DECIDEG_MAX:
        raise ValueError(f"데시도 범위를 벗어났다: {deg10}")
    return int(_SIN[deg10])


def cos_q12(deg10: int) -> int:
    """cos(deg10/10°) × 4096. 데시도는 0~1800 이어야 한다."""
    if _COS is None:
        raise RuntimeError("load_trig() 를 먼저 부른다 — sim/ 은 파일을 직접 안 읽는다")
    if deg10 < 0 or deg10 > TRIG_DECIDEG_MAX:
        raise ValueError(f"데시도 범위를 벗어났다: {deg10}")
    return int(_COS[deg10])
