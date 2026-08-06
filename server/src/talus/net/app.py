"""FastAPI 앱 — 개발용 최소 표면.

지금(Phase 0) 이 앱이 하는 일은 셋뿐이다.

  1. Phase 0 샌드박스를 `/sandbox/` 로 서빙한다. 빌드 도구 없이 브라우저에서
     바로 열리는 단일 HTML 이라 정적 서빙만으로 충분하다.
  2. `/healthz` (liveness) 와 `/readyz` (Redis·PostgreSQL 연결) 를 제공한다.
  3. `/version` 으로 `SIM_VERSION` 을 노출한다. 클라이언트가 접속할 때 이 값을
     대조해 서로 다른 규칙으로 계산하고 있지 않은지 확인한다 (docs/netcode.md).

**WebSocket 과 룸 로직은 여기 없다.** `docs/roadmap.md` Phase 4 이며, 그 전에
`sim/` 이 골든 리플레이로 검증되어야 한다. 순서를 뒤집으면 "가끔 지형이 다르게
보임" 류의 재현 불가능한 버그를 만들게 된다 (roadmap Phase 3 경고).
"""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from talus import __version__, constants
from talus.store import check_postgres, check_redis

BOOT_TIME = time.time()

REDIS_URL = os.environ.get("TALUS_REDIS_URL", "redis://127.0.0.1:6379/0")
PG_DSN = os.environ.get("TALUS_PG_DSN", "postgresql://talus:talus@127.0.0.1:5432/talus")
STATIC_DIR = Path(os.environ.get("TALUS_STATIC_DIR", "tools"))
ENV = os.environ.get("TALUS_ENV", "dev")

app = FastAPI(
    title="Talus",
    version=__version__,
    description="턴제 포병 대전 게임 서버 (개발 스캐폴드)",
    docs_url="/docs-api",
    redoc_url=None,
)


# ── 헬스 ────────────────────────────────────────────────────────────────
@app.get("/healthz", tags=["health"])
async def healthz() -> dict[str, Any]:
    """Liveness. 의존성을 건드리지 않는다.

    컨테이너 재시작 판단에 쓰이므로 Redis 가 죽었다고 서버를 죽여선 안 된다.
    의존성 상태는 `/readyz` 가 본다.
    """
    return {
        "ok": True,
        "env": ENV,
        "version": __version__,
        "uptime_s": round(time.time() - BOOT_TIME, 1),
    }


@app.get("/readyz", tags=["health"])
async def readyz() -> JSONResponse:
    """Readiness. Redis 와 PostgreSQL 을 병렬로 확인한다."""
    redis_status, pg_status = await asyncio.gather(
        check_redis(REDIS_URL),
        check_postgres(PG_DSN),
    )
    deps = [redis_status, pg_status]
    ok = all(d.ok for d in deps)
    return JSONResponse(
        status_code=200 if ok else 503,
        content={"ok": ok, "deps": [d.as_dict() for d in deps]},
    )


@app.get("/version", tags=["health"])
async def version() -> dict[str, Any]:
    """시뮬레이션 규칙 신원.

    `sim_version` 은 `talus.constants` 전체의 해시다. 클라이언트가 접속할 때
    이 값이 다르면 두 쪽이 다른 규칙으로 계산하고 있다는 뜻이므로 같은 방에
    넣어서는 안 된다. `provisional` 이 비어 있지 않으면 아직 밸런싱 기준선이
    확정되지 않은 상태다.
    """
    return {
        "app_version": __version__,
        "protocol_version": constants.PROTOCOL_VERSION,
        "sim_version": constants.SIM_VERSION,
        "provisional": sorted(constants.PROVISIONAL),
        "grid": {"w": constants.GRID_W, "h": constants.GRID_H, "cell_px": constants.CELL_PX},
    }


@app.get("/constants", tags=["health"])
async def constants_dump() -> dict[str, Any]:
    """`SIM_VERSION` 계산에 들어간 상수 전체. 클라이언트와 눈으로 대조할 때 쓴다."""
    return {"sim_version": constants.SIM_VERSION, "constants": constants.constants_snapshot()}


@app.get("/deps", tags=["health"])
async def deps() -> dict[str, Any]:
    """수치 연산 스택 확인. numpy 가 없으면 자동자를 벡터화할 수 없다."""
    out: dict[str, Any] = {}
    for mod in ("numpy", "msgpack", "fastapi", "uvicorn", "redis", "asyncpg"):
        try:
            m = __import__(mod)
            out[mod] = getattr(m, "__version__", "?")
        except Exception as exc:  # noqa: BLE001
            out[mod] = f"MISSING ({type(exc).__name__})"
    return out


# ── 루트 ────────────────────────────────────────────────────────────────
@app.get("/", response_class=HTMLResponse, tags=["dev"])
async def index() -> str:
    sandbox = "/sandbox/" if (STATIC_DIR / "sandbox" / "index.html").is_file() else None
    link = (
        f'<li><a href="{sandbox}">Phase 0 — 모래 자동자 샌드박스</a></li>'
        if sandbox
        else "<li><em>샌드박스를 찾을 수 없다 (TALUS_STATIC_DIR 확인)</em></li>"
    )
    return f"""<!doctype html><meta charset=utf-8><title>Talus dev</title>
<style>
 body{{background:#120F17;color:#E8DFD2;font:14px/1.7 ui-sans-serif,system-ui;padding:40px;max-width:640px}}
 h1{{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#3DDCFF}}
 a{{color:#D99A5B}} code{{color:#B4FF3D}} ul{{padding-left:20px}}
 .dim{{color:#6E6478;font-size:12px}}
</style>
<h1>Talus — dev server</h1>
<p class=dim>env <code>{ENV}</code> · app <code>{__version__}</code> · sim <code>{constants.SIM_VERSION}</code></p>
<ul>
{link}
<li><a href="/readyz">/readyz</a> — Redis · PostgreSQL 연결</li>
<li><a href="/version">/version</a> — 시뮬레이션 규칙 신원</li>
<li><a href="/constants">/constants</a> — 상수 전체</li>
<li><a href="/deps">/deps</a> — 라이브러리 버전</li>
<li><a href="/docs-api">/docs-api</a> — OpenAPI</li>
</ul>
<p class=dim>WebSocket 과 룸 로직은 Phase 4다. docs/roadmap.md 참조.</p>
"""


# ── 정적 서빙 ───────────────────────────────────────────────────────────
# "/" 에 마운트하면 위의 라우트를 가릴 위험이 있으므로 명시적 경로만 올린다.
if (STATIC_DIR / "sandbox").is_dir():
    app.mount(
        "/sandbox",
        StaticFiles(directory=STATIC_DIR / "sandbox", html=True),
        name="sandbox",
    )
# Phase 1 의 tools/prototype/ 이 생기면 /tools/prototype/ 으로 자동 노출된다.
if STATIC_DIR.is_dir():
    app.mount("/tools", StaticFiles(directory=STATIC_DIR, html=True), name="tools")
