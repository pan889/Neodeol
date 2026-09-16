"""FastAPI 앱 — 개발 도구, 헬스체크, Phase 4 코드형 룸 서버."""

from __future__ import annotations

import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from neodeol import __version__, constants
from neodeol.net.multiplayer import router as multiplayer_router
from neodeol.room import RoomManager
from neodeol.sim import rules as Rules
from neodeol.store import check_postgres, check_redis

BOOT_TIME = time.time()

REDIS_URL = os.environ.get("NEODEOL_REDIS_URL", "redis://127.0.0.1:6379/0")
PG_DSN = os.environ.get("NEODEOL_PG_DSN", "postgresql://neodeol:neodeol@127.0.0.1:5432/neodeol")
STATIC_DIR = Path(os.environ.get("NEODEOL_STATIC_DIR", "tools"))
ENV = os.environ.get("NEODEOL_ENV", "dev")
SIM_WORKERS = int(os.environ.get("NEODEOL_SIM_WORKERS", "2"))


def _find_trig_table() -> Path:
    configured = os.environ.get("NEODEOL_TRIG_TABLE")
    candidates = [
        Path(configured) if configured else None,
        Path.cwd() / "tables" / "trig.bin",
        Path.cwd().parent / "tables" / "trig.bin",
        Path(__file__).resolve().parents[3] / "tables" / "trig.bin",
        Path(__file__).resolve().parents[4] / "tables" / "trig.bin",
    ]
    for candidate in candidates:
        if candidate is not None and candidate.is_file():
            return candidate
    raise RuntimeError("tables/trig.bin 을 찾을 수 없다")


@asynccontextmanager
async def lifespan(application: FastAPI):
    manager = RoomManager(_find_trig_table(), sim_workers=SIM_WORKERS)
    application.state.room_manager = manager
    try:
        yield
    finally:
        await manager.close()

app = FastAPI(
    title="Neodeol",
    version=__version__,
    description="턴제 포병 대전 게임 서버 (개발 스캐폴드)",
    docs_url="/docs-api",
    redoc_url=None,
    lifespan=lifespan,
)
app.include_router(multiplayer_router)


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

    `sim_version` 은 `neodeol.constants` 전체의 해시다. 클라이언트가 접속할 때
    이 값이 다르면 두 쪽이 다른 규칙으로 계산하고 있다는 뜻이므로 같은 방에
    넣어서는 안 된다. `provisional` 이 비어 있지 않으면 아직 밸런싱 기준선이
    확정되지 않은 상태다.
    """
    return {
        "app_version": __version__,
        "protocol_version": constants.PROTOCOL_VERSION,
        "sim_version": constants.SIM_VERSION,
        "rule_hash": Rules.RULE_HASH,
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


@app.get("/tables/trig.bin", response_class=FileResponse, tags=["dev"])
async def trig_table() -> FileResponse:
    """브라우저 lockstep 클라이언트가 서버와 같은 Q12 삼각함수 표를 받는다."""
    return FileResponse(_find_trig_table(), media_type="application/octet-stream")


# ── 루트 ────────────────────────────────────────────────────────────────
@app.middleware("http")
async def revalidate_tool_assets(request: Request, call_next: Any) -> Any:
    response = await call_next(request)
    if request.url.path.startswith("/tools/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


def game_document(name: str) -> HTMLResponse:
    path = STATIC_DIR / name / "index.html"
    if not path.is_file():
        return HTMLResponse("Not found", status_code=404)
    modules = (STATIC_DIR / "multiplayer" / "sim").glob("*.js")
    imports = {
        f"/tools/multiplayer/sim/{module.name}": f"/tools/multiplayer/sim/{module.name}?rules={Rules.RULE_HASH}"
        for module in modules
    }
    import_map = f'<script type="importmap">{json.dumps({"imports": imports})}</script>'
    document = path.read_text(encoding="utf-8")
    return HTMLResponse(document.replace('<script type="module"', import_map + '\n<script type="module"', 1))


@app.get("/tools/prototype/", include_in_schema=False)
@app.get("/tools/prototype/index.html", include_in_schema=False)
async def prototype_document() -> HTMLResponse:
    return game_document("prototype")


@app.get("/tools/multiplayer/", include_in_schema=False)
@app.get("/tools/multiplayer/index.html", include_in_schema=False)
async def multiplayer_document() -> HTMLResponse:
    return game_document("multiplayer")


@app.get("/", include_in_schema=False)
async def game_home() -> RedirectResponse:
    destination = "/tools/prototype/" if (STATIC_DIR / "prototype" / "index.html").is_file() else "/dev"
    return RedirectResponse(destination, status_code=307)


@app.get("/dev", response_class=HTMLResponse, tags=["dev"])
async def index() -> str:
    sandbox = "/sandbox/" if (STATIC_DIR / "sandbox" / "index.html").is_file() else None
    prototype = (
        "/tools/prototype/" if (STATIC_DIR / "prototype" / "index.html").is_file() else None
    )
    multiplayer = (
        "/tools/multiplayer/" if (STATIC_DIR / "multiplayer" / "index.html").is_file() else None
    )
    links = []
    if sandbox:
        links.append(f'<li><a href="{sandbox}">Phase 0 — 모래 자동자 샌드박스</a></li>')
    if prototype:
        links.append(
            f'<li><a href="{prototype}">Phase 1 — 플레이어블 포병 프로토타입</a></li>'
        )
    if multiplayer:
        links.append(
            f'<li><a href="{multiplayer}">Phase 4 — 멀티플레이 네트워크 하네스</a></li>'
        )
    if not links:
        links.append("<li><em>개발 도구를 찾을 수 없다 (NEODEOL_STATIC_DIR 확인)</em></li>")
    tool_links = "\n".join(links)
    return f"""<!doctype html><meta charset=utf-8><title>Neodeol dev</title>
<style>
 body{{background:#120F17;color:#E8DFD2;font:14px/1.7 ui-sans-serif,system-ui;padding:40px;max-width:640px}}
 h1{{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#3DDCFF}}
 a{{color:#D99A5B}} code{{color:#B4FF3D}} ul{{padding-left:20px}}
 .dim{{color:#6E6478;font-size:12px}}
</style>
<h1>Neodeol — dev server</h1>
<p class=dim>env <code>{ENV}</code> · app <code>{__version__}</code> · sim <code>{constants.SIM_VERSION}</code></p>
<ul>
{tool_links}
<li><a href="/readyz">/readyz</a> — Redis · PostgreSQL 연결</li>
<li><a href="/version">/version</a> — 시뮬레이션 규칙 신원</li>
<li><a href="/constants">/constants</a> — 상수 전체</li>
<li><a href="/deps">/deps</a> — 라이브러리 버전</li>
<li><a href="/docs-api">/docs-api</a> — OpenAPI</li>
</ul>
<p class=dim>Phase 4 기반: 코드형 룸 · msgpack WebSocket · 권위 턴 · 재접속.</p>
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
