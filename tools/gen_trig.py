#!/usr/bin/env python3
"""tables/trig.bin 생성기.  docs/simulation.md §3

    python3 tools/gen_trig.py            # 생성 (기존 파일과 다르면 경고)
    python3 tools/gen_trig.py --check    # 생성만 해보고 기존 파일과 대조. 쓰지 않는다

**생성 결과를 커밋한다.** 런타임에 재생성하지 않는다.
`Math.sin()` / `math.sin()` 의 libm 구현은 플랫폼마다 마지막 자리에서 다를 수 있고,
그 한 자리가 lockstep 을 깬다. 생성 스크립트만 커밋하는 것으로는 부족하다 —
서버와 클라이언트가 **같은 바이트**를 봐야 한다.

────────────────────────────────────────────────────────────────────────────
형식

    레이아웃   SIN 배열 1801개  →  COS 배열 1801개   (연속, 헤더 없음)
    인덱스    0 ~ 1800         (데시도. 각도 × 10, 0.0° ~ 180.0°)
    값        int16 리틀엔디언  sin/cos × 4096  (Q12 고정소수점)
    크기      1801 × 2 × 2 = 7,204 바이트

────────────────────────────────────────────────────────────────────────────
반올림을 JS `Math.round` 에 맞춘다

Python 의 `round()` 는 은행가 반올림(0.5 를 짝수로)이고 JS 의 `Math.round` 는
**항상 +∞ 방향**으로 올린다. `round(0.5) = 0` vs `Math.round(0.5) = 1` 이다.

Phase 1 의 `tools/prototype/sim.js` 가 런타임에 `Math.round(Math.sin(r) * 4096)` 로
표를 만들어 썼으므로, 그 값과 **바이트 단위로 같아야** 정수화 전후의 체감이 변하지 않는다
(roadmap Phase 2 완료 조건). 그래서 `floor(x + 0.5)` 로 JS 규칙을 재현한다.
"""

from __future__ import annotations

import argparse
import hashlib
import math
import pathlib
import struct
import sys

DECIDEG_MAX = 1800          # 0.0° ~ 180.0°
COUNT = DECIDEG_MAX + 1     # 1801
SHIFT = 12                  # Q12
SCALE = 1 << SHIFT          # 4096

OUT = pathlib.Path(__file__).resolve().parents[1] / "tables" / "trig.bin"


def js_round(x: float) -> int:
    """JS `Math.round` 와 같은 규칙. 0.5 를 항상 +∞ 방향으로 올린다."""
    return math.floor(x + 0.5)


def build() -> bytes:
    sin_vals: list[int] = []
    cos_vals: list[int] = []
    for d in range(COUNT):
        rad = math.radians(d / 10.0)
        s = js_round(math.sin(rad) * SCALE)
        c = js_round(math.cos(rad) * SCALE)
        # int16 범위 확인. sin/cos × 4096 은 -4096..4096 이라 여유가 크다.
        for v in (s, c):
            if not (-32768 <= v <= 32767):
                raise ValueError(f"int16 범위 초과: deg10={d} v={v}")
        sin_vals.append(s)
        cos_vals.append(c)

    # 경계값을 못박는다. 여기가 틀리면 45°·90° 발사가 어긋난다.
    assert sin_vals[0] == 0, sin_vals[0]
    assert cos_vals[0] == SCALE, cos_vals[0]
    assert sin_vals[900] == SCALE, sin_vals[900]        # 90.0°
    assert cos_vals[900] == 0, cos_vals[900]
    assert sin_vals[1800] == 0, sin_vals[1800]          # 180.0°
    assert cos_vals[1800] == -SCALE, cos_vals[1800]
    assert sin_vals[450] == cos_vals[450] == 2896, (sin_vals[450], cos_vals[450])  # 45.0°

    return struct.pack(f"<{COUNT}h{COUNT}h", *sin_vals, *cos_vals)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="쓰지 않고 기존 파일과만 대조한다")
    args = ap.parse_args()

    blob = build()
    digest = hashlib.sha256(blob).hexdigest()
    expected_size = COUNT * 2 * 2
    assert len(blob) == expected_size, (len(blob), expected_size)

    old = OUT.read_bytes() if OUT.is_file() else None
    same = old == blob

    print(f"크기   {len(blob):,} 바이트")
    print(f"sha256 {digest}")
    print(f"45°    SIN=COS={struct.unpack_from('<h', blob, 450 * 2)[0]}")

    if args.check:
        if old is None:
            print("기존 파일 없음 — --check 로는 만들지 않는다", file=sys.stderr)
            return 1
        print("대조:", "동일" if same else "다르다")
        return 0 if same else 1

    if same:
        print(f"변경 없음 — {OUT.relative_to(OUT.parents[1])}")
        return 0
    if old is not None:
        print(
            "⚠️  기존 파일과 다르다. 의도적으로 바꿨다면 커밋 메시지에 이유를 적고\n"
            "    server/tests/test_determinism.py::test_trig_table 의 고정 해시를 갱신한다.",
            file=sys.stderr,
        )
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(blob)
    print(f"작성 {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
