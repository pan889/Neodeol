"""코드형 룸, WebSocket 수명주기, 권위 턴 진행."""

from __future__ import annotations

import asyncio
import gzip
import logging
import secrets
import string
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import WebSocket

from talus import constants
from talus.net.protocol import ErrorCode, RoomError, pack_message
from talus.sim import match as Match
from talus.sim import rules as Rules

from .simulation import SimulationPool

LOGGER = logging.getLogger("talus.room")
ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _now_ms() -> int:
    return int(time.time() * 1000)


def _clean_name(name: str) -> str:
    cleaned = " ".join(name.strip().split())
    if not cleaned:
        raise RoomError(ErrorCode.BAD_MESSAGE, "이름이 비어 있다")
    return cleaned[:24]


def _intent_wire(intent: Match.Intent) -> dict[str, object]:
    return {
        "angle10": intent.angle10,
        "power": intent.power,
        "weaponId": intent.weapon_id,
        "moveDx": intent.move_dx,
        "useShield": intent.use_shield,
    }


def _player_wire(player: Match.Player, connected: bool) -> dict[str, object]:
    return {
        "slot": player.slot,
        "name": player.name,
        "x": player.x,
        "y": player.y,
        "hp": player.hp,
        "alive": player.alive,
        "buried": player.buried,
        "angle10": player.angle10,
        "power": player.power,
        "gold": player.gold,
        "weaponId": player.weapon_id,
        "ammo": list(player.ammo),
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
        "connected": connected,
    }


@dataclass
class Seat:
    slot: int
    name: str
    token: str
    host: bool = False
    connected: bool = False
    websocket: WebSocket | None = None
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)
    heartbeat_task: asyncio.Task[None] | None = field(default=None, repr=False)
    last_pong: float = field(default_factory=time.monotonic)
    build_hash: str = ""
    user_agent: str = ""


@dataclass
class Room:
    code: str
    max_players: int
    map_seed: int
    seats: list[Seat]
    status: str = "lobby"
    state: Match.MatchState | None = None
    grid_bytes: bytes | None = None
    checksum: int = 0
    desync_count: int = 0
    resync_count: int = 0
    last_intent: dict[str, object] | None = None
    last_active_slot: int | None = None
    initial_settle: dict[str, object] | None = None
    deadline_ms: int = 0
    playback_waiting: set[int] = field(default_factory=set)
    shop_ready: set[int] = field(default_factory=set)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)
    aim_task: asyncio.Task[None] | None = field(default=None, repr=False)
    playback_task: asyncio.Task[None] | None = field(default=None, repr=False)
    shop_task: asyncio.Task[None] | None = field(default=None, repr=False)
    idle_task: asyncio.Task[None] | None = field(default=None, repr=False)

    def seat_by_token(self, token: str) -> Seat | None:
        return next((seat for seat in self.seats if secrets.compare_digest(seat.token, token)), None)

    def connected_slots(self) -> set[int]:
        return {seat.slot for seat in self.seats if seat.connected and seat.websocket is not None}

    def cancel_tasks(self) -> None:
        """이 룸에 매달린 태스크를 전부 취소한다.

        **룸을 dict 에서 빼는 것만으로는 죽지 않는다.** 페이즈 타이머와 좌석 하트비트는
        각자 `room` 을 클로저로 잡고 있어서, 참조가 남아 GC 대상도 아니고 타이머가 만료되면
        `_resolve_turn_locked` 를 계속 부른다 — 아무도 안 보는 룸이 서버에서 영원히
        시뮬레이션을 돈다. 서버를 오래 띄우면 이게 누적된다.
        """
        for task in (self.aim_task, self.playback_task, self.shop_task, self.idle_task):
            if task is not None and not task.done():
                task.cancel()
        self.aim_task = None
        self.playback_task = None
        self.shop_task = None
        self.idle_task = None
        for seat in self.seats:
            if seat.heartbeat_task is not None and not seat.heartbeat_task.done():
                seat.heartbeat_task.cancel()
            seat.heartbeat_task = None


class RoomManager:
    def __init__(
        self,
        trig_path: Path,
        *,
        sim_workers: int = 2,
        playback_timeout_s: float = 8.0,
        idle_timeout_s: float = 60.0,
        heartbeat_s: float = 10.0,
    ) -> None:
        self._rooms: dict[str, Room] = {}
        self._rooms_lock = asyncio.Lock()
        self._sim = SimulationPool(trig_path, sim_workers)
        self._playback_timeout_s = playback_timeout_s
        self._idle_timeout_s = idle_timeout_s
        self._heartbeat_s = heartbeat_s

    async def close(self) -> None:
        async with self._rooms_lock:
            rooms = list(self._rooms.values())
            self._rooms.clear()
        for room in rooms:
            room.cancel_tasks()
        await self._sim.close()

    async def create_room(self, name: str, max_players: int) -> tuple[Room, Seat]:
        if max_players < 2 or max_players > 6:
            raise RoomError(ErrorCode.BAD_MESSAGE, "정원은 2~6명이어야 한다")
        async with self._rooms_lock:
            code = self._new_code_locked()
            seat = Seat(slot=0, name=_clean_name(name), token=secrets.token_urlsafe(32), host=True)
            room = Room(
                code=code,
                max_players=max_players,
                map_seed=secrets.randbits(32),
                seats=[seat],
            )
            self._rooms[code] = room
            return room, seat

    async def join_room(self, code: str, name: str) -> tuple[Room, Seat]:
        room = await self.get_room(code)
        async with room.lock:
            if room.status != "lobby":
                raise RoomError(ErrorCode.ROOM_STARTED, "이미 시작한 룸이다")
            if len(room.seats) >= room.max_players:
                raise RoomError(ErrorCode.ROOM_FULL, "룸 정원이 가득 찼다")
            seat = Seat(
                slot=len(room.seats),
                name=_clean_name(name),
                token=secrets.token_urlsafe(32),
            )
            room.seats.append(seat)
            await self._broadcast_room_state_locked(room)
            return room, seat

    async def get_room(self, code: str) -> Room:
        normalized = code.strip().upper()
        async with self._rooms_lock:
            room = self._rooms.get(normalized)
        if room is None:
            raise RoomError(ErrorCode.ROOM_NOT_FOUND, "룸을 찾을 수 없다")
        return room

    async def room_summary(self, code: str) -> dict[str, object]:
        room = await self.get_room(code)
        async with room.lock:
            return self._room_state(room)

    async def connect(
        self,
        code: str,
        token: str,
        websocket: WebSocket,
        protocol_version: int,
        rule_hash: str,
        build_hash: str,
    ) -> Seat:
        if protocol_version != constants.PROTOCOL_VERSION:
            raise RoomError(ErrorCode.VERSION_MISMATCH, "프로토콜 버전이 다르다")
        # 클라이언트가 **자기 규칙 표에서 계산한** 지문이다. 예전에는 `GET /version` 으로
        # 받은 `simVersion` 을 되돌려 보냈고, 서버가 그걸 자기 값과 비교했다 —
        # 동어반복이라 원리적으로 불일치가 나지 않았고 규칙이 다른 두 빌드가 같은 방에
        # 들어갔다. `sim/rules.py` 참조.
        if rule_hash != Rules.RULE_HASH:
            raise RoomError(
                ErrorCode.VERSION_MISMATCH,
                f"규칙이 다르다 (클라 {rule_hash} · 서버 {Rules.RULE_HASH})",
            )
        room = await self.get_room(code)
        async with room.lock:
            seat = room.seat_by_token(token)
            if seat is None:
                raise RoomError(ErrorCode.TOKEN_INVALID, "재접속 token이 유효하지 않다")
            old_socket = seat.websocket
            seat.websocket = websocket
            seat.connected = True
            seat.last_pong = time.monotonic()
            seat.build_hash = build_hash
            seat.user_agent = websocket.headers.get("user-agent", "")[:256]
            self._cancel_task(room.idle_task)
            room.idle_task = None
            if old_socket is not None and old_socket is not websocket:
                try:
                    await old_socket.close(code=4001, reason="다른 연결에서 재접속")
                except RuntimeError:
                    pass
            await self._send_locked(
                seat,
                {
                    "t": "hello",
                    "protocolVersion": constants.PROTOCOL_VERSION,
                    "simVersion": constants.SIM_VERSION,
                    "roomCode": room.code,
                    "mySlot": seat.slot,
                    "status": room.status,
                    "buildHash": build_hash,
                },
            )
            await self._broadcast_room_state_locked(room)
            if room.state is not None:
                await self._send_full_state_locked(room, seat)
                if room.status == "aim":
                    await self._send_locked(seat, self._turn_begin_message(room))
            self._cancel_task(seat.heartbeat_task)
            seat.heartbeat_task = asyncio.create_task(self._heartbeat(room, seat, websocket))
            return seat

    async def disconnect(self, code: str, token: str, websocket: WebSocket) -> None:
        try:
            room = await self.get_room(code)
        except RoomError:
            return
        async with room.lock:
            seat = room.seat_by_token(token)
            if seat is None or seat.websocket is not websocket:
                return
            seat.connected = False
            seat.websocket = None
            self._cancel_task(seat.heartbeat_task)
            seat.heartbeat_task = None
            room.playback_waiting.discard(seat.slot)
            if room.status == "playback" and not room.playback_waiting:
                await self._begin_turn_locked(room)
            elif room.status == "shop":
                connected = room.connected_slots()
                if connected and connected.issubset(room.shop_ready):
                    await self._start_next_round_locked(room)
            await self._broadcast_room_state_locked(room)
            if not room.connected_slots() and room.idle_task is None:
                room.idle_task = asyncio.create_task(self._expire_idle_room(room.code))

    async def handle_message(self, room: Room, seat: Seat, message: dict[str, Any]) -> None:
        try:
            message_type = message["t"]
            if message_type == "start":
                await self.start_match(room, seat)
            elif message_type == "intent":
                await self.submit_intent(room, seat, message)
            elif message_type == "playbackDone":
                await self.playback_done(room, seat, message)
            elif message_type == "buy":
                await self.buy(room, seat, message)
            elif message_type == "shopReady":
                await self.shop_ready(room, seat, message)
            elif message_type == "resyncReq":
                async with room.lock:
                    room.resync_count += 1
                    LOGGER.warning(
                        "resync room=%s mapSeed=%s turn=%s slot=%s client=%s server=%08X "
                        "build=%s userAgent=%s",
                        room.code,
                        room.map_seed,
                        message.get("turnNo"),
                        seat.slot,
                        message.get("myChecksum"),
                        room.checksum,
                        seat.build_hash,
                        seat.user_agent,
                    )
                    await self._send_full_state_locked(room, seat)
                    if room.status == "aim":
                        await self._send_locked(seat, self._turn_begin_message(room))
            elif message_type == "pong":
                seat.last_pong = time.monotonic()
            else:
                raise RoomError(ErrorCode.BAD_MESSAGE, f"알 수 없는 메시지: {message_type}")
        except RoomError as exc:
            await self.send_error(seat, exc)
        except Exception:
            LOGGER.exception("room message failed code=%s slot=%s type=%s", room.code, seat.slot, message.get("t"))
            await self.send_error(seat, RoomError(ErrorCode.INTERNAL, "서버 내부 오류"))

    async def start_match(self, room: Room, seat: Seat) -> None:
        async with room.lock:
            if not seat.host:
                raise RoomError(ErrorCode.NOT_HOST, "호스트만 매치를 시작할 수 있다")
            if room.status != "lobby":
                raise RoomError(ErrorCode.ROOM_STARTED, "이미 시작한 룸이다")
            if len(room.seats) < 2:
                raise RoomError(ErrorCode.BAD_PHASE, "최소 2명이 필요하다")
            room.status = "starting"
            await self._broadcast_room_state_locked(room)
            specs = [(candidate.name, False) for candidate in room.seats]
            try:
                state, grid_bytes, initial_settle, checksum = await self._sim.create_match(
                    room.map_seed,
                    specs,
                )
            except Exception:
                room.status = "lobby"
                await self._broadcast_room_state_locked(room)
                raise
            room.state = state
            room.grid_bytes = grid_bytes
            room.initial_settle = initial_settle
            room.checksum = checksum
            for candidate in room.seats:
                await self._send_locked(candidate, self._match_init_message(room, candidate.slot))
                await self._send_full_state_locked(room, candidate)
            await self._begin_turn_locked(room)

    async def submit_intent(self, room: Room, seat: Seat, message: dict[str, Any]) -> None:
        async with room.lock:
            state = self._require_state(room)
            if room.status != "aim":
                raise RoomError(ErrorCode.BAD_PHASE, "현재 조준 페이즈가 아니다")
            expected_turn = state.turn_no + 1
            if type(message.get("turnNo")) is not int or message["turnNo"] != expected_turn:
                raise RoomError(ErrorCode.TURN_MISMATCH, "현재 turnNo와 다르다")
            active_slot = message.get("activeSlot")
            if (
                seat.slot != state.active_slot
                or type(active_slot) is not int
                or active_slot != state.active_slot
            ):
                raise RoomError(ErrorCode.NOT_ACTIVE, "현재 활성 슬롯이 아니다")
            candidate = Match.Intent(
                angle10=message.get("angle10"),
                power=message.get("power"),
                weapon_id=message.get("weaponId"),
                move_dx=message.get("moveDx"),
                use_shield=message.get("useShield"),
            )
            await self._resolve_turn_locked(room, candidate)

    async def playback_done(self, room: Room, seat: Seat, message: dict[str, Any]) -> None:
        async with room.lock:
            state = self._require_state(room)
            if room.status != "playback":
                raise RoomError(ErrorCode.BAD_PHASE, "재생 대기 중이 아니다")
            if message.get("turnNo") != state.turn_no:
                raise RoomError(ErrorCode.TURN_MISMATCH, "재생 완료 turnNo가 다르다")
            client_checksum = message.get("checksum")
            if type(client_checksum) is not int:
                raise RoomError(ErrorCode.BAD_MESSAGE, "checksum은 정수여야 한다")
            if client_checksum != room.checksum:
                room.desync_count += 1
                room.resync_count += 1
                LOGGER.error(
                    "desync room=%s mapSeed=%s turn=%s activeSlot=%s intent=%s slot=%s "
                    "client=%08X server=%08X build=%s userAgent=%s",
                    room.code,
                    state.map_seed,
                    state.turn_no,
                    room.last_active_slot,
                    room.last_intent,
                    seat.slot,
                    client_checksum,
                    room.checksum,
                    seat.build_hash,
                    seat.user_agent,
                )
                await self._send_locked(
                    seat,
                    {
                        "t": "desync",
                        "turnNo": state.turn_no,
                        "clientChecksum": client_checksum,
                        "serverChecksum": room.checksum,
                    },
                )
                await self._send_full_state_locked(room, seat)
            room.playback_waiting.discard(seat.slot)
            if not room.playback_waiting:
                await self._begin_turn_locked(room)

    async def buy(self, room: Room, seat: Seat, message: dict[str, Any]) -> None:
        async with room.lock:
            state = self._require_state(room)
            if room.status != "shop" or message.get("roundNo") != state.round_no:
                raise RoomError(ErrorCode.BAD_PHASE, "현재 상점 페이즈가 아니다")
            player = state.players[seat.slot]
            kind = message.get("kind")
            if kind == "weapon" and type(message.get("weaponId")) is int:
                ok = Match.buy_weapon(player, message["weaponId"])
            elif kind == "item" and isinstance(message.get("itemKey"), str):
                ok = Match.buy_item(player, message["itemKey"])
            else:
                raise RoomError(ErrorCode.BAD_MESSAGE, "구매 대상 형식이 잘못됐다")
            await self._broadcast_locked(
                room,
                {
                    "t": "buyResult",
                    "ok": ok,
                    "slot": seat.slot,
                    "player": _player_wire(player, seat.connected),
                },
            )

    async def shop_ready(self, room: Room, seat: Seat, message: dict[str, Any]) -> None:
        async with room.lock:
            state = self._require_state(room)
            if room.status != "shop" or message.get("roundNo") != state.round_no:
                raise RoomError(ErrorCode.BAD_PHASE, "현재 상점 페이즈가 아니다")
            room.shop_ready.add(seat.slot)
            connected = room.connected_slots()
            if connected.issubset(room.shop_ready):
                await self._start_next_round_locked(room)

    async def send_error(self, seat: Seat, error: RoomError) -> None:
        try:
            await self._send_locked(seat, error.as_message())
        except Exception:
            pass

    async def _resolve_turn_locked(self, room: Room, candidate: Match.Intent | None) -> None:
        state = self._require_state(room)
        grid_bytes = self._require_grid(room)
        active_player = state.players[state.active_slot]
        normalized = Match.normalize_intent(active_player, candidate)
        intent = _intent_wire(normalized)
        room.last_intent = intent
        room.last_active_slot = state.active_slot
        turn_no = state.turn_no + 1
        self._cancel_task(room.aim_task)
        room.aim_task = None
        room.status = "resolving"
        await self._broadcast_locked(
            room,
            {
                "t": "turnResolve",
                "turnNo": turn_no,
                "activeSlot": state.active_slot,
                "turnSeed": Match.derive_turn_seed(state.map_seed, turn_no),
                "intent": intent,
            },
        )
        try:
            state, grid_bytes, result = await self._sim.resolve_turn(state, grid_bytes, intent)
        except Exception:
            await self._begin_turn_locked(room)
            raise
        room.state = state
        room.grid_bytes = grid_bytes
        room.checksum = result["checksum"]
        await self._broadcast_locked(
            room,
            {
                "t": "turnResult",
                **result,
                "players": self._players_wire(room),
                "phase": state.phase,
                "nextActiveSlot": state.active_slot if state.phase == "aim" else None,
            },
        )
        if state.phase == "aim":
            room.status = "playback"
            room.playback_waiting = room.connected_slots()
            if room.playback_waiting:
                room.playback_task = asyncio.create_task(self._playback_timeout(room, state.turn_no))
            else:
                await self._begin_turn_locked(room)
        elif state.phase == "shop":
            room.status = "shop"
            room.shop_ready.clear()
            await self._broadcast_locked(
                room,
                {
                    "t": "roundEnd",
                    "roundNo": state.round_no,
                    "scores": [
                        {"slot": player.slot, "score": player.score, "gold": player.gold}
                        for player in state.players
                    ],
                    "shopOpenMs": 30000,
                },
            )
            room.shop_task = asyncio.create_task(self._shop_timeout(room, state.round_no))
        else:
            room.status = "done"
            await self._broadcast_locked(
                room,
                {
                    "t": "matchEnd",
                    "finalScores": [
                        {"slot": player.slot, "score": player.score, "gold": player.gold}
                        for player in state.players
                    ],
                    "winners": Match.match_leaders(state.players),
                },
            )

    async def _begin_turn_locked(self, room: Room) -> None:
        state = self._require_state(room)
        if state.phase != "aim":
            return
        self._cancel_task(room.playback_task)
        room.playback_task = None
        room.playback_waiting.clear()
        room.status = "aim"
        seconds = constants.AIM_SECONDS_FIRST_TURN if state.round_turn == 0 else constants.AIM_SECONDS
        room.deadline_ms = _now_ms() + seconds * 1000
        await self._broadcast_locked(room, self._turn_begin_message(room))
        room.aim_task = asyncio.create_task(
            self._aim_timeout(room, state.turn_no + 1, state.active_slot, seconds)
        )

    async def _start_next_round_locked(self, room: Room) -> None:
        state = self._require_state(room)
        grid_bytes = self._require_grid(room)
        self._cancel_task(room.shop_task)
        room.shop_task = None
        state, grid_bytes, checksum = await self._sim.start_next_round(state, grid_bytes)
        room.state = state
        room.grid_bytes = grid_bytes
        room.checksum = checksum
        room.shop_ready.clear()
        await self._broadcast_locked(
            room,
            {
                "t": "roundStart",
                "roundNo": state.round_no,
                "wind": state.wind,
                "spawnCells": list(state.spawn_cells),
                "players": self._players_wire(room),
            },
        )
        await self._begin_turn_locked(room)

    async def _aim_timeout(self, room: Room, turn_no: int, active_slot: int, seconds: int) -> None:
        try:
            await asyncio.sleep(seconds)
            async with room.lock:
                state = self._require_state(room)
                if room.status == "aim" and state.turn_no + 1 == turn_no and state.active_slot == active_slot:
                    await self._resolve_turn_locked(room, None)
        except asyncio.CancelledError:
            return

    async def _playback_timeout(self, room: Room, turn_no: int) -> None:
        try:
            await asyncio.sleep(self._playback_timeout_s)
            async with room.lock:
                state = self._require_state(room)
                if room.status == "playback" and state.turn_no == turn_no:
                    await self._begin_turn_locked(room)
        except asyncio.CancelledError:
            return

    async def _shop_timeout(self, room: Room, round_no: int) -> None:
        try:
            await asyncio.sleep(30)
            async with room.lock:
                state = self._require_state(room)
                if room.status == "shop" and state.round_no == round_no:
                    await self._start_next_round_locked(room)
        except asyncio.CancelledError:
            return

    async def _heartbeat(self, room: Room, seat: Seat, websocket: WebSocket) -> None:
        try:
            while seat.websocket is websocket:
                await asyncio.sleep(self._heartbeat_s)
                if time.monotonic() - seat.last_pong > self._heartbeat_s * 3:
                    await websocket.close(code=4000, reason="heartbeat timeout")
                    return
                await self._send_locked(seat, {"t": "ping", "t0": _now_ms()})
        except (asyncio.CancelledError, RuntimeError):
            return

    async def _expire_idle_room(self, code: str) -> None:
        try:
            await asyncio.sleep(self._idle_timeout_s)
            room = await self.get_room(code)
            async with room.lock:
                if room.connected_slots():
                    room.idle_task = None
                    return
                async with self._rooms_lock:
                    if self._rooms.get(code) is room and not room.connected_slots():
                        self._rooms.pop(code, None)
                        # dict 에서 빼는 것만으로는 태스크가 안 죽는다 (`cancel_tasks` 주석)
                        room.idle_task = None  # 지금 실행 중인 자기 자신은 취소하지 않는다
                        room.cancel_tasks()
        except (asyncio.CancelledError, RoomError):
            return

    async def _send_full_state_locked(self, room: Room, seat: Seat) -> None:
        state = self._require_state(room)
        grid_bytes = self._require_grid(room)
        await self._send_locked(
            seat,
            {
                "t": "fullState",
                "roomCode": room.code,
                "mySlot": seat.slot,
                "status": room.status,
                "state": self._state_wire(room, state),
                "checksum": room.checksum,
                "gridGzip": gzip.compress(grid_bytes, compresslevel=1),
            },
        )

    async def _broadcast_room_state_locked(self, room: Room) -> None:
        await self._broadcast_locked(room, self._room_state(room))

    async def _broadcast_locked(self, room: Room, message: dict[str, Any]) -> None:
        targets = [seat for seat in room.seats if seat.connected and seat.websocket is not None]
        if not targets:
            return
        results = await asyncio.gather(
            *(self._send_locked(seat, message) for seat in targets),
            return_exceptions=True,
        )
        for seat, result in zip(targets, results, strict=True):
            if isinstance(result, Exception):
                seat.connected = False
                seat.websocket = None

    async def _send_locked(self, seat: Seat, message: dict[str, Any]) -> None:
        websocket = seat.websocket
        if websocket is None:
            return
        payload = pack_message(message)
        async with seat.send_lock:
            await websocket.send_bytes(payload)

    def _room_state(self, room: Room) -> dict[str, object]:
        return {
            "t": "roomState",
            "roomCode": room.code,
            "status": room.status,
            "maxPlayers": room.max_players,
            "telemetry": {
                "turns": room.state.turn_no if room.state is not None else 0,
                "desyncs": room.desync_count,
                "resyncs": room.resync_count,
            },
            "players": [
                {
                    "slot": seat.slot,
                    "name": seat.name,
                    "connected": seat.connected,
                    "host": seat.host,
                }
                for seat in room.seats
            ],
        }

    def _match_init_message(self, room: Room, my_slot: int) -> dict[str, object]:
        state = self._require_state(room)
        return {
            "t": "matchInit",
            "mapSeed": state.map_seed,
            "mySlot": my_slot,
            "players": self._players_wire(room),
            "rules": {
                "rounds": Match.RULES.rounds,
                "roundTurnCap": Match.RULES.round_turn_cap,
                "playerCount": len(state.players),
                "mode": "ffa",
            },
            "initialSettle": room.initial_settle,
            "checksum": room.checksum,
        }

    def _turn_begin_message(self, room: Room) -> dict[str, object]:
        state = self._require_state(room)
        return {
            "t": "turnBegin",
            "turnNo": state.turn_no + 1,
            "roundNo": state.round_no,
            "roundTurn": state.round_turn + 1,
            "activeSlot": state.active_slot,
            "deadlineMs": room.deadline_ms,
            "wind": state.wind,
        }

    def _state_wire(self, room: Room, state: Match.MatchState) -> dict[str, object]:
        return {
            "mapSeed": state.map_seed,
            "roundNo": state.round_no,
            "turnNo": state.turn_no,
            "roundTurn": state.round_turn,
            "activeSlot": state.active_slot,
            "wind": state.wind,
            "spawnCells": list(state.spawn_cells),
            "players": self._players_wire(room),
            "phase": state.phase,
            "over": state.over,
        }

    def _players_wire(self, room: Room) -> list[dict[str, object]]:
        state = self._require_state(room)
        connected = {seat.slot: seat.connected for seat in room.seats}
        return [_player_wire(player, connected.get(player.slot, False)) for player in state.players]

    @staticmethod
    def _require_state(room: Room) -> Match.MatchState:
        if room.state is None:
            raise RoomError(ErrorCode.BAD_PHASE, "매치가 시작되지 않았다")
        return room.state

    @staticmethod
    def _require_grid(room: Room) -> bytes:
        if room.grid_bytes is None:
            raise RoomError(ErrorCode.BAD_PHASE, "매치 격자가 없다")
        return room.grid_bytes

    @staticmethod
    def _cancel_task(task: asyncio.Task[Any] | None) -> None:
        if task is not None and task is not asyncio.current_task() and not task.done():
            task.cancel()

    def _new_code_locked(self) -> str:
        while True:
            code = "".join(secrets.choice(ROOM_ALPHABET) for _ in range(6))
            if code not in self._rooms:
                return code
