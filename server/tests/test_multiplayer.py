"""Phase 4 코드형 룸과 msgpack WebSocket 통합 검증."""

from __future__ import annotations

import gzip
import pathlib
from urllib.parse import urlencode

from fastapi.testclient import TestClient

from talus import constants
from talus.net.app import app
from talus.net.protocol import ErrorCode, pack_message, unpack_message
from talus.sim.intmath import fnv1a32


def _repo_root() -> pathlib.Path | None:
    here = pathlib.Path(__file__).resolve()
    for parent in (here, *here.parents):
        if (parent / "tables" / "trig.bin").is_file():
            return parent
    return None


REPO = _repo_root()


def _socket_path(session: dict[str, object], **overrides: object) -> str:
    query: dict[str, object] = {
        "token": session["token"],
        "protocolVersion": session["protocolVersion"],
        "ruleHash": session["ruleHash"],
        "buildHash": "pytest",
    }
    query.update(overrides)
    return f"{session['wsPath']}?{urlencode(query)}"


def _receive_type(socket: object, expected: str, limit: int = 12) -> dict[str, object]:
    seen: list[str] = []
    for _ in range(limit):
        message = unpack_message(socket.receive_bytes())
        seen.append(message["t"])
        if message["t"] == expected:
            return message
    raise AssertionError(f"{expected} 메시지를 받지 못했다: {seen}")


def _receive_room_state(socket: object, connected: int) -> dict[str, object]:
    for _ in range(8):
        message = _receive_type(socket, "roomState")
        if sum(1 for player in message["players"] if player["connected"]) == connected:
            return message
    raise AssertionError(f"connected={connected} roomState를 받지 못했다")


def _intent(turn: dict[str, object]) -> dict[str, object]:
    return {
        "t": "intent",
        "turnNo": turn["turnNo"],
        "activeSlot": turn["activeSlot"],
        "angle10": 450,
        "power": 520,
        "weaponId": 0,
        "moveDx": 0,
        "useShield": False,
    }


def test_room_capacity_and_version_gate() -> None:
    with TestClient(app) as client:
        host = client.post("/api/rooms", json={"name": "host", "maxPlayers": 2}).json()
        code = host["roomCode"]
        guest = client.post(f"/api/rooms/{code}/join", json={"name": "guest"})
        assert guest.status_code == 200

        full = client.post(f"/api/rooms/{code}/join", json={"name": "late"})
        assert full.status_code == 409
        assert full.json()["detail"]["code"] == ErrorCode.ROOM_FULL

        wrong_version = int(host["protocolVersion"]) + 1
        with client.websocket_connect(
            _socket_path(host, protocolVersion=wrong_version)
        ) as socket:
            error = unpack_message(socket.receive_bytes())
            assert error["t"] == "error"
            assert error["code"] == ErrorCode.VERSION_MISMATCH
            assert "프로토콜" in error["msg"]

        # 프로토콜은 맞는데 **규칙**이 다른 경우. 예전에는 클라가 서버에서 받은 값을
        # 되돌려 보내서 이 경로가 원리적으로 발화하지 않았다 (§규칙 지문 핸드셰이크).
        with client.websocket_connect(
            _socket_path(host, ruleHash="DEADBEEF")
        ) as socket:
            error = unpack_message(socket.receive_bytes())
            assert error["t"] == "error"
            assert error["code"] == ErrorCode.VERSION_MISMATCH
            assert "규칙" in error["msg"], f"규칙 불일치가 프로토콜 오류로 보고된다: {error}"


def test_two_player_turn_desync_and_reconnect() -> None:
    with TestClient(app) as client:
        host = client.post("/api/rooms", json={"name": "alpha", "maxPlayers": 4}).json()
        code = host["roomCode"]
        guest = client.post(f"/api/rooms/{code}/join", json={"name": "bravo"}).json()

        with client.websocket_connect(_socket_path(host)) as host_socket:
            assert _receive_type(host_socket, "hello")["mySlot"] == 0
            _receive_room_state(host_socket, connected=1)

            with client.websocket_connect(_socket_path(guest)) as guest_socket:
                assert _receive_type(guest_socket, "hello")["mySlot"] == 1
                host_room = _receive_room_state(host_socket, connected=2)
                guest_room = _receive_room_state(guest_socket, connected=2)
                assert [player["slot"] for player in host_room["players"]] == [0, 1]
                assert guest_room["maxPlayers"] == 4

                host_socket.send_bytes(pack_message({"t": "start"}))
                host_init = _receive_type(host_socket, "matchInit")
                guest_init = _receive_type(guest_socket, "matchInit")
                assert host_init["mapSeed"] == guest_init["mapSeed"]
                assert host_init["checksum"] == guest_init["checksum"]

                host_turn = _receive_type(host_socket, "turnBegin")
                guest_turn = _receive_type(guest_socket, "turnBegin")
                assert host_turn == guest_turn
                assert host_turn["turnNo"] == 1
                assert host_turn["activeSlot"] == 0
                assert host_turn["deadlineMs"] > 0

                guest_socket.send_bytes(pack_message(_intent(guest_turn)))
                error = _receive_type(guest_socket, "error")
                assert error["code"] == ErrorCode.NOT_ACTIVE

                host_socket.send_bytes(pack_message(_intent(host_turn)))
                host_resolve = _receive_type(host_socket, "turnResolve")
                guest_resolve = _receive_type(guest_socket, "turnResolve")
                assert host_resolve == guest_resolve
                assert host_resolve["activeSlot"] == 0

                host_result = _receive_type(host_socket, "turnResult")
                guest_result = _receive_type(guest_socket, "turnResult")
                assert host_result["checksum"] == guest_result["checksum"]
                assert host_result["phase"] == "aim"
                assert host_result["nextActiveSlot"] == 1

                host_socket.send_bytes(
                    pack_message(
                        {
                            "t": "playbackDone",
                            "turnNo": host_result["turnNo"],
                            "checksum": host_result["checksum"] ^ 1,
                        }
                    )
                )
                desync = _receive_type(host_socket, "desync")
                full_state = _receive_type(host_socket, "fullState")
                assert desync["serverChecksum"] == host_result["checksum"]
                grid = gzip.decompress(full_state["gridGzip"])
                assert len(grid) == constants.GRID_W * constants.GRID_H
                assert max(grid) <= 5
                assert fnv1a32(grid) == full_state["checksum"]

                guest_socket.send_bytes(
                    pack_message(
                        {
                            "t": "playbackDone",
                            "turnNo": guest_result["turnNo"],
                            "checksum": guest_result["checksum"],
                        }
                    )
                )
                host_turn_2 = _receive_type(host_socket, "turnBegin")
                guest_turn_2 = _receive_type(guest_socket, "turnBegin")
                assert host_turn_2 == guest_turn_2
                assert host_turn_2["turnNo"] == 2
                assert host_turn_2["activeSlot"] == 1

                summary = client.get(f"/api/rooms/{code}").json()
                assert summary["telemetry"] == {"turns": 1, "desyncs": 1, "resyncs": 1}

            _receive_room_state(host_socket, connected=1)

            with client.websocket_connect(_socket_path(guest)) as reconnected:
                hello = _receive_type(reconnected, "hello")
                assert hello["mySlot"] == 1
                _receive_room_state(reconnected, connected=2)
                full_state = _receive_type(reconnected, "fullState")
                resumed_turn = _receive_type(reconnected, "turnBegin")
                assert full_state["mySlot"] == 1
                assert full_state["status"] == "aim"
                assert resumed_turn["turnNo"] == 2
                assert resumed_turn["activeSlot"] == 1



# ══════════════════════════════════════════════════════════════════════════
# 룸을 버릴 때 태스크도 같이 죽는다
#
# `_expire_idle_room` 이 `self._rooms.pop()` 만 하던 시절에는 페이즈 타이머와 좌석
# 하트비트가 그대로 살아남았다. 그 태스크의 클로저가 `room` 을 강하게 잡고 있어
# GC 대상도 아니고, 타이머가 만료되면 아무도 안 보는 룸이 계속 턴을 해결했다.
# 서버를 오래 띄우면 누적되는 종류라 테스트가 없으면 안 보인다.
# ══════════════════════════════════════════════════════════════════════════
import asyncio

from talus.room.service import Room, Seat


def test_cancel_tasks_kills_every_task_on_the_room() -> None:
    async def scenario() -> None:
        async def forever() -> None:
            await asyncio.sleep(3600)

        seats = [
            Seat(slot=0, name="A", token="t0", host=True),
            Seat(slot=1, name="B", token="t1"),
        ]
        room = Room(code="TEST01", max_players=2, map_seed=1, seats=seats)
        room.aim_task = asyncio.create_task(forever())
        room.playback_task = asyncio.create_task(forever())
        room.shop_task = asyncio.create_task(forever())
        room.idle_task = asyncio.create_task(forever())
        for seat in seats:
            seat.heartbeat_task = asyncio.create_task(forever())

        spawned = [
            room.aim_task,
            room.playback_task,
            room.shop_task,
            room.idle_task,
            *[seat.heartbeat_task for seat in seats],
        ]
        room.cancel_tasks()
        await asyncio.gather(*spawned, return_exceptions=True)

        for task in spawned:
            assert task.cancelled() or task.done(), "태스크가 살아남았다"
        assert room.aim_task is None
        assert room.playback_task is None
        assert room.shop_task is None
        assert room.idle_task is None
        for seat in seats:
            assert seat.heartbeat_task is None, "좌석 하트비트 참조가 남았다"

    asyncio.run(scenario())


# ══════════════════════════════════════════════════════════════════════════
# 규칙 지문 핸드셰이크 (netcode.md §7.3)
#
# 예전에는 클라이언트가 `GET /version` 으로 받은 `simVersion` 을 접속할 때 그대로
# 되돌려 보냈고 서버가 그걸 자기 값과 비교했다 — **동어반복이라 원리적으로 불일치가
# 나지 않았다.** 규칙이 다른 두 빌드가 같은 방에 들어갈 수 있었고, 그러면 desync 가
# 나기 전까지 아무도 모른다.
#
# 지금은 양쪽이 **각자의 규칙 표에서** 지문을 계산한다 (`sim/rules.py`).
# ══════════════════════════════════════════════════════════════════════════

import dataclasses

import msgpack

from talus.sim import rules as Rules


def _open(client, code: str, token: str, *, rule_hash: str, protocol: int) -> dict:
    url = (
        f"/ws/rooms/{code}?token={token}"
        f"&protocolVersion={protocol}&ruleHash={rule_hash}"
    )
    with client.websocket_connect(url) as ws:
        return msgpack.unpackb(ws.receive_bytes(), raw=False)


def test_handshake_rejects_a_different_rule_set() -> None:
    """규칙 지문이 다르면 접속을 거부한다. **이 검사가 실제로 발화해야 한다.**"""
    from fastapi.testclient import TestClient

    from talus.net.app import app

    with TestClient(app) as client:
        room = client.post("/api/rooms", json={"name": "host", "maxPlayers": 2}).json()
        code, token = room["roomCode"], room["token"]

        ok = _open(client, code, token, rule_hash=Rules.RULE_HASH, protocol=3)
        assert ok["t"] == "hello", f"올바른 지문인데 거부됐다: {ok}"

        bad = _open(client, code, token, rule_hash="DEADBEEF", protocol=3)
        assert bad["t"] == "error", "지문이 달라도 통과한다 — 검사가 동어반복이다"

        old = _open(client, code, token, rule_hash=Rules.RULE_HASH, protocol=2)
        assert old["t"] == "error", "옛 프로토콜이 통과한다"


def test_rule_hash_is_not_the_server_constants_hash() -> None:
    """지문과 `SIM_VERSION` 은 **다른 것**이다.

    같아지면 클라이언트가 자기 규칙에서 계산할 수 없게 되고, 그 순간 동어반복으로 돌아간다.
    `SIM_VERSION` 은 `constants.py` 전체의 SHA-256(Python 전용)이고,
    지문은 규칙 값만 담은 정수 수열의 FNV-1a(양쪽 계산 가능)다.
    """
    from talus import constants

    assert Rules.RULE_HASH != constants.SIM_VERSION
    assert len(Rules.RULE_HASH) == 8, "지문은 8자리 hex 다"
    assert Rules.RULE_HASH == Rules.rule_hash(), "호출마다 값이 달라진다"


def test_rule_fingerprint_holds_only_integers() -> None:
    """지문에 정수가 아닌 것이 섞이면 안 된다.

    TS 쪽에서 `undefined` 가 섞이면 `| 0` 이 **조용히 0 으로** 만들어 길이는 맞고 값만
    달라진다. 실제로 `PROVINCE_BLEND` 를 export 하지 않아 그런 상태가 됐었다.
    """
    fingerprint = Rules.rule_fingerprint()
    assert len(fingerprint) > 100, f"지문이 {len(fingerprint)}개뿐이다"
    for index, value in enumerate(fingerprint):
        assert type(value) is int, f"{index}번이 정수가 아니다: {value!r}"
        assert -(2**31) <= value < 2**31, f"{index}번이 int32 를 벗어났다: {value}"


def test_rule_hash_reacts_to_a_balance_change() -> None:
    """무기 값을 하나만 바꿔도 지문이 바뀐다 — 안 바뀌면 검사가 무의미하다."""
    from talus.sim import weapons as Wp

    before = Rules.rule_hash()
    original = Wp.WEAPONS[1]
    try:
        Wp.WEAPONS[1] = dataclasses.replace(original, max_damage=original.max_damage + 1)
        after = Rules.rule_hash()
    finally:
        Wp.WEAPONS[1] = original
    assert before != after, "무기 피해를 바꿨는데 지문이 그대로다"
    assert Rules.rule_hash() == before, "복원 후 값이 안 돌아왔다"


# ══════════════════════════════════════════════════════════════════════════
# 상점 · 라운드 전환 · 리싱크 — room/service.py 의 나머지 절반
#
# 기존 테스트는 라운드 1의 턴 1~2 까지만 갔다. 그래서 `buy` · `shopReady` ·
# `_start_next_round_locked` · `resyncReq` · `matchEnd` 가 전부 무테스트였고,
# 리뷰에서 변이 8개를 동시에 주입해도 전체 스위트가 통과했다.
# ══════════════════════════════════════════════════════════════════════════


def _make_room(client: TestClient, players: int = 2) -> tuple[str, list[dict]]:
    host = client.post("/api/rooms", json={"name": "host", "maxPlayers": players}).json()
    code = host["roomCode"]
    sessions = [host]
    for index in range(1, players):
        sessions.append(client.post(f"/api/rooms/{code}/join", json={"name": f"g{index}"}).json())
    return code, sessions


def _end_the_round(client: TestClient, code: str) -> None:
    """활성 슬롯을 뺀 전원을 쓰러뜨려 다음 턴에 라운드가 끝나게 만든다.

    라운드를 실제로 싸워서 끝내려면 명중이 필요하고, 그건 결정론적으로 잡기 어렵다.
    여기서 검증하려는 것은 전투가 아니라 **라운드 경계 이후의 서비스 동작**이다.
    """
    manager = app.state.room_manager
    room = manager._rooms[code]
    state = room.state
    assert state is not None
    for player in state.players:
        if player.slot != state.active_slot:
            player.hp = 0
            player.alive = False


def test_shop_round_transition_and_purchases() -> None:
    """라운드 종료 → 상점 → 구매 → 준비 → 다음 라운드가 실제로 돈다."""
    with TestClient(app) as client:
        code, (host, guest) = _make_room(client)
        with client.websocket_connect(_socket_path(host)) as hs, \
             client.websocket_connect(_socket_path(guest)) as gs:
            _receive_type(hs, "hello")
            _receive_type(gs, "hello")
            hs.send_bytes(pack_message({"t": "start"}))
            _receive_type(hs, "matchInit")
            _receive_type(gs, "matchInit")
            turn = _receive_type(hs, "turnBegin")
            _receive_type(gs, "turnBegin")

            _end_the_round(client, code)
            hs.send_bytes(pack_message(_intent(turn)))
            round_end = _receive_type(hs, "roundEnd", limit=20)
            assert round_end["roundNo"] == 1
            _receive_type(gs, "roundEnd", limit=20)

            # ── 상점 게이트: 라운드 번호가 다르면 거부한다
            hs.send_bytes(pack_message({"t": "buy", "roundNo": 99, "kind": "item", "itemKey": "shield"}))
            assert _receive_type(hs, "error")["code"] == ErrorCode.BAD_PHASE

            # ── 형식이 잘못된 구매
            hs.send_bytes(pack_message({"t": "buy", "roundNo": 1, "kind": "nope"}))
            assert _receive_type(hs, "error")["code"] == ErrorCode.BAD_MESSAGE

            # ── 실제 구매: 골드가 줄고 아이템이 는다
            manager = app.state.room_manager
            state = manager._rooms[code].state
            before_gold = state.players[0].gold
            hs.send_bytes(pack_message({"t": "buy", "roundNo": 1, "kind": "item", "itemKey": "shield"}))
            result = _receive_type(hs, "buyResult")
            assert result["ok"] is True and result["slot"] == 0
            assert state.players[0].items.shield == 1
            assert state.players[0].gold < before_gold
            assert result["player"]["gold"] == state.players[0].gold

            # ── 돈이 모자란 구매는 실패하되 상태를 안 바꾼다
            state.players[0].gold = 0
            hs.send_bytes(pack_message({"t": "buy", "roundNo": 1, "kind": "weapon", "weaponId": 1}))
            assert _receive_type(hs, "buyResult")["ok"] is False
            assert state.players[0].gold == 0

            # 준비는 전원이 해야 넘어간다 — 한 명만으로는 상점에 머무른다
            hs.send_bytes(pack_message({"t": "shopReady", "roundNo": 1}))
            hs.send_bytes(pack_message({"t": "resyncReq", "turnNo": 1, "myChecksum": 0}))
            _receive_type(hs, "fullState", limit=20)
            assert manager._rooms[code].status == "shop", "한 명 준비로 라운드가 넘어갔다"

            # ── 나머지가 준비하면 다음 라운드가 시작한다
            gs.send_bytes(pack_message({"t": "shopReady", "roundNo": 1}))
            start = _receive_type(hs, "roundStart", limit=20)
            assert start["roundNo"] == 2
            # ⚠ `room.state` 는 라운드 전환에서 **새 객체로 바뀐다** — 프로세스 풀을
            #   건너오며 pickle 되기 때문이다. 옛 참조를 들고 있으면 라운드 1 을 본다.
            state = manager._rooms[code].state
            assert state.round_no == 2
            # 라운드가 바뀌면 전원이 되살아난다
            assert all(player.alive for player in state.players)
            assert all(player.hp == constants.MAX_HP for player in state.players)


def test_resync_request_sends_full_state_and_counts() -> None:
    """`resyncReq` 가 전체 지형을 보내고 텔레메트리에 잡힌다.

    절대 규칙 4 의 **복구 경로**다 — 정상 경로가 아니라는 것이 카운터로 드러나야 한다.
    """
    with TestClient(app) as client:
        code, (host, guest) = _make_room(client)
        with client.websocket_connect(_socket_path(host)) as hs, \
             client.websocket_connect(_socket_path(guest)) as gs:
            _receive_type(hs, "hello")
            _receive_type(gs, "hello")
            hs.send_bytes(pack_message({"t": "start"}))
            _receive_type(hs, "matchInit")
            _receive_type(gs, "matchInit")
            _receive_type(hs, "turnBegin")

            hs.send_bytes(pack_message({"t": "resyncReq", "turnNo": 1, "myChecksum": 0}))
            full = _receive_type(hs, "fullState", limit=20)
            grid = gzip.decompress(full["gridGzip"])
            assert len(grid) == constants.GRID_W * constants.GRID_H
            assert fnv1a32(grid) == full["checksum"]

            telemetry = client.get(f"/api/rooms/{code}").json()["telemetry"]
            assert telemetry["resyncs"] >= 1, f"리싱크가 안 세어진다: {telemetry}"
            assert telemetry["desyncs"] == 0, "요청 리싱크가 desync 로 잡히면 안 된다"


def test_aim_timeout_resolves_the_turn_without_input() -> None:
    """조준 시간이 지나면 서버가 알아서 턴을 해결한다.

    **끊긴 플레이어가 방을 멈추면 안 된다** (roadmap Phase 4 완료 조건).
    타이머를 짧게 준 매니저를 직접 쓴다 — 실제 상수(30초)로는 테스트가 못 기다린다.
    """
    import asyncio

    from talus.room.service import RoomManager

    async def scenario() -> None:
        root = REPO if REPO else pathlib.Path(".")
        manager = RoomManager(root / "tables" / "trig.bin", sim_workers=1)
        try:
            room, host_seat = await manager.create_room("host", 2)
            await manager.join_room(room.code, "guest")
            for seat in room.seats:
                seat.connected = True
                seat.websocket = _NullSocket()
            await manager.start_match(room, host_seat)
            assert room.status == "aim"
            first_turn = room.state.turn_no

            # 서버가 스스로 해결하도록 타이머를 즉시 만료시킨다
            room.cancel_tasks()
            await manager._aim_timeout(room, room.state.turn_no + 1, room.state.active_slot, 0)
            assert room.state.turn_no == first_turn + 1, "입력 없이 턴이 안 넘어갔다"
        finally:
            await manager.close()

    asyncio.run(scenario())


class _NullSocket:
    """전송을 삼키는 가짜 WebSocket. 서비스 로직만 볼 때 쓴다."""

    async def send_bytes(self, _payload: bytes) -> None:
        return None

    async def close(self, code: int = 1000) -> None:
        return None
