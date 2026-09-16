"""Phase 4 msgpack 와이어 공통부 — ``docs/netcode.md`` §5."""

from __future__ import annotations

from enum import IntEnum
from typing import Any

import msgpack


class ErrorCode(IntEnum):
    BAD_MESSAGE = 1000
    ROOM_NOT_FOUND = 1001
    ROOM_FULL = 1002
    TOKEN_INVALID = 1003
    VERSION_MISMATCH = 1004
    NOT_HOST = 1005
    ROOM_STARTED = 1006
    NOT_ACTIVE = 1007
    TURN_MISMATCH = 1008
    BAD_PHASE = 1009
    PURCHASE_REJECTED = 1010
    INTERNAL = 1011


class RoomError(Exception):
    def __init__(self, code: ErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message

    def as_message(self) -> dict[str, object]:
        return {"t": "error", "code": int(self.code), "msg": self.message}


def pack_message(message: dict[str, Any]) -> bytes:
    return msgpack.packb(message, use_bin_type=True, strict_types=True)


def unpack_message(payload: bytes) -> dict[str, Any]:
    try:
        value = msgpack.unpackb(payload, raw=False, strict_map_key=False)
    except (ValueError, msgpack.ExtraData, msgpack.FormatError, msgpack.StackError) as exc:
        raise RoomError(ErrorCode.BAD_MESSAGE, "msgpack 메시지를 해석할 수 없다") from exc
    if not isinstance(value, dict) or not isinstance(value.get("t"), str):
        raise RoomError(ErrorCode.BAD_MESSAGE, "메시지는 문자열 t 필드를 가진 map이어야 한다")
    return value
