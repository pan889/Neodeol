#!/usr/bin/env python3
"""실행 중인 Docker 서버에 실제 2인 WebSocket 턴을 흘린다."""

from __future__ import annotations

import asyncio
import json
import os
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

import msgpack
import websockets

HTTP_BASE = os.environ.get("TALUS_SMOKE_BASE", "http://127.0.0.1:8000").rstrip("/")
parsed_base = urlparse(HTTP_BASE)
WS_BASE = f"{'wss' if parsed_base.scheme == 'https' else 'ws'}://{parsed_base.netloc}"


def post(path: str, payload: dict[str, object]) -> dict[str, object]:
    request = Request(
        f"{HTTP_BASE}{path}",
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=15) as response:
        return json.load(response)


def socket_url(session: dict[str, object]) -> str:
    query = urlencode(
        {
            "token": session["token"],
            "protocolVersion": session["protocolVersion"],
            "ruleHash": session["ruleHash"],
            "buildHash": "docker-smoke",
        }
    )
    return f"{WS_BASE}{session['wsPath']}?{query}"


async def send(socket: object, message: dict[str, object]) -> None:
    await socket.send(msgpack.packb(message, use_bin_type=True))


async def receive_type(socket: object, expected: str, limit: int = 12) -> dict[str, object]:
    seen: list[str] = []
    for _ in range(limit):
        frame = await asyncio.wait_for(socket.recv(), timeout=30)
        if not isinstance(frame, bytes):
            raise RuntimeError("서버가 text WebSocket 프레임을 보냈다")
        message = msgpack.unpackb(frame, raw=False)
        seen.append(message.get("t", "?"))
        if message.get("t") == expected:
            return message
    raise RuntimeError(f"{expected} 메시지를 받지 못했다: {seen}")


async def receive_connected(socket: object, count: int) -> None:
    for _ in range(8):
        message = await receive_type(socket, "roomState")
        if sum(1 for player in message["players"] if player["connected"]) == count:
            return
    raise RuntimeError(f"connected={count} roomState를 받지 못했다")


async def main() -> None:
    host = post("/api/rooms", {"name": "smoke-alpha", "maxPlayers": 2})
    code = host["roomCode"]
    guest = post(f"/api/rooms/{code}/join", {"name": "smoke-bravo"})

    async with websockets.connect(socket_url(host), max_size=2**22) as host_socket:
        await receive_type(host_socket, "hello")
        await receive_connected(host_socket, 1)
        async with websockets.connect(socket_url(guest), max_size=2**22) as guest_socket:
            await receive_type(guest_socket, "hello")
            await receive_connected(host_socket, 2)
            await receive_connected(guest_socket, 2)

            await send(host_socket, {"t": "start"})
            await receive_type(host_socket, "matchInit")
            await receive_type(guest_socket, "matchInit")
            host_turn = await receive_type(host_socket, "turnBegin")
            guest_turn = await receive_type(guest_socket, "turnBegin")
            if host_turn != guest_turn or host_turn["activeSlot"] != 0:
                raise RuntimeError("첫 턴 브로드캐스트가 일치하지 않는다")

            await send(
                host_socket,
                {
                    "t": "intent",
                    "turnNo": host_turn["turnNo"],
                    "activeSlot": host_turn["activeSlot"],
                    "angle10": 450,
                    "power": 520,
                    "weaponId": 0,
                    "moveDx": 0,
                    "useShield": False,
                },
            )
            await receive_type(host_socket, "turnResolve")
            await receive_type(guest_socket, "turnResolve")
            host_result = await receive_type(host_socket, "turnResult")
            guest_result = await receive_type(guest_socket, "turnResult")
            if host_result["checksum"] != guest_result["checksum"]:
                raise RuntimeError("턴 결과 체크섬이 클라이언트별로 다르다")

            done = {
                "t": "playbackDone",
                "turnNo": host_result["turnNo"],
                "checksum": host_result["checksum"],
            }
            await send(host_socket, done)
            await send(guest_socket, done)
            next_host = await receive_type(host_socket, "turnBegin")
            next_guest = await receive_type(guest_socket, "turnBegin")
            if next_host != next_guest or next_host["activeSlot"] != 1:
                raise RuntimeError("두 번째 턴 전환이 일치하지 않는다")

    print(f"multiplayer smoke ok room={code} turn={next_host['turnNo']}")


if __name__ == "__main__":
    asyncio.run(main())
