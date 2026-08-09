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
SHOT_REPLAYS = _of_kind("shots")
MAPGEN_REPLAYS = _of_kind("mapgen")
MATCH_REPLAYS = _of_kind("match")


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


def _apply_cfg(header: dict, seed: int | None = None) -> None:
    cfg = header["cfg"]
    T.CFG.seed = header["seed"] if seed is None else seed
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



def _assert_ballistics_match(header: dict) -> None:
    """골든 헤더의 탄도 상수가 Python 기본값과 **같은지 확인한다. 덮어쓰지 않는다.**

    처음에는 헤더 값을 `B.CFG` 에 setattr 로 주입했다. 의도는 "기본값이 우연히 같아서
    통과하는 것"을 막는 것이었는데 **정확히 반대 효과였다** — 주입하면 Python 기본값이
    TS 와 달라도 대조가 성립한다. 두 구현의 탄도 상수를 맞대는 유일한 게이트가
    상수 이탈에 대해 항상 초록색이 된다.

    게다가 `B.CFG` 는 모듈 전역이라 주입이 뒤따르는 테스트로 샌다 — 파일 단위 실행과
    전체 실행의 결과가 갈린다.

    확인으로 바꾸면 둘 다 사라진다. 밸런스를 의도적으로 바꿨다면 골든을 재생성하면 되고,
    그때 이 검사가 "재생성을 잊었다"를 잡는다.
    """
    from talus.sim import ballistics as B

    for key, value in header["ballistics"].items():
        snake = "".join("_" + char.lower() if char.isupper() else char for char in key)
        assert hasattr(B.CFG, snake), f"탄도 상수 {key} → {snake} 가 Python 에 없다"
        got = getattr(B.CFG, snake)
        assert got == value, (
            f"탄도 상수 {key} 가 갈라졌다: TS(골든) {value} vs Python {got}\n"
            f"  → 밸런스를 바꿨다면 커밋 메시지에 이유를 적고 골든을 재생성한다"
        )


def _assert_tables_match(header: dict) -> None:
    """골든 헤더의 무기·아이템·지질 표가 `constants.py` 와 같은지 확인한다.

    TS 는 이 값들을 하드코딩하고 Python 은 `constants.py` 에서 읽는다. **두 사본이
    어긋나는 것을 잡는 유일한 지점이 여기다.** `MATCH_VERSION` 수동 상향에만 기대면
    "올리는 것을 잊었다"를 아무도 못 잡고, 규칙이 다른 두 클라이언트가 같은 방에 들어간다.

    실제로 그런 상태였다: 무기 8종의 값이 양쪽 소스에만 있어서 `SIM_VERSION` 해시에
    아예 안 들어갔고, 밸런스를 바꿔도 핸드셰이크가 통과했다.
    """
    from talus import constants

    got_weapons = [list(row) for row in constants.WEAPON_TABLE]
    assert header["weapons"] == got_weapons, (
        "무기 표가 갈라졌다 — TS(골든)와 constants.py 가 다르다\n"
        f"  TS     {header['weapons']}\n  Python {got_weapons}"
    )
    got_items = [list(row) for row in constants.ITEM_TABLE]
    assert header["items"] == got_items, "아이템 표가 갈라졌다"
    got_provinces = [list(row) for row in constants.PROVINCE_TABLE]
    assert header["provinces"] == got_provinces, (
        "지질 프로파일이 갈라졌다 — TS(골든)와 constants.py 가 다르다\n"
        f"  TS     {header['provinces']}\n  Python {got_provinces}"
    )


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
    """골든 리플레이가 20개 이상이고 필요한 사이드카가 전부 있다."""
    assert len(REPLAYS) >= 20, f"골든 리플레이가 {len(REPLAYS)}개뿐이다 (20개 이상 필요)"
    for p in REPLAYS:
        header, records = _load(p)
        if "gridFile" in header:
            assert (p.parent / header["gridFile"]).is_file(), f"{header['gridFile']} 이 없다"
        assert len(records) >= 2, f"{p.stem} 레코드가 너무 적다"


@pytest.mark.crosssim
@pytest.mark.parametrize("path", MAPGEN_REPLAYS, ids=lambda p: p.stem)
def test_cross_sim_mapgen(path: pathlib.Path) -> None:
    """사이드카 없이 초기 격자·정착·스폰을 TS 골든과 대조한다."""
    from talus import constants
    from talus.sim import mapgen as M
    from talus.sim.intmath import hash32_scalar

    header, records = _load(path)
    assert header["mapgenVersion"] == M.MAPGEN_VERSION == constants.MAPGEN_VERSION
    assert len(records) == header["caseCount"]

    for rec in records:
        map_seed = rec["mapSeed"]
        _apply_cfg(header, map_seed)
        generated = M.build_map(map_seed)
        T.grid[:] = generated

        assert f"{T.checksum():08X}" == rec["rawChecksum"]
        assert T.mass_count() == rec["rawMass"]

        initial_connectivity = T.connectivity()
        assert initial_connectivity == rec["initialConnectivity"]
        T.mark_all()
        T.set_step(0)

        settle_steps = 0
        connectivity_rounds = 0
        settled = False
        while True:
            settled = False
            while settle_steps < header["maxSettleSteps"]:
                settle_steps += 1
                if T.step().mobile == 0:
                    settled = True
                    break
            if not settled:
                break
            converted = T.connectivity()
            if converted == 0:
                break
            connectivity_rounds += 1
            if connectivity_rounds >= header["connectivityMaxRounds"]:
                settled = False
                break

        assert settled, f"mapSeed {map_seed}: 초기 정착이 상한에 걸렸다"
        assert settle_steps == rec["settleSteps"]
        assert connectivity_rounds == rec["connectivityRounds"]
        assert f"{T.checksum():08X}" == rec["checksum"]
        assert T.mass_count() == rec["mass"]
        assert {
            str(players): M.choose_spawn_cells(T.grid, players) for players in range(2, 7)
        } == rec["spawns"]

        raw_2d = generated.reshape(T.H, T.W)
        left_top = M.surface_cell_y(generated, 2)
        right_top = M.surface_cell_y(generated, T.W - 3)
        assert np.all(raw_2d[left_top:, :2] == T.BEDROCK)
        assert np.all(raw_2d[right_top:, T.W - 2 :] == T.BEDROCK)
        assert np.all(raw_2d[M.BEDROCK_Y :, :] == T.BEDROCK)
        for index, base_x in enumerate(M.ANCHOR_BASE_X):
            jitter = (hash32_scalar(map_seed, index, M.ANCHOR_SALT, 0) & 31) - 15
            x = max(24, min(935, base_x + jitter))
            top = max(220, min(500, M._generated_surface(map_seed, x) + 96))
            assert np.all(raw_2d[top:, x - 3 : x + 3] == T.BEDROCK)


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


# ══════════════════════════════════════════════════════════════════════════
# 발사 리플레이 — 탄도 · 무기 · 피해 · 재배치
#
# 위의 리플레이들은 전부 지형 전용이라 ballistics.py / weapons.py 를 아무것도
# 검증하지 못한다. 버그가 있어도 게이트가 초록색인 상태였다.
# ══════════════════════════════════════════════════════════════════════════


def _trig_bytes() -> bytes | None:
    root = _find_repo_root()
    if root is None:
        return None
    p = root / "tables" / "trig.bin"
    return p.read_bytes() if p.is_file() else None


def _pts_hash(pts: list[tuple[int, int]]) -> str:
    """TS 의 ptsHash 와 같은 값 — Int32Array 리틀엔디언 위의 FNV-1a."""
    from talus.sim.intmath import fnv1a32, hex8

    buf = bytearray()
    for x, y in pts:
        buf += int(x).to_bytes(4, "little", signed=True)
        buf += int(y).to_bytes(4, "little", signed=True)
    return hex8(fnv1a32(buf))


def _match_player(player) -> dict:
    return {
        "slot": player.slot,
        "x": player.x,
        "y": player.y,
        "hp": player.hp,
        "alive": player.alive,
        "buried": player.buried,
        "angle10": player.angle10,
        "power": player.power,
        "gold": player.gold,
        "weaponId": player.weapon_id,
        "ammo": player.ammo,
        "items": {
            "shield": player.items.shield,
            "parachute": player.items.parachute,
            "fuel": player.items.fuel,
            "anemo": player.items.anemo,
        },
        "score": player.score,
        "kills": player.kills,
        "damageDone": player.damage_done,
        "shieldUp": player.shield_up,
    }


def _match_outcome(outcome) -> dict:
    if not outcome.over:
        return {"over": False}
    return {"over": True, "reason": outcome.reason, "winner": outcome.winner}


@pytest.mark.crosssim
@pytest.mark.parametrize("path", MATCH_REPLAYS, ids=lambda p: p.stem)
def test_cross_sim_match(path: pathlib.Path) -> None:
    """매치 골든을 mapSeed + 시간순 intent + purchases 로 처음부터 재생한다."""
    from talus import constants
    from talus.sim import ballistics as B
    from talus.sim import mapgen as M
    from talus.sim import match as Match
    from talus.sim import trig

    blob = _trig_bytes()
    if blob is None:
        pytest.skip("tables/trig.bin 을 못 찾았다")
    trig.load_trig(blob)

    header, records = _load(path)
    _assert_tables_match(header)
    assert header["matchVersion"] == Match.MATCH_VERSION == constants.MATCH_VERSION
    assert header["mapgenVersion"] == M.MAPGEN_VERSION == constants.MAPGEN_VERSION
    assert len(records) == header["recordCount"]
    _apply_cfg(header, header["mapSeed"])
    _assert_ballistics_match(header)

    specs = [
        Match.PlayerSpec(name=spec["name"], is_ai=spec.get("isAI", False))
        for spec in header["specs"]
    ]
    made = Match.create_match(header["mapSeed"], specs)
    assert {
        "steps": made.initial_settle.steps,
        "connectivityRounds": made.initial_settle.connectivity_rounds,
        "forced": made.initial_settle.forced,
    } == header["initialSettle"]
    state = made.state
    assert {
        "roundNo": state.round_no,
        "turnNo": state.turn_no,
        "roundTurn": state.round_turn,
        "activeSlot": state.active_slot,
        "wind": state.wind,
    } == header["initial"]

    for record in records:
        if record["record"] == "shop":
            for purchase in record["purchases"]:
                player = state.players[purchase["slot"]]
                if purchase["kind"] == "item":
                    ok = Match.buy_item(player, purchase["key"])
                else:
                    ok = Match.buy_weapon(player, purchase["weaponId"])
                assert ok == purchase["ok"]
            assert [_match_player(player) for player in state.players] == record["afterPurchases"]

            Match.start_next_round(state)
            assert state.round_no == record["roundNo"]
            assert state.round_turn == record["roundTurn"]
            assert state.turn_no == record["turnNo"]
            assert state.active_slot == record["activeSlot"]
            assert state.wind == record["wind"]
            assert state.spawn_cells == record["spawnCells"]
            assert state.phase == record["phase"]
            assert [_match_player(player) for player in state.players] == record["players"]
            assert f"{T.checksum():08X}" == record["checksum"]
            assert T.mass_count() == record["mass"]
            continue

        assert record["record"] == "turn"
        assert state.round_no == record["roundNo"]
        assert state.round_turn + 1 == record["roundTurn"]
        assert state.active_slot == record["activeSlot"]
        raw_intent = record["intent"]
        intent = Match.Intent(
            angle10=raw_intent["angle10"],
            power=raw_intent["power"],
            weapon_id=raw_intent["weaponId"],
            move_dx=raw_intent["moveDx"],
            use_shield=raw_intent["useShield"],
        )
        result = Match.resolve_match_turn(state, intent)
        assert state.active_slot == record["nextActiveSlot"]
        assert result.turn_no == record["turnNo"]
        assert result.turn_seed == record["turnSeed"]
        assert result.wind == record["wind"]
        assert [
            {"slot": leg.slot, "kind": leg.kind, "n": len(leg.pts), "h": _pts_hash(leg.pts)}
            for leg in result.legs
        ] == record["legs"]
        assert [
            {"x": det.x, "y": det.y, "w": det.weapon.id, "owner": det.owner}
            for det in result.dets
        ] == record["dets"]
        assert result.events == record["events"]
        assert result.removed == record["removed"]
        assert result.filled == record["filled"]
        assert result.conv == record["conv"]
        assert {
            "steps": result.settle.steps,
            "connectivityRounds": result.settle.connectivity_rounds,
            "forced": result.settle.forced,
        } == record["settle"]
        assert result.last_blast_owner == record["lastBlastOwner"]
        assert _match_outcome(result.outcome) == record["outcome"]
        assert result.round_events == record["roundEvents"]
        assert state.phase == record["phase"]
        assert [_match_player(player) for player in state.players] == record["players"]
        assert f"{result.checksum:08X}" == record["checksum"]
        assert result.mass == record["mass"]


@pytest.mark.crosssim
@pytest.mark.parametrize("path", SHOT_REPLAYS, ids=lambda p: p.stem)
def test_cross_sim_shots(path: pathlib.Path) -> None:
    """발사 리플레이를 재생해 궤적·폭발·피해·재배치를 전부 대조한다.

    한 레코드가 턴 하나 전체다:
      resolve_shot → compute_damage(카빙 전 위치 기준, §5.2) → apply_detonation
        → 정착 → 연결성 재검사 → reseat_tank → 낙하 피해

    **절차가 `client/tools/gen-golden.mts` 의 발사 블록과 1:1이다. 한쪽만 고치면 안 된다.**
    """
    from talus.sim import ballistics as B
    from talus.sim import trig
    from talus.sim import weapons as Wp

    blob = _trig_bytes()
    if blob is None:
        pytest.skip("tables/trig.bin 을 못 찾았다")
    trig.load_trig(blob)

    header, records = _load(path)
    assert header["v"] == 1
    _apply_cfg(header)
    _load_grid(header, path)

    _assert_ballistics_match(header)

    for _ in range(40000):
        if T.step().mobile == 0:
            break

    # slots 는 **셀 단위**다. 셀 → subpx 는 × CELL_SUBPX(32) = × 2 × SUBPX(16)
    tanks = [
        B.make_tank(i, cell * 2 * B.SUBPX, f"T{i}") for i, cell in enumerate(header["slots"])
    ]

    for spec, rec in zip(header["shots"], records, strict=True):
        w = Wp.by_id(spec["w"])
        assert w.id == spec["w"]
        by = spec["by"]
        shooter = tanks[by]
        pose = B.shot_pose(shooter, spec["angle10"])
        plan = Wp.resolve_shot(
            pose.x,
            pose.y,
            pose.angle10,
            spec["power"],
            spec["wind"],
            by,
            tanks,
            w,
        )

        # ── 궤적
        got_legs = [
            {"kind": leg.kind, "n": len(leg.pts), "h": _pts_hash(leg.pts)} for leg in plan.legs
        ]
        assert got_legs == rec["legs"], (
            f"{path.stem} 발사 {rec['shot']} ({w.name}): 궤적이 갈라졌다\n"
            f"  TS(golden) {rec['legs']}\n  Python     {got_legs}"
        )

        # ── 폭발 지점
        got_dets = [{"x": d.x, "y": d.y, "w": d.weapon.id} for d in plan.dets]
        assert got_dets == rec["dets"], f"발사 {rec['shot']}: 폭발 지점이 다르다"

        # ── 피해 (카빙 전 위치 기준)
        dmg = []
        for d in plan.dets:
            for hit in B.compute_damage(d.x, d.y, w.to_damage(), tanks):
                dmg.append({"idx": hit.idx, "dmg": hit.dmg, "dist": hit.dist})
        assert dmg == rec["dmg"], f"발사 {rec['shot']}: 피해가 다르다"
        for hit in dmg:
            tk = tanks[hit["idx"]]
            tk.hp -= hit["dmg"]
            if tk.hp <= 0:
                tk.hp = 0
                tk.alive = False

        removed = filled = 0
        for d in plan.dets:
            r = Wp.apply_detonation(d)
            removed += r.removed
            filled += r.filled
        conv = T.connectivity()
        assert (removed, conv, filled) == (rec["removed"], rec["conv"], rec["filled"]), (
            f"발사 {rec['shot']}: 카빙/적층량이 다르다"
        )

        # ── 정착 + 연결성 재검사
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
        assert steps == rec["steps"], f"발사 {rec['shot']}: 정착 스텝 수가 다르다"

        # ── 재배치 (정착이 완전히 끝난 뒤에만)
        falls = []
        for tk in tanks:
            if not tk.alive:
                falls.append(0)
                continue
            f = B.reseat_tank(tk)
            if f < 0:
                tk.alive = False
                tk.hp = 0
                falls.append(-1)
                continue
            fd = B.fall_damage(f)
            tk.hp -= fd
            if tk.hp <= 0:
                tk.hp = 0
                tk.alive = False
            tk.buried = B.buried_fraction(tk) >= B.CFG.burial_permille
            falls.append(f)
        assert falls == rec["falls"], f"발사 {rec['shot']}: 낙하 픽셀이 다르다"

        got_tanks = [
            {"x": t.x, "y": t.y, "hp": t.hp, "alive": t.alive, "buried": t.buried} for t in tanks
        ]
        assert got_tanks == rec["tanks"], (
            f"발사 {rec['shot']}: 탱크 상태가 갈라졌다\n"
            f"  TS(golden) {rec['tanks']}\n  Python     {got_tanks}"
        )

        got_sum = f"{T.checksum():08X}"
        assert got_sum == rec["checksum"], (
            f"발사 {rec['shot']}: 지형 체크섬이 갈라졌다 TS {rec['checksum']} vs {got_sum}"
        )
        assert T.mass_count() == rec["mass"]


@pytest.mark.crosssim
def test_shot_replay_exercises_every_weapon() -> None:
    """발사 리플레이가 무기 8종을 전부 밟는다.

    무기를 하나 추가하고 골든을 재생성하지 않으면 그 무기는 **검증 없이** 들어간다.
    """
    from talus.sim import weapons as Wp

    if not SHOT_REPLAYS:
        pytest.skip("kind=shots 리플레이가 없다")
    for p in SHOT_REPLAYS:
        header, _ = _load(p)
        used = {s["w"] for s in header["shots"]}
        missing = {w.id for w in Wp.WEAPONS} - used
        assert not missing, f"{p.stem}: 무기 {sorted(missing)} 이(가) 한 번도 안 나온다"
