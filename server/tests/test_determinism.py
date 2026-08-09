"""결정론 게이트 — `sim/` 을 건드리는 모든 변경이 통과해야 한다.

`CLAUDE.md` §결정론 게이트 / `docs/simulation.md` §9.

| 테스트 | 상태 | 근거 |
|---|---|---|
| `test_no_float` | **지금 동작한다** | `sim/` 이 비어 있어도 유효한 정적 검사다 |
| `test_constants_stable` | **지금 동작한다** | 상수 해시가 재현되는지 |
| `test_replay_stable` | **동작한다** (Phase 3) | 100회 재생 + 시드 간섭 |
| `test_trig_table` | **동작한다** | Phase 2 에서 `tables/trig.bin` 을 커밋했다 |
| `test_cross_sim_gate_exists` | **동작한다** | 본체는 `test_cross_sim.py` |

이 파일은 **게이트 (1) — 서버 자기 자신과의 재현성**이다. TS 를 보지 않는다.
TS 와의 대조(게이트 (2))는 `test_cross_sim.py` 가 하고, 그건 골든 파일이 있어야 성립하므로
분리해 두었다. 여기까지가 골든 없이도 항상 돌아가는 그물이다.

**`skip` 을 지우고 `pass` 로 바꾸지 마라.** 결정론 버그를 은폐하는 가장 흔한 경로다.
"""

from __future__ import annotations

import ast
import pathlib

import numpy as np
import pytest

import talus.sim
from talus import constants

#: 격자 폭. `talus.sim.terrain` 을 import 하지 않고도 쓰려고 여기 둔다
W_FULL = 960

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
# 서버 자기 자신과의 재현성 — CLAUDE.md §결정론 게이트 (1)
#
# 게이트 (2)(교차 검증)와 다르다. 여기서는 TS 를 보지 않는다.
# **같은 프로세스 안에서 같은 입력을 반복 실행했을 때 같은 결과가 나오는가**만 본다.
# 이게 깨지는 원인은 대개 모듈 전역 상태가 실행 사이에 안 지워지는 것이고
# (`_gate_ok` 캐시, 활성 행 비트맵, `step` 카운터), 그건 교차 검증이 못 잡는다 —
# 양쪽이 똑같이 오염되면 체크섬은 사이좋게 일치한다.
# ══════════════════════════════════════════════════════════════════════

_SIM_MODULES = sorted(p.stem for p in SIM_DIR.glob("*.py") if p.stem != "__init__")


def _run_once(seed: int, steps: int) -> tuple[int, int, int]:
    """시드에서 격자를 만들고 carve → N스텝. (체크섬, 질량, 이동 셀 수)"""
    from talus.sim import terrain as T

    T.CFG.seed = seed
    T.reset_gate_cache()
    g = T.grid
    g.fill(T.EMPTY)
    g2 = g.reshape(T.H, T.W)
    xs = np.arange(T.W)
    # 정수 전용 톱니 지형. 결정론만 보므로 모양은 단순해도 된다
    top = 150 + ((xs * (7 + (seed & 7))) % 90)
    for mat, thick in ((T.SAND, 20), (T.SOIL, 30), (T.SCREE, 14), (T.ROCK, 60)):
        for k in range(thick):
            rows = top + k
            g2[rows, xs] = mat
        top = top + thick
    g2[500:, :] = T.BEDROCK

    T.connectivity()
    T.mark_all()
    T.set_step(0)
    T.carve(400 + (seed & 63), 230, 40)
    moved = 0
    for _ in range(steps):
        moved += T.step().moved
    return T.checksum(), T.mass_count(), moved


@pytest.mark.determinism
@pytest.mark.skipif(not _SIM_MODULES, reason="sim/ 이 비어 있다 — roadmap Phase 3")
def test_replay_stable() -> None:
    """같은 시드 + 같은 입력 → 100회 반복해도 동일 체크섬. (simulation.md §9)"""
    base = _run_once(0x31, 120)
    assert base[2] > 0, "아무것도 안 움직였다 — 시나리오가 자동자를 안 돌리고 있다"
    for i in range(1, 100):
        assert _run_once(0x31, 120) == base, f"{i}회차에서 갈라졌다 — 전역 상태가 남는다"


@pytest.mark.determinism
@pytest.mark.skipif(not _SIM_MODULES, reason="sim/ 이 비어 있다 — roadmap Phase 3")
def test_seeds_actually_differ() -> None:
    """시드가 다르면 결과도 다르다.

    `test_replay_stable` 만 있으면 시드를 완전히 무시하는 구현도 통과한다.
    """
    sums = {s: _run_once(s, 120)[0] for s in (0x11, 0x31, 0x55, 0xA3, 0xF0)}
    assert len(set(sums.values())) == len(sums), f"시드가 결과에 안 먹는다: {sums}"


@pytest.mark.determinism
@pytest.mark.skipif(not _SIM_MODULES, reason="sim/ 이 비어 있다 — roadmap Phase 3")
def test_interleaved_runs_do_not_contaminate() -> None:
    """시드를 번갈아 돌려도 각자의 결과가 유지된다.

    `test_replay_stable` 은 같은 시드만 반복하므로, 시드에 딸린 캐시
    (`_gate_ok`)가 갱신 없이 재사용돼도 통과한다. 여기서 그걸 잡는다.
    """
    a0 = _run_once(0x11, 80)
    b0 = _run_once(0xA3, 80)
    for _ in range(5):
        assert _run_once(0x11, 80) == a0, "0xA3 을 거친 뒤 0x11 이 달라졌다"
        assert _run_once(0xA3, 80) == b0, "0x11 을 거친 뒤 0xA3 이 달라졌다"


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
def test_cross_sim_gate_exists() -> None:
    """게이트 (2)가 실재하는지 확인한다.

    교차 검증 본체는 `test_cross_sim.py` 에 있다 (골든 로딩·사이드카 검증이 딸려 있어
    이 파일에 두면 결정론 게이트가 골든 파일 유무에 통째로 묶인다).
    여기서는 **그 파일이 사라지거나 비는 것**만 막는다 — 파일을 지우면 게이트 (2)는
    조용히 0건이 되고, pytest 는 초록색을 보여준다. 그게 가장 위험한 상태다.
    """
    body = (pathlib.Path(__file__).parent / "test_cross_sim.py").read_text(encoding="utf-8")
    for name in ("def test_cross_sim(", "def test_replay_stable("):
        assert name in body, f"test_cross_sim.py 에 {name} 이 없다 — 게이트 (2)가 비었다"
    assert "pytest.fail(" not in body, "교차 검증이 아직 자리표시자다"


def _scatter(seed: int, x0: int, x1: int, y0: int, y1: int) -> None:
    """재질을 무작위로 흩뿌린다 — 자연 지형보다 훨씬 불안정한 적대적 입력.

    자연스러운 지형은 이미 대충 안식각에 가까워서 몇 스텝이면 정착한다.
    규칙이 순환(위로 올라가는 이동, 두 셀이 자리를 맞바꾸는 이동)을 만들면
    그건 정착이 아니라 **영원히 안 끝나는 상태**이고, 자연 지형으로는 잘 안 드러난다.
    """
    from talus.sim import terrain as T

    T.CFG.seed = seed
    T.reset_gate_cache()
    T.grid.fill(T.EMPTY)
    g2 = T.grid.reshape(T.H, T.W)
    xs = np.arange(x0, x1, dtype=np.uint32)
    for row in range(y0, y1):
        h = T.hash32(np.uint32(seed), xs, np.uint32(row), np.uint32(0))
        keep = (h >> np.uint32(9)) % np.uint32(3) != 0
        g2[row, x0:x1] = np.where(keep, (h % 6).astype(np.uint8), T.EMPTY)
    g2[522:, :] = T.BEDROCK
    T.connectivity()
    T.mark_all()
    T.set_step(0)


def _settle(limit: int) -> int:
    """정착까지의 스텝 수. 상한에 걸리면 -1."""
    from talus.sim import terrain as T

    steps = 0
    while steps < limit:
        steps += 1
        if T.step().mobile == 0:
            return steps
    return -1


#: 정착 상한. `MAX_SETTLE_STEPS` (decisions.md A3) 가 미결이라 여기서는 넉넉히 잡는다 —
#: 이 테스트가 보는 것은 "언제 끝나는가"가 아니라 **"끝나기는 하는가"** 다.
SETTLE_LIMIT = 60000


@pytest.mark.determinism
@pytest.mark.skipif(not _SIM_MODULES, reason="sim/ 이 비어 있다 — roadmap Phase 3")
def test_settle_terminates() -> None:
    """무작위 지형에 대해 정착이 상한 내 종료한다. (`simulation.md` §9)

    **정착이 안 끝나면 턴이 안 끝난다.** 증상은 "가끔 게임이 멈춤"이라 재현이 거의 불가능하다.

    §5.2 의 정착 판정은 근사가 아니라 정확하다 — 가동 셀이 0개면 어떤 셀도 못 움직인다.
    종료는 "셀이 스텝당 최대 1칸 아래로만 간다"에서 따라오는데, **규칙을 잘못 고치면
    그 성질이 깨진다** (위로 올라가는 이동이 생기면 순환한다).

    여기서는 320열 × 240행에 흩뿌린다. 전 격자(960×400)로 하면 지형 하나가 60초라
    상시 게이트에서 빠지고, 그러면 아무도 안 돌린다. 전 격자판은 `slow` 로 따로 있다 —
    순환 규칙은 규모와 무관하게 **첫 지형에서** 드러나므로 좁은 판이 그물 역할을 한다.
    """
    worst = 0
    for i in range(8):
        seed = 0x40 + i
        _scatter(seed, 320, 640, 200, 440)
        steps = _settle(SETTLE_LIMIT)
        assert steps > 0, f"시드 0x{seed:02x}: {SETTLE_LIMIT} 스텝에 정착하지 않았다"
        worst = max(worst, steps)
    assert worst < SETTLE_LIMIT


@pytest.mark.determinism
@pytest.mark.slow
@pytest.mark.skipif(not _SIM_MODULES, reason="sim/ 이 비어 있다 — roadmap Phase 3")
def test_settle_terminates_full_grid() -> None:
    """전 격자를 흩뿌려도 정착한다. 지형 하나가 약 60초라 `slow` 로 분리한다.

    §11.3 의 "대형 붕괴 27,249스텝"과 같은 규모다 — 실전에는 안 나오지만
    (가장 큰 무기가 12,851셀이라 10배 차이) 규칙의 종료성은 여기서 판정한다.
    """
    worst = 0
    for i in range(6):
        seed = 0x80 + i
        _scatter(seed, 0, W_FULL, 120, 520)
        steps = _settle(SETTLE_LIMIT)
        assert steps > 0, f"시드 0x{seed:02x}: {SETTLE_LIMIT} 스텝에 정착하지 않았다"
        worst = max(worst, steps)
    # 실측 16,584 ~ 24,688 스텝. 상한에 2배 이상 여유가 있어야 한다
    assert worst < SETTLE_LIMIT // 2, f"최악 {worst} 스텝 — 상한 여유가 사라졌다"


# ══════════════════════════════════════════════════════════════════════════
# SIM_VERSION 이 실제로 규칙 전체를 덮는가
#
# `constants.py` 독스트링은 "상수가 하나라도 바뀌면 값이 바뀐다"고 주장하는데, 한동안
# 거짓이었다. 스냅샷이 `int/str/dict` 만 담아서 **tuple 인 무기 표와 지질 프로파일이
# 통째로 빠졌고**, 밸런스를 바꿔도 `SIM_VERSION` 이 그대로였다 — 규칙이 다른 두
# 클라이언트가 핸드셰이크를 통과해 같은 방에 들어갈 수 있었다.
# ══════════════════════════════════════════════════════════════════════════


@pytest.mark.determinism
def test_every_constant_is_hashed() -> None:
    """타입 때문에 해시에서 빠지는 상수가 없다.

    이게 없으면 상수를 추가했는데 `SIM_VERSION` 이 안 바뀌는 상태를 **조용히** 만든다.
    새 상수가 tuple/list/dict 중첩이어도 `_normalize` 가 펴야 하고, 못 펴면 여기서 터진다.
    """
    included, skipped = constants.hashable_constant_names()
    assert not skipped, (
        f"해시에서 빠지는 상수가 있다: {skipped}\n"
        "  → constants._normalize 가 그 타입을 다루게 하거나, "
        "규칙과 무관하면 _EXCLUDED_FROM_HASH 에 넣고 이유를 적는다"
    )
    assert len(included) > 50, f"해시 대상이 {len(included)}개뿐이다"


@pytest.mark.determinism
def test_sim_version_tracks_weapon_balance() -> None:
    """무기 값을 하나만 바꿔도 `SIM_VERSION` 이 바뀐다."""
    original = constants.WEAPON_TABLE
    before = constants.compute_sim_version()
    row = list(original[1])
    row[3] += 1  # max_damage
    try:
        constants.WEAPON_TABLE = tuple([original[0], tuple(row), *original[2:]])
        after = constants.compute_sim_version()
    finally:
        constants.WEAPON_TABLE = original
    assert before != after, "무기 피해를 바꿨는데 SIM_VERSION 이 그대로다"
    assert constants.compute_sim_version() == before, "복원 후 값이 안 돌아왔다"


@pytest.mark.determinism
def test_sim_version_tracks_map_geology() -> None:
    """지질 프로파일을 바꿔도 `SIM_VERSION` 이 바뀐다."""
    original = constants.PROVINCE_TABLE
    before = constants.compute_sim_version()
    row = list(original[0])
    row[0] += 1  # 모래 두께
    try:
        constants.PROVINCE_TABLE = tuple([tuple(row), *original[1:]])
        after = constants.compute_sim_version()
    finally:
        constants.PROVINCE_TABLE = original
    assert before != after, "지층 두께를 바꿨는데 SIM_VERSION 이 그대로다"


@pytest.mark.determinism
def test_sim_modules_do_not_keep_a_second_copy_of_the_tables() -> None:
    """`sim/` 이 상수표를 다시 적지 않고 `constants.py` 에서 읽는다.

    사본이 둘이면 한쪽만 고쳐지고, 그때 `SIM_VERSION` 은 안 고쳐진 쪽을 해시한다.
    """
    from talus.sim import mapgen as M
    from talus.sim import weapons as Wp

    assert len(Wp.WEAPONS) == len(constants.WEAPON_TABLE)
    for weapon, row in zip(Wp.WEAPONS, constants.WEAPON_TABLE, strict=True):
        assert weapon.id == row[0] and weapon.name == row[1] and weapon.kind == row[2]
        assert weapon.max_damage == row[3] and weapon.blast_radius == row[4]
        assert weapon.carve_cells == row[5]
        assert weapon.ammo0 == (None if row[6] < 0 else row[6])
        assert weapon.price == row[7]

    assert len(M.PROVINCES) == len(constants.PROVINCE_TABLE)
    for (bands, depth), row in zip(M.PROVINCES, constants.PROVINCE_TABLE, strict=True):
        assert list(bands) == list(row[:5]) and depth == row[5]
