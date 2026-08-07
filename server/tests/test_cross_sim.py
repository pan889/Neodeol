"""교차 검증 — 골든 리플레이를 Python numpy 구현으로 재생해 TS 체크섬과 대조한다.

`CLAUDE.md` §결정론 게이트 (2) / `docs/simulation.md` §9 / `docs/roadmap.md` Phase 3

**이 프로젝트에서 가장 중요한 테스트다.** 여기가 통과하지 못하면 Phase 4 이후 모든
버그가 "가끔 지형이 다르게 보임"으로 나타나고, 그건 재현이 거의 불가능한 종류다.

골든 파일은 `client/tools/gen-golden.mts` 가 만든다. TS 구현이 진실의 원본이고
(CLAUDE.md §포팅 방향), Python 이 같은 입력에서 같은 결과를 내는지 본다.

────────────────────────────────────────────────────────────────────────────
골든 파일이 깨졌을 때

의도적으로 규칙을 바꿔 깨졌다면 **깨진 이유를 커밋 메시지에 적고**
`node --experimental-strip-types client/tools/gen-golden.mts` 로 재생성한다.
이유 없이 재생성하는 것은 금지다 — 결정론 버그를 은폐하는 가장 흔한 경로다.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import pathlib

import numpy as np
import pytest

from talus.sim import terrain as T


def _find_repo_root() -> pathlib.Path | None:
    here = pathlib.Path(__file__).resolve()
    for p in (here, *here.parents):
        if (p / "CLAUDE.md").is_file() or (p / "docs").is_dir():
            return p
    return None


def _replay_dir() -> pathlib.Path | None:
    """골든 리플레이 위치.

    컨테이너에서는 `/app/tests` 가 이미 `server/tests` 라 저장소 루트의
    `tests/replays` 와 이름이 겹친다. 그래서 `TALUS_REPLAY_DIR` 로 명시하고,
    없으면 저장소 루트 기준으로 찾는다 (호스트 직접 실행).
    """
    env = os.environ.get("TALUS_REPLAY_DIR")
    if env:
        p = pathlib.Path(env)
        return p if p.is_dir() else None
    root = _find_repo_root()
    if root is None:
        return None
    p = root / "tests" / "replays"
    return p if p.is_dir() else None


REPLAY_DIR = _replay_dir()


def _replays() -> list[pathlib.Path]:
    if REPLAY_DIR is None or not REPLAY_DIR.is_dir():
        return []
    return sorted(REPLAY_DIR.glob("*.jsonl"))


REPLAYS = _replays()


def _load(path: pathlib.Path) -> tuple[dict, list[dict]]:
    lines = path.read_text(encoding="utf-8").strip().split("\n")
    header = json.loads(lines[0])
    records = [json.loads(ln) for ln in lines[1:]]
    return header, records


def _of_kind(kind: str) -> list[pathlib.Path]:
    return [p for p in REPLAYS if _load(p)[0].get("kind") == kind]


STEP_REPLAYS = _of_kind("terrain-only")
TURN_REPLAYS = _of_kind("terrain-turns")


def _turn_params() -> list:
    """턴 리플레이를 파라미터로 낸다. 1000턴짜리는 `slow` 로 기본 제외한다.

    재생이 10분 안팎이라 상시 게이트에 넣으면 아무도 게이트를 안 돌리게 된다.
    60턴짜리가 매 변경의 그물이고, 1000턴은 릴리스 전 그물이다.
    """
    out = []
    for p in TURN_REPLAYS:
        marks = [pytest.mark.slow] if _load(p)[0]["turnCount"] >= 500 else []
        out.append(pytest.param(p, id=p.stem, marks=marks))
    return out


pytestmark = pytest.mark.skipif(
    not REPLAYS,
    reason="tests/replays/*.jsonl 이 없다 — client/tools/gen-golden.mts 로 생성한다",
)


def _apply_cfg(header: dict) -> None:
    cfg = header["cfg"]
    T.CFG.seed = header["seed"]
    T.CFG.slide_sand_q8 = cfg["slideSandQ8"]
    T.CFG.slide_soil_q8 = cfg["slideSoilQ8"]
    T.CFG.slide_scree_q8 = cfg["slideScreeQ8"]
    T.CFG.slide_gate_static = cfg["slideGateStatic"]
    T.CFG.both_directions = cfg["bothDirections"]
    T.CFG.blast_resist_q8 = {int(k): int(v) for k, v in cfg["blastResistQ8"].items()}
    T.reset_gate_cache()


def _load_grid(header: dict, path: pathlib.Path) -> None:
    blob = gzip.decompress((path.parent / header["gridFile"]).read_bytes())
    assert len(blob) == T.N, f"격자 크기가 다르다: {len(blob)}"
    sha = hashlib.sha256(blob).hexdigest()
    assert sha == header["gridSha256"], "격자 사이드카가 헤더 해시와 다르다"
    T.grid[:] = np.frombuffer(blob, dtype=np.uint8)
    T.connectivity()
    T.mark_all()
    T.set_step(0)


@pytest.mark.crosssim
@pytest.mark.parametrize("path", STEP_REPLAYS, ids=lambda p: p.stem)
def test_cross_sim(path: pathlib.Path) -> None:
    """골든 리플레이 1개를 재생해 매 표본 지점의 체크섬·질량을 대조한다."""
    header, records = _load(path)
    assert header["v"] == 1, f"모르는 리플레이 버전: {header['v']}"
    _apply_cfg(header)
    _load_grid(header, path)

    step_no = 0
    for rec in records:
        target = rec["step"]
        while step_no < target:
            T.step()
            step_no += 1
        got_sum = f"{T.checksum():08X}"
        got_mass = T.mass_count()
        assert got_sum == rec["checksum"], (
            f"{path.stem} step {target}: 체크섬이 갈라졌다\n"
            f"  TS(golden) {rec['checksum']}\n"
            f"  Python     {got_sum}\n"
            f"  질량 {rec['mass']} vs {got_mass}\n"
            f"  → 규칙을 의도적으로 바꿨다면 커밋 메시지에 이유를 적고 골든을 재생성한다"
        )
        assert got_mass == rec["mass"], f"{path.stem} step {target}: 질량 불일치"


@pytest.mark.crosssim
def test_golden_set_is_complete() -> None:
    """골든 리플레이가 20개 이상이고 사이드카가 전부 있다. (roadmap Phase 3 완료 조건)"""
    assert len(REPLAYS) >= 20, f"골든 리플레이가 {len(REPLAYS)}개뿐이다 (20개 이상 필요)"
    for p in REPLAYS:
        header, records = _load(p)
        assert (p.parent / header["gridFile"]).is_file(), f"{header['gridFile']} 이 없다"
        assert len(records) >= 2, f"{p.stem} 레코드가 너무 적다"


@pytest.mark.crosssim
@pytest.mark.parametrize("path", _turn_params())
def test_replay_stable(path: pathlib.Path) -> None:
    """장기 리플레이 — **매 턴** 체크섬이 갈라지지 않는다.

    `docs/roadmap.md` Phase 3 완료 조건 (3). 위의 `test_cross_sim` 은 *스텝* 단위
    대조라 턴 경계(연결성 재검사 루프, step 카운터 연속성)에서 생기는 이탈을
    못 잡는다. 여기서는 한 턴 전체 — carve/deposit → 정착 → 연결성 재검사 —
    를 돌린 뒤에만 대조하므로, 턴 내부 스텝 수가 한 번이라도 어긋나면 즉시 터진다.

    턴 진행 절차는 `client/tools/gen-golden.mts` 의 장기 리플레이 블록과 1:1이다.
    한쪽만 고치면 안 된다.
    """
    header, records = _load(path)
    assert header["v"] == 1
    _apply_cfg(header)
    _load_grid(header, path)

    # 초기 정착 — 생성기와 동일하게 격자를 먼저 가라앉힌다
    for _ in range(40000):
        if T.step().mobile == 0:
            break

    turns = header["turns"]
    assert len(turns) == len(records) == header["turnCount"]

    total = 0
    for spec, rec in zip(turns, records, strict=True):
        cx, cy, r = spec["cx"], spec["cy"], spec["r"]
        if spec["kind"] == "deposit":
            T.deposit(cx, cy, r, T.SOIL)
        else:
            T.carve(cx, cy, r)

        steps = 0
        rounds = 0
        while True:
            settled = False
            while steps < 40000:
                steps += 1
                if T.step().mobile == 0:
                    settled = True
                    break
            if not settled:
                break
            if T.connectivity() > 0:
                rounds += 1
                if rounds < 8:
                    continue
            break
        total += steps

        assert steps == rec["steps"], (
            f"{path.stem} 턴 {rec['turn']}: 정착 스텝 수가 다르다 "
            f"TS {rec['steps']} vs Python {steps} — 자동자가 이미 갈라졌다"
        )
        assert total == rec["totalSteps"]
        got = f"{T.checksum():08X}"
        assert got == rec["checksum"], (
            f"{path.stem} 턴 {rec['turn']} ({total:,} 스텝 누적): 체크섬이 갈라졌다\n"
            f"  TS(golden) {rec['checksum']}\n  Python     {got}\n"
            f"  질량 {rec['mass']} vs {T.mass_count()}"
        )
        assert T.mass_count() == rec["mass"], f"턴 {rec['turn']} 질량 불일치"


@pytest.mark.crosssim
def test_long_replay_is_long_enough() -> None:
    """장기 리플레이가 실제로 길다 — 완료 조건이 형식만 채우고 끝나지 않게.

    이 검사가 있는 이유: 첫 판에서 턴 좌표를 지형과 무관하게 뽑았더니 60턴 중
    다수가 깊은 암반 속이거나 허공이라 `carve` 가 0셀을 지웠고, 정착이 1스텝에
    끝났다. 턴 수만 세면 그런 리플레이도 "60턴 통과"로 보인다.
    """
    assert TURN_REPLAYS, "kind=terrain-turns 리플레이가 없다"
    for p in TURN_REPLAYS:
        header, records = _load(p)
        turns = header["turnCount"]
        assert turns >= 60, f"{p.stem}: {turns}턴뿐"
        # 턴당 평균 200스텝 이상 — 자동자가 실제로 돌았다는 증거.
        # 두 리플레이의 폭발 규모가 다르므로(60턴본 대형, 1000턴본 중간) 하한은
        # 작은 쪽에 맞춘다. 이 검사는 "규모가 충분한가"가 아니라 "턴이 no-op 인가"다.
        assert header["totalSteps"] >= turns * 200, (
            f"{p.stem}: {turns}턴에 {header['totalSteps']}스텝뿐 — 턴이 no-op 이다"
        )
        # 질량이 한쪽으로 쓸려가지 않는다. carve 만 계속하면 맵이 암반까지 벗겨져
        # 뒤쪽 턴이 전부 no-op 이 된다 — 실제로 그렇게 만들었다가 1000턴에서 86% 를 잃었다.
        m0, m1 = records[0]["mass"], records[-1]["mass"]
        assert m1 * 2 >= m0, f"{p.stem}: 질량이 {m0:,} → {m1:,} 로 반 이상 사라졌다"
        assert m1 <= m0 * 2, f"{p.stem}: 질량이 {m0:,} → {m1:,} 로 두 배 넘게 불었다"
        idle = sum(1 for r in records if r["steps"] <= 2)
        assert idle * 5 <= turns, f"{p.stem}: 정착 2스텝 이하 턴이 {idle}/{turns} 개"


@pytest.mark.crosssim
def test_long_replays_divide_the_work() -> None:
    """두 장기 리플레이가 **규모**와 **지속**을 나눠 맡고 있다.

    같은 성격의 리플레이 두 개는 두 배의 시간을 쓰고 한 개만큼만 검증한다.
    · `terrain-long`   60턴 × 대형(반경 14~59) — 한 턴이 큰 붕괴인가
    · `terrain-long1k` 1000턴 × 중간(반경 8~27) — 오래 돌려도 안 갈라지는가

    초기 격자는 같아야 한다 — 같은 생성기 실행에서 나왔다는 표시이고,
    한쪽만 재생성해 짝이 어긋나는 사고를 여기서 잡는다.
    """
    if len(TURN_REPLAYS) < 2:
        pytest.skip("장기 리플레이가 하나뿐이다")
    heads = {_load(p)[0]["turnCount"]: _load(p)[0] for p in TURN_REPLAYS}
    assert 60 in heads and 1000 in heads, f"60턴/1000턴이 둘 다 필요하다: {sorted(heads)}"

    shas = {h["gridSha256"] for h in heads.values()}
    assert len(shas) == 1, "초기 격자가 다르다 — 한쪽만 재생성됐다"

    short, long_ = heads[60], heads[1000]
    assert short["rMin"] > long_["rMin"], "60턴본이 더 큰 폭발을 써야 한다"
    # 턴당 평균 스텝으로 역할 분담을 확인한다
    avg_s = short["totalSteps"] // short["turnCount"]
    avg_l = long_["totalSteps"] // long_["turnCount"]
    assert avg_s > avg_l * 2, f"규모 차이가 없다: 60턴 {avg_s}/턴 vs 1000턴 {avg_l}/턴"
    assert long_["totalSteps"] > short["totalSteps"], "1000턴본이 총량에서 더 많이 돌아야 한다"
