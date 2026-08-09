"""Phase 4 코드형 룸과 msgpack WebSocket 통합 검증."""

from __future__ import annotations

import gzip
from urllib.parse import urlencode

from fastapi.testclient import TestClient

from talus import constants
from talus.net.app import app
from talus.net.protocol import ErrorCode, pack_message, unpack_message
from talus.sim.intmath import fnv1a32


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
