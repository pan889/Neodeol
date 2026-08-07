"""시뮬레이션 상수의 기계 판독 사본.

**문서가 기준이다.** 이 파일은 `docs/simulation.md` §8, `docs/terrain.md` §4,
`docs/mapgen.md`, `docs/match.md`의 기계 판독 사본이며, 값이 어긋나면 문서를 먼저 고친다.

여기 있는 값은 대부분 **시작값이며 확정값이 아니다.** Phase 0 (`tools/sandbox/`)
과 Phase 1 (`tools/prototype/`) 에서 손으로 만져보고 정한다.
`PROVISIONAL` 집합에 들어 있는 이름이 아직 확정되지 않은 것들이다.

`SIM_VERSION` 은 이 상수 집합의 해시다. 상수가 하나라도 바뀌면 값이 바뀌므로,
`docs/netcode.md` 의 프로토콜 핸드셰이크에서 클라이언트와 서버가 같은 규칙으로
계산하고 있는지 확인하는 데 쓴다. 값이 다르면 같은 방에 넣어서는 안 된다.

`docs/netcode.md` §7.3 이 이 정의를 규범으로 채택했다. 이전 판의 "`client/src/sim/`
전체 + `tables/trig.bin` 의 해시" 는 성립할 수 없다 — 소스 코드 해시는 Python 과
TypeScript 사이에서 절대 같아지지 않고, 서버는 클라 소스를 해시할 수도 없다.

`RULES_VERSION`은 상수 밖의 절차·알고리즘이 바뀔 때 수동으로 올린다. 이를 잊은 경우는
교차 골든 CI가 잡는다 (`docs/decisions.md` B9).
"""

from __future__ import annotations

import hashlib
import json
from typing import Final

# ── 규칙 신원 (netcode.md §7.3) ───────────────────────────────────────
# 상수값이 그대로인 로직 변경에도 SIM_VERSION 이 바뀌도록 수동으로 올린다.
RULES_VERSION: Final = 6

# ── 격자 (terrain.md §1) ────────────────────────────────────────────────
GRID_W: Final = 960
GRID_H: Final = 540
CELL_PX: Final = 2
MAP_W_PX: Final = GRID_W * CELL_PX  # 1920
MAP_H_PX: Final = GRID_H * CELL_PX  # 1080

# ── 재질 (terrain.md §2) ────────────────────────────────────────────────
EMPTY: Final = 0
SAND: Final = 1
SOIL: Final = 2
SCREE: Final = 3
ROCK: Final = 4
BEDROCK: Final = 5

#: 진단·로그용 이름. `SIM_VERSION` 에는 들어가지 않는다 (숫자 인덱스가 규범이다).
MATERIAL_NAME: Final = ("EMPTY", "SAND", "SOIL", "SCREE", "ROCK", "BEDROCK")

# ── 좌표계 (simulation.md §2.1) ─────────────────────────────────────────
SUBPX: Final = 16  # subpx per px
CELL_SUBPX: Final = CELL_PX * SUBPX  # 32
TICK_HZ: Final = 60

# ── 자동자 (terrain.md §4) — 전부 잠정값 ────────────────────────────────
#
# slideChance 는 Q8 정수다 (0..256). 부동소수점 금지(terrain.md §7.3)를 지키기 위한
# 표현이며 §7.1 의 게이트는 `((h >> 8) & 0xFFFF) < (chance_q8 << 8)` 로 계산한다.
#
# 규칙 3 확률 게이트의 입력에서 step 을 뺀다 — **확정 규칙** (decisions.md A1).
# 활강 가능 여부가 위치로 고정되어 slideChance 가 안식각을 실제로 조절한다.
# step 을 넣으면 게이트에 막힌 셀도 다음 스텝엔 통과하므로 종단 각도가 규칙 3 의
# 기하 한계로만 수렴한다 — 즉 조절이 안 된다. 실측: Q8 8~256 전부 26.6°.
SLIDE_GATE_STATIC: Final = 1

# 정적 게이트에서 Q8 이 안식각을 연속 조절한다 (terrain.md §4.2 실측 곡선).
#   Q8    0 →  44.2°     48 →  40.3°    128 →  35.8°    256 →  26.6°
# 값은 밸런싱 대상이지만 **조절 방법은 확정**이다.
SLIDE_CHANCE_SAND_Q8: Final = 256  # 26.6° — 완만한 지표층
SLIDE_CHANCE_SOIL_Q8: Final = 48  # 40.3° — 급한 중간층
SLIDE_CHANCE_SCREE_Q8: Final = 0  # 44.2° — 규칙 3 미적용을 0 으로 표현한다

# 실측 최악은 최대 무기 1발(4,658스텝)이 아니라 **2발이 간격 320 으로 떨어진 경우**
# (6,807스텝)다. 동시 폭발 비용은 발수에 단조가 아니다 — 크레이터가 흩어져 있으면
# 각각 장거리 수송을 해야 해서 비싸고, 촘촘하면 합쳐져 싸다. decisions.md A3·B14.
# 간격 스윕을 안 했으므로 여유를 크게 둔다. 이건 예외 경로여야 한다.
MAX_SETTLE_STEPS: Final = 12_000

# terrain.md §6.1 정착 재개 루프의 상한. 통상 2회로 끝난다.
CONNECTIVITY_MAX_ROUNDS: Final = 8

# ── 초기 맵 생성 (mapgen.md) ───────────────────────────────────────────
# 맵 생성 알고리즘을 바꾸면 반드시 올린다. 골든 리플레이와 함께 검증한다.
MAPGEN_VERSION: Final = 2

# ── 매치 진행 (match.md) ────────────────────────────────────────────────
# 알고리즘/절차가 바뀌면 MATCH_VERSION 을 올리고 match 골든을 재생성한다.
MATCH_VERSION: Final = 7
MATCH_ROUNDS: Final = 5
ROUND_TURN_CAP: Final = 40
START_GOLD: Final = 1_500
GOLD_PER_DAMAGE: Final = 8
GOLD_PER_KILL: Final = 400
GOLD_SURVIVE: Final = 300
GOLD_LAST_PLACE_BONUS: Final = 250
KILL_SCORE: Final = 100
DAMAGE_SCORE: Final = 1
SURVIVE_SCORE: Final = 50
FUEL_CELLS_PER_UNIT: Final = 14
MOVE_MAX_STEP_UP: Final = 6
AMMO_INFINITE: Final = 0x7FFFFFFF

# `SUBSTEPS` 와 `STABLE_FRAMES` 는 여기에 없다.
#   SUBSTEPS    — terrain.md §3.4 대로 시뮬레이션 상수가 아니라 표현 상수다.
#                 서버는 프레임이 없어 쓰지 않고, 클라이언트가 값을 바꿔도 격자 결과와
#                 체크섬이 변하지 않는다. 따라서 SIM_VERSION 에 들어가서도 안 된다 —
#                 들어가면 SUBSTEPS 만 다른 두 클라이언트가 같은 방에 못 들어간다.
#   STABLE_FRAMES — terrain.md §5.2 의 정착 판정이 "가동 셀 0개"로 정확해져 폐기되었다.

# ── 폭발 저항 (terrain.md §8) — Q8. 유효반경 = (radius * resist) >> 8 ──
# `BEDROCK` 키는 **의도적으로 없다.** 키가 없으면 판정 대상이 아니라는 뜻이다.
#
# 0 을 담아서는 안 된다. terrain.md §8 의 판정식이 `dx*dx + dy*dy <= rm*rm` 이고
# `rm = (radius * RESIST) >> 8` 이므로, RESIST=0 이면 rm=0 이고 `0 <= 0` 이 참이 되어
# **폭발 중심 셀의 BEDROCK 이 제거된다.** 즉 0 은 "무적"이 아니라 "반경 0(중심 1셀)"이다.
# BEDROCK 은 §2 에서 불변이자 §6.1 연결성 검사의 시드이므로, 중심 1셀이 지워지면
# 그 위에 붙어 있던 ROCK 구조가 한쪽에서만 SCREE 로 붕괴한다.
BLAST_RESIST_Q8: Final = {
    SAND: 256,
    SOIL: 208,
    SCREE: 256,
    ROCK: 140,
}

# ── 탄도 (simulation.md §8) — 전부 잠정값 ───────────────────────────────
GRAVITY: Final = 12  # subpx/tick²
POWER_SCALE: Final = 624  # B12 확정 — 최대 파워 45° 사거리 = 맵 폭의 98.9% (1899px)
# 편차/사거리 비는 정확히 WIND_MAX/GRAVITY 이고 파워와 무관하다 (실측 확인).
# 직접 플레이 피드백에 따라 평상시에는 완만하게 변하되 드문 돌풍이 위협이 되도록 최대치를 4로 올린다.
WIND_MAX: Final = 4  # subpx/tick²
DRAG_Q16: Final = 0  # §4.5 — 항력 없음으로 시작
MAX_FLIGHT_TICKS: Final = 1800  # 30초
SELF_HIT_IGNORE_TICKS: Final = 8
BARREL_LEN_SUBPX: Final = 160  # 10 px. 짧고 굵은 곡사포 포신

# ── 탱크 (simulation.md §6, §8) ─────────────────────────────────────────
TANK_W_SUBPX: Final = 384  # 24 px
TANK_H_SUBPX: Final = 256  # 16 px
MAX_HP: Final = 100
FALL_SAFE_PX: Final = 24

# ── 턴 (simulation.md §8) ───────────────────────────────────────────────
AIM_SECONDS: Final = 20
AIM_SECONDS_FIRST_TURN: Final = 30

# ── 삼각함수 표 (simulation.md §3) ──────────────────────────────────────
TRIG_TABLE_PATH: Final = "tables/trig.bin"
TRIG_DECIDEG_MAX: Final = 1800  # 0.0° ~ 180.0°
TRIG_SHIFT: Final = 12  # Q12 고정소수점

#: 아직 확정되지 않은 상수. Phase 0~1 에서 실측으로 정한다.
#: 이 목록이 비면 밸런싱 기준선이 잡혔다는 뜻이다. `docs/decisions.md` 와 짝을 이룬다.
PROVISIONAL: Final = frozenset(
    {
        "SLIDE_CHANCE_SAND_Q8",  # 각도 목표는 밸런싱. 조절 방법은 A1 로 확정됨
        "SLIDE_CHANCE_SOIL_Q8",  # 같음
        "MAX_SETTLE_STEPS",  # decisions.md A3
        "GRAVITY",  # decisions.md C3
        "POWER_SCALE",  # B12 로 목표(맵 폭)는 정해졌다. 최종 확정은 Phase 1 체감
        "WIND_MAX",  # decisions.md C4 — 고각 편차 클램프와 함께 정해야 한다
        "BLAST_RESIST_Q8",  # decisions.md C1
        "MATCH_ROUNDS",  # game-design.md §3, 상점 횟수와 함께 재검토
        "ROUND_TURN_CAP",  # decisions.md B12
        "START_GOLD",  # decisions.md C6
        "GOLD_PER_DAMAGE",  # game-design.md §7
        "GOLD_PER_KILL",  # game-design.md §7
        "GOLD_SURVIVE",  # game-design.md §7
        "GOLD_LAST_PLACE_BONUS",  # game-design.md §7
        "KILL_SCORE",  # decisions.md B7
        "DAMAGE_SCORE",  # decisions.md B7
        "SURVIVE_SCORE",  # decisions.md B7
        "FUEL_CELLS_PER_UNIT",  # decisions.md B4
        "MOVE_MAX_STEP_UP",  # decisions.md B4
    }
)


#: `SIM_VERSION` 계산에서 제외하는 이름.
#:
#: `SIM_VERSION` 자신을 반드시 제외해야 한다. 넣으면 자기참조가 되어 모듈 임포트
#: 시점(아직 정의되지 않음)과 그 이후 호출의 결과가 달라진다.
#: `PROTOCOL_VERSION` 은 와이어 형식이라 시뮬레이션 규칙과 수명주기가 다르다 —
#: 메시지 구조만 바뀌었을 때 sim 버전이 흔들리면 안 된다.
#:
#: 여기 없는 대문자 상수는 **자동으로** 해시에 포함된다. 상수를 추가했는데 해시가
#: 안 바뀌는 사고를 막기 위해 화이트리스트가 아니라 블랙리스트로 둔다.
_EXCLUDED_FROM_HASH: Final = frozenset(
    {"SIM_VERSION", "PROTOCOL_VERSION", "PROVISIONAL", "TRIG_TABLE_PATH"}
)


def constants_snapshot() -> dict[str, object]:
    """`SIM_VERSION` 계산에 들어가는 상수 전체를 정렬된 dict 로 돌려준다.

    호출 시점과 무관하게 같은 결과를 내야 한다 —
    `server/tests/test_determinism.py::test_constants_stable` 이 이를 검증한다.
    """
    g = globals()
    names = sorted(
        n
        for n, v in g.items()
        if n.isupper()
        and not n.startswith("_")
        and n not in _EXCLUDED_FROM_HASH
        and isinstance(v, (int, str, dict))
    )
    out: dict[str, object] = {}
    for n in names:
        v = g[n]
        # dict 키가 int 라 json 직렬화에서 순서를 고정하려면 문자열로 바꿔야 한다.
        out[n] = {str(k): v[k] for k in sorted(v)} if isinstance(v, dict) else v
    return out


def compute_sim_version() -> str:
    """상수 집합의 안정 해시. 상수가 바뀌면 값이 바뀐다."""
    blob = json.dumps(constants_snapshot(), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


SIM_VERSION: Final = compute_sim_version()

#: 와이어 프로토콜 버전. 메시지 구조가 바뀌면 손으로 올린다 (netcode.md).
PROTOCOL_VERSION: Final = 2
