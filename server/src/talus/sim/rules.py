"""규칙 지문 — 두 구현이 **같은 규칙으로 계산하고 있는가**.

`client/src/sim/rules.ts` 의 1:1 미러. `docs/netcode.md` §7.3 의 접속 호환성 검사가 쓴다.

────────────────────────────────────────────────────────────────────────────
왜 `SIM_VERSION` 으로는 안 되는가

`SIM_VERSION` 은 `talus/constants.py` 전체의 SHA-256 이고 **Python 만 계산할 수 있다.**
그래서 클라이언트는 `GET /version` 으로 받아 접속할 때 되돌려 보내고 있었고, 서버는
그걸 자기 값과 비교했다 — **동어반복이라 원리적으로 불일치가 나지 않는다.**
규칙이 다른 두 빌드가 같은 방에 들어갈 수 있었다.

지문은 다르다. **양쪽이 각자의 규칙 표에서 독립적으로 계산한다.**

`SIM_VERSION` 을 없애지는 않는다 — 서버 빌드 식별과 `/version` 표시에 여전히 쓰고,
`constants.py` 를 만졌는데 지문이 안 바뀌는 경우(표현 상수 변경)를 구분할 수 있다.

────────────────────────────────────────────────────────────────────────────
무엇을 넣고 무엇을 빼는가

넣는다: 시뮬레이션 결과를 바꾸는 값 전부.
뺀다:   표현 텍스트(무기 이름·설명)와 `SUBSTEPS` 같은 표현 상수.
        이름을 번역했다고 같은 방에 못 들어가면 곤란하다.

**문자열을 해시에 넣지 않는다.** 순수 정수 수열을 리틀엔디언 int32 로 편 뒤 FNV-1a 를
돌린다 — 골든의 `ptsHash` 와 같은 방식이고 이미 양쪽 일치가 검증된 패턴이다.
"""

from __future__ import annotations

from talus import constants

from . import ballistics as B
from . import mapgen as M
from . import terrain as T
from . import weapons as Wp
from .intmath import fnv1a32, hex8
from .match import MATCH_VERSION, RULES

#: `kind` 문자열을 고정 인덱스로. **순서를 바꾸면 지문이 바뀐다** — 바꾸지 마라.
KIND_INDEX: tuple[str, ...] = ("plain", "split", "burrow", "roll", "deposit")


def _kind_index(kind: str) -> int:
    if kind not in KIND_INDEX:
        raise ValueError(f"모르는 무기 kind: {kind}")
    return KIND_INDEX.index(kind)


def rule_fingerprint() -> list[int]:
    """규칙 전체를 정수 수열로 편다.

    **양쪽 구현이 같은 순서로 같은 값을 내야 한다.** 항목을 추가하면
    `client/src/sim/rules.ts` 도 같이 고친다 — 한쪽만 고치면 모든 접속이 거부된다
    (안전한 방향이지만 원인을 찾기 어렵다). `test_rule_hash_matches_typescript` 가 잡는다.
    """
    out: list[int] = []

    # 1. 버전 태그
    out += [MATCH_VERSION, M.MAPGEN_VERSION]

    # 2. 무기 — 이름·설명은 뺀다
    out.append(len(Wp.WEAPONS))
    for w in Wp.WEAPONS:
        out += [
            w.id,
            _kind_index(w.kind),
            w.max_damage,
            w.blast_radius,
            w.carve_cells,
            -1 if w.ammo0 is None else w.ammo0,
            w.price,
            w.split_count,
            w.split_spread,
            w.burrow_cells,
            w.roll_cells,
            w.deposit_cells,
            w.deposit_mat,
        ]

    # 3. 아이템 — 가격만
    out.append(len(Wp.ITEMS))
    for item in Wp.ITEMS:
        out += [item.id, item.price]

    # 4. 지질 프로파일과 맵 생성 상수
    out.append(len(M.PROVINCES))
    for bands, depth in M.PROVINCES:
        out += [*bands, depth]
    out += [
        M.NOISE_SHIFT,
        M.SURFACE_BASE,
        M.SURFACE_AMP,
        M.BEDROCK_Y,
        M.PROVINCE_BLEND,
    ]

    # 5. 매치 규칙
    out += [
        RULES.rounds,
        RULES.round_turn_cap,
        RULES.start_gold,
        RULES.gold_per_damage,
        RULES.gold_per_kill,
        RULES.gold_survive,
        RULES.gold_last_place_bonus,
        RULES.kill_score,
        RULES.damage_score,
        RULES.survive_score,
        RULES.fuel_cells_per_unit,
        RULES.move_max_step_up,
        RULES.max_settle_steps,
        RULES.connectivity_max_rounds,
    ]

    # 6. 탄도
    out += [
        B.CFG.gravity,
        B.CFG.power_scale,
        B.CFG.wind_max,
        B.CFG.drag_q16,
        B.CFG.max_flight_ticks,
        B.CFG.self_hit_ignore,
        B.CFG.barrel_len,
        B.CFG.fall_safe_px,
        B.CFG.fall_damage_num,
        B.CFG.fall_damage_shift,
        B.CFG.burial_permille,
        B.CFG.burial_damage,
    ]

    # 7. 자동자. `seed` 는 매치마다 달라지므로 넣지 않는다
    out += [
        T.CFG.slide_sand_q8,
        T.CFG.slide_soil_q8,
        T.CFG.slide_scree_q8,
        1 if T.CFG.slide_gate_static else 0,
        1 if T.CFG.both_directions else 0,
    ]
    for material in (T.SAND, T.SOIL, T.SCREE, T.ROCK, T.BEDROCK):
        out += [material, T.CFG.blast_resist_q8.get(material, -1)]

    return out


def rule_hash() -> str:
    """규칙 지문의 FNV-1a. 8자리 대문자 hex."""
    buf = bytearray()
    for value in rule_fingerprint():
        buf += int(value).to_bytes(4, "little", signed=True)
    return hex8(fnv1a32(buf))


#: import 시점에 한 번 계산한다. `constants.py` 처럼 프로세스 내내 고정이다.
RULE_HASH: str = rule_hash()


__all__ = ["KIND_INDEX", "RULE_HASH", "rule_fingerprint", "rule_hash"]
