"""코드형 로비 REST와 msgpack WebSocket 라우트."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Body, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from talus import constants
from talus.net.protocol import ErrorCode, RoomError, pack_message, unpack_message
from talus.room.service import Room, RoomManager, Seat

router = APIRouter()


class CreateRoomRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    max_players: int = Field(default=4, alias="maxPlayers", ge=2, le=6)

    model_config = {"populate_by_name": True}


class JoinRoomRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)


class StartRoomRequest(BaseModel):
    token: str = Field(min_length=16)


def _manager(scope: Request | WebSocket) -> RoomManager:
    manager = getattr(scope.app.state, "room_manager", None)
    if manager is None:
        raise RuntimeError("room manager lifespan is not running")
    return manager


def _http_error(error: RoomError) -> HTTPException:
    status = {
        ErrorCode.ROOM_NOT_FOUND: 404,
        ErrorCode.ROOM_FULL: 409,
        ErrorCode.ROOM_STARTED: 409,
        ErrorCode.TOKEN_INVALID: 403,
        ErrorCode.NOT_HOST: 403,
    }.get(error.code, 400)
    return HTTPException(status_code=status, detail={"code": int(error.code), "msg": error.message})


def _join_response(room: Room, seat: Seat) -> dict[str, object]:
    return {
        "roomCode": room.code,
        "token": seat.token,
        "slot": seat.slot,
        "protocolVersion": constants.PROTOCOL_VERSION,
        "simVersion": constants.SIM_VERSION,
        "wsPath": f"/ws/rooms/{room.code}",
    }


@router.post("/api/rooms", tags=["multiplayer"])
async def create_room(request: Request, body: CreateRoomRequest) -> dict[str, object]:
    try:
        room, seat = await _manager(request).create_room(body.name, body.max_players)
    except RoomError as exc:
        raise _http_error(exc) from exc
    return _join_response(room, seat)


@router.post("/api/rooms/{code}/join", tags=["multiplayer"])
async def join_room(request: Request, code: str, body: JoinRoomRequest) -> dict[str, object]:
    try:
        room, seat = await _manager(request).join_room(code, body.name)
    except RoomError as exc:
        raise _http_error(exc) from exc
    return _join_response(room, seat)


@router.get("/api/rooms/{code}", tags=["multiplayer"])
async def room_state(request: Request, code: str) -> dict[str, object]:
    try:
        return await _manager(request).room_summary(code)
    except RoomError as exc:
        raise _http_error(exc) from exc


@router.post("/api/rooms/{code}/start", tags=["multiplayer"])
async def start_room(
    request: Request,
    code: str,
    body: Annotated[StartRoomRequest, Body()],
) -> dict[str, object]:
    manager = _manager(request)
    try:
        room = await manager.get_room(code)
        async with room.lock:
            seat = room.seat_by_token(body.token)
            if seat is None:
                raise RoomError(ErrorCode.TOKEN_INVALID, "token이 유효하지 않다")
        await manager.start_match(room, seat)
        return {"ok": True, "roomCode": room.code}
    except RoomError as exc:
        raise _http_error(exc) from exc


@router.websocket("/ws/rooms/{code}")
async def room_socket(
    websocket: WebSocket,
    code: str,
    token: str = Query(...),
    protocol_version: int = Query(..., alias="protocolVersion"),
    sim_version: str = Query(..., alias="simVersion"),
    build_hash: str = Query("dev", alias="buildHash"),
) -> None:
    await websocket.accept()
    manager = _manager(websocket)
    try:
        seat = await manager.connect(
            code,
            token,
            websocket,
            protocol_version,
            sim_version,
            build_hash[:64],
        )
        room = await manager.get_room(code)
    except RoomError as exc:
        await websocket.send_bytes(pack_message(exc.as_message()))
        await websocket.close(code=4400 + int(exc.code) - 1000)
        return

    try:
        while True:
            frame = await websocket.receive()
            if frame.get("type") == "websocket.disconnect":
                break
            payload = frame.get("bytes")
            if payload is None:
                await manager.send_error(
                    seat,
                    RoomError(ErrorCode.BAD_MESSAGE, "binary msgpack 프레임만 허용한다"),
                )
                continue
            try:
                message: dict[str, Any] = unpack_message(payload)
            except RoomError as exc:
                await manager.send_error(seat, exc)
                continue
            await manager.handle_message(room, seat, message)
    except WebSocketDisconnect:
        pass
    finally:
        await manager.disconnect(code, token, websocket)
