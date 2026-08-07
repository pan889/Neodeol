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
        "simVersion": session["simVersion"],
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
            assert error == {
                "t": "error",
                "code": ErrorCode.VERSION_MISMATCH,
                "msg": "프로토콜 또는 시뮬레이션 버전이 다르다",
            }


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

