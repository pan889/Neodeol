"""의존 서비스 연결 확인.

`/readyz` 가 이걸 호출한다. 실패를 예외로 던지지 않고 구조체로 돌려주는 이유:
헬스체크는 어느 의존성이 어떻게 죽었는지를 **전부** 보고해야 유용하다.
첫 실패에서 예외를 던지면 두 번째 의존성 상태를 알 수 없다.
"""

from __future__ import annotations

import time
from dataclasses import dataclass


@dataclass(slots=True)
class DepStatus:
    name: str
    ok: bool
    latency_ms: float | None = None
    detail: str = ""

    def as_dict(self) -> dict[str, object]:
        d: dict[str, object] = {"name": self.name, "ok": self.ok}
        if self.latency_ms is not None:
            d["latency_ms"] = round(self.latency_ms, 2)
        if self.detail:
            d["detail"] = self.detail
        return d


async def check_redis(url: str, timeout: float = 3.0) -> DepStatus:
    t0 = time.perf_counter()
    try:
        import redis.asyncio as aioredis

        client = aioredis.from_url(url, socket_connect_timeout=timeout, socket_timeout=timeout)
        try:
            await client.ping()
        finally:
            await client.aclose()
    except Exception as exc:  # noqa: BLE001 — 헬스체크는 모든 실패를 보고한다
        return DepStatus("redis", False, detail=f"{type(exc).__name__}: {exc}")
    return DepStatus("redis", True, (time.perf_counter() - t0) * 1000.0)


async def check_postgres(dsn: str, timeout: float = 3.0) -> DepStatus:
    t0 = time.perf_counter()
    try:
        import asyncpg

        conn = await asyncpg.connect(dsn, timeout=timeout)
        try:
            await conn.fetchval("SELECT 1")
        finally:
            await conn.close()
    except Exception as exc:  # noqa: BLE001
        return DepStatus("postgres", False, detail=f"{type(exc).__name__}: {exc}")
    return DepStatus("postgres", True, (time.perf_counter() - t0) * 1000.0)
