"""결정론 게이트 — `sim/` 을 건드리는 모든 변경이 통과해야 한다.

`CLAUDE.md` §결정론 게이트 / `docs/simulation.md` §9.

| 테스트 | 상태 | 근거 |
|---|---|---|
| `test_no_float` | **지금 동작한다** | `sim/` 이 비어 있어도 유효한 정적 검사다 |
| `test_constants_stable` | **지금 동작한다** | 상수 해시가 재현되는지 |
| `test_replay_stable` | Phase 3 대기 | `sim/` 이 없다 |
| `test_trig_table` | **지금 동작한다** | Phase 2 에서 `tables/trig.bin` 을 커밋했다 |
| `test_cross_sim` | Phase 3 대기 | 골든 리플레이가 없다 |

남은 두 항목은 Phase 3 산출물이라 `skip` 으로 남는다. **`skip` 을 지우고 `pass` 로
바꾸지 마라.** 결정론 버그를 은폐하는 가장 흔한 경로다.
"""

from __future__ import annotations

import ast
import pathlib

import pytest

import talus.sim
from talus import constants

# `sim/` 은 설치된 패키지에서 찾는다. 저장소 레이아웃을 가정하면 컨테이너 안에서
# (/app/tests 로 마운트되어 상대 경로가 달라진다) 깨진다.
SIM_DIR = pathlib.Path(talus.sim.__file__).resolve().parent


def _find_repo_root() -> pathlib.Path | None:
    """`docs/` 나 `CLAUDE.md` 를 표지로 삼아 저장소 루트를 찾는다.

    호스트에서는 `/Users/.../talus`, 컨테이너에서는 `/app` 이 된다.
    찾지 못하면 저장소 파일에 의존하는 테스트를 skip 한다.
    """
    here = pathlib.Path(__file__).resolve()
    for p in (here, *here.parents):
        if (p / "CLAUDE.md").is_file() or (p / "docs").is_dir():
            return p
    return None


REPO = _find_repo_root()
TRIG_BIN = (REPO / "tables" / "trig.bin") if REPO else None
REPLAY_DIR = (REPO / "tests" / "replays") if REPO else None


# ══════════════════════════════════════════════════════════════════════
# 지금 동작하는 검사
# ══════════════════════════════════════════════════════════════════════

#: `sim/` 안에서 금지된 모듈. `docs/terrain.md` §7.1, `docs/simulation.md` §1·§3
FORBIDDEN_MODULES = {"math", "random", "time", "datetime", "asyncio", "socket"}

#: 부동소수점을 끌어들이는 numpy 호출 패턴
FORBIDDEN_ATTRS = {"float16", "float32", "float64", "sqrt", "sin", "cos", "tan", "pi"}


class _FloatHunter(ast.NodeVisitor):
    """`sim/` 의 AST 에서 결정론을 깨는 구성을 찾는다."""

    def __init__(self, path: pathlib.Path) -> None:
        self.path = path
        self.problems: list[str] = []

    def _flag(self, node: ast.AST, msg: str) -> None:
        self.problems.append(f"{self.path.name}:{getattr(node, 'lineno', '?')} {msg}")

    def visit_Constant(self, node: ast.Constant) -> None:
        if isinstance(node.value, float):
            self._flag(node, f"부동소수점 리터럴 {node.value!r}")
        self.generic_visit(node)

    def visit_BinOp(self, node: ast.BinOp) -> None:
        if isinstance(node.op, ast.Div):
            self._flag(node, "`/` 연산자 — `>>` 또는 floor_div 헬퍼를 쓴다 (simulation.md §2.2)")
        self.generic_visit(node)

    def visit_AugAssign(self, node: ast.AugAssign) -> None:
        if isinstance(node.op, ast.Div):
            self._flag(node, "`/=` 연산자")
        self.generic_visit(node)

    def visit_Import(self, node: ast.Import) -> None:
        for a in node.names:
            root = a.name.split(".")[0]
            if root in FORBIDDEN_MODULES:
                self._flag(node, f"금지된 import: {a.name}")
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        root = (node.module or "").split(".")[0]
        if root in FORBIDDEN_MODULES:
            self._flag(node, f"금지된 import: {node.module}")
        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if node.attr in FORBIDDEN_ATTRS:
            self._flag(node, f"부동소수점 경로: .{node.attr}")
        self.generic_visit(node)

    def visit_Name(self, node: ast.Name) -> None:
        if node.id == "float":
            self._flag(node, "`float` 호출/주석")
        self.generic_visit(node)


@pytest.mark.determinism
def test_no_float() -> None:
    """`sim/` 전체를 AST 파싱해 부동소수점·`/`·`math.*` 를 검출한다.

    `docs/simulation.md` §9 의 `test_no_float`. 과하다고 느껴질 수 있는데,
    결정론 버그는 재현이 어렵고 발견이 늦다. 정적으로 잡을 수 있는 건 잡는다.
    """
    assert SIM_DIR.is_dir(), f"{SIM_DIR} 가 없다"
    problems: list[str] = []
    for path in sorted(SIM_DIR.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        hunter = _FloatHunter(path)
        hunter.visit(tree)
        problems.extend(hunter.problems)
    assert not problems, "sim/ 에 결정론을 깨는 구성이 있다:\n  " + "\n  ".join(problems)


@pytest.mark.determinism
def test_constants_stable() -> None:
    """상수 해시가 같은 입력에 대해 같은 값을 낸다.

    `SIM_VERSION` 은 프로토콜 핸드셰이크에 쓰이므로 프로세스마다 달라지면 안 된다.
    (dict 순회 순서나 set 해시 랜덤화가 새어 들어오면 여기서 잡힌다)
    """
    a = constants.compute_sim_version()
    b = constants.compute_sim_version()
    assert a == b == constants.SIM_VERSION
    assert len(a) == 16


@pytest.mark.determinism
def test_constants_are_integers() -> None:
    """시뮬레이션 상수에 부동소수점이 섞이지 않았다.

    `docs/simulation.md` §2.1 — 모든 위치·속도는 정수다. 상수표에 `0.75` 같은
    값이 들어오면 여기서 막는다. (`slideChance` 는 Q8 정수로 표현한다)
    """
    bad = [
        f"{name} = {value!r}"
        for name, value in constants.constants_snapshot().items()
        if isinstance(value, float)
        or (isinstance(value, dict) and any(isinstance(v, float) for v in value.values()))
    ]
    assert not bad, "상수표에 부동소수점이 있다:\n  " + "\n  ".join(bad)


@pytest.mark.determinism
def test_presentation_constants_are_not_in_sim_version() -> None:
    """표현 상수가 `SIM_VERSION` 에 섞이지 않았다.

    `docs/terrain.md` §3.4 — `SUBSTEPS` 는 시뮬레이션 상수가 아니라 표현 상수다.
    클라이언트가 한 프레임에 몇 스텝을 소비해 보여줄지만 정하고, 값을 바꿔도 격자 결과와
    체크섬은 변하지 않는다. 서버는 프레임이 없어 아예 쓰지 않는다.

    이게 `SIM_VERSION` 에 들어가면 **`SUBSTEPS` 만 다른 두 클라이언트가 같은 방에
    못 들어간다.** 저사양 기기가 값을 낮추는 것을 막아버리는 셈이다.

    `STABLE_FRAMES` 는 §5.2 의 정착 판정이 "가동 셀 0개"로 정확해져 폐기되었다.
    """
    snapshot = constants.constants_snapshot()
    for name in ("SUBSTEPS", "STABLE_FRAMES"):
        assert name not in snapshot, (
            f"{name} 이 SIM_VERSION 해시에 들어 있다 — terrain.md §3.4/§5.2 위반"
        )
        assert not hasattr(constants, name), f"{name} 이 아직 constants 에 남아 있다"


@pytest.mark.determinism
def test_bedrock_is_never_carvable() -> None:
    """어떤 반경·저항 조합에서도 `BEDROCK` 이 한 셀도 지워지지 않는다.

    `docs/terrain.md` §8 의 판정식은 `dx*dx + dy*dy <= rm*rm`, `rm = (radius*RESIST) >> 8` 이다.
    `RESIST = 0` 은 "무적"이 아니라 **"반경 0 = 중심 1셀"** 이므로 `0 <= 0` 이 참이 되어
    폭발 중심의 `BEDROCK` 이 지워진다. 그래서 `BEDROCK` 은 표에서 아예 빼고
    판정 이전에 제외한다.
    """
    assert constants.BEDROCK not in constants.BLAST_RESIST_Q8, (
        "BEDROCK 이 BLAST_RESIST_Q8 에 있다 — 0 을 담으면 중심 1셀이 지워진다"
    )
    # 표에 남은 재질은 전부 유효한 Q8 이어야 한다.
    for mat, q8 in constants.BLAST_RESIST_Q8.items():
        assert 0 < q8 <= 256, f"{constants.MATERIAL_NAME[mat]} 저항이 범위를 벗어났다: {q8}"


@pytest.mark.determinism
def test_slide_chance_gate_is_integer_scaled() -> None:
    """`slideChance` Q8 표현이 `docs/terrain.md` §7.1 게이트와 맞물린다.

    게이트: `((h >> 8) & 0xFFFF) < (chance_q8 << 8)`
    Q8 값 0 은 '절대 안 미끄러짐', 256 은 '항상 미끄러짐'이어야 한다.
    """
    for q8 in (constants.SLIDE_CHANCE_SAND_Q8, constants.SLIDE_CHANCE_SOIL_Q8):
        assert 0 <= q8 <= 256, f"Q8 범위를 벗어났다: {q8}"
    assert (0 << 8) == 0, "Q8 0 이 임계값 0 을 만들어야 한다"
    assert (256 << 8) == 0x10000, "Q8 256 이 16비트 해시의 상한을 넘어야 한다"


# ══════════════════════════════════════════════════════════════════════
# Phase 2~3 대기 — skip 을 지우지 마라
# ══════════════════════════════════════════════════════════════════════

_SIM_MODULES = sorted(p.stem for p in SIM_DIR.glob("*.py") if p.stem != "__init__")


@pytest.mark.determinism
@pytest.mark.skipif(not _SIM_MODULES, reason="sim/ 이 비어 있다 — roadmap Phase 3")
def test_replay_stable() -> None:
    """같은 시드 + 같은 입력 → 100회 반복해도 동일 체크섬. (simulation.md §9)"""
    pytest.fail("Phase 3 에서 구현한다. sim/ 이 생겼는데 이 테스트가 없으면 게이트가 뚫린다.")


#: `tools/gen_trig.py` 가 생성한 표의 고정 해시.
#: 값이 바뀌면 **이유를 커밋 메시지에 적고** 여기를 갱신한다. 이유 없는 갱신은 금지다 —
#: 그게 결정론 버그를 은폐하는 가장 흔한 경로다 (CLAUDE.md §결정론 게이트).
TRIG_SHA256 = "100aa8d037821279b236d69f632f87c43c74e8b700d503e881672e35b6a0a61b"


@pytest.mark.determinism
@pytest.mark.skipif(
    TRIG_BIN is None or not TRIG_BIN.is_file(),
    reason="tables/trig.bin 이 없다 — python3 tools/gen_trig.py 로 생성한다",
)
def test_trig_table() -> None:
    """`tables/trig.bin` 이 고정 해시와 일치하고 형식이 맞는다. (simulation.md §3)

    서버와 클라이언트가 **같은 바이트**를 봐야 한다. 생성 스크립트만 커밋하는
    것으로는 부족하다 — libm 이 플랫폼마다 마지막 자리에서 다를 수 있다.
    """
    import hashlib
    import struct

    blob = TRIG_BIN.read_bytes()
    count = constants.TRIG_DECIDEG_MAX + 1  # 1801
    assert len(blob) == count * 2 * 2, f"크기가 다르다: {len(blob)}"
    assert hashlib.sha256(blob).hexdigest() == TRIG_SHA256, (
        "trig.bin 이 고정 해시와 다르다. 의도적으로 바꿨다면 커밋 메시지에 이유를 적고 "
        "이 파일의 TRIG_SHA256 을 갱신한다."
    )

    sin = struct.unpack_from(f"<{count}h", blob, 0)
    cos = struct.unpack_from(f"<{count}h", blob, count * 2)
    scale = 1 << constants.TRIG_SHIFT
    assert (sin[0], cos[0]) == (0, scale), "0° 값이 틀렸다"
    assert (sin[900], cos[900]) == (scale, 0), "90° 값이 틀렸다"
    assert (sin[1800], cos[1800]) == (0, -scale), "180° 값이 틀렸다"
    assert sin[450] == cos[450] == 2896, "45° 값이 틀렸다"


@pytest.mark.crosssim
@pytest.mark.skipif(
    REPLAY_DIR is None or not REPLAY_DIR.is_dir() or not list(REPLAY_DIR.glob("*.jsonl")),
    reason="tests/replays/*.jsonl 이 없다 — roadmap Phase 3",
)
def test_cross_sim() -> None:
    """골든 리플레이를 Python·TS 양쪽에서 재생, 매 턴 체크섬 비교. (simulation.md §9)"""
    pytest.fail("Phase 3 에서 구현한다.")
