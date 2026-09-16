"""앱이 실제로 뜨고 응답하는지. 의존성 없이 ASGI 로 직접 호출한다.

`/readyz` 는 Redis·PostgreSQL 이 필요하므로 여기서 확인하지 않는다.
그건 `docker compose up` 후 `scripts/verify-stack.sh` 가 본다.
"""

from __future__ import annotations

import httpx
import pytest

from neodeol.net.app import app


@pytest.fixture
def client() -> httpx.AsyncClient:
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


async def test_healthz(client: httpx.AsyncClient) -> None:
    async with client as c:
        r = await c.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert "uptime_s" in body


async def test_version_exposes_sim_identity(client: httpx.AsyncClient) -> None:
    """클라이언트가 규칙 신원을 대조할 수 있어야 한다 (docs/netcode.md)."""
    async with client as c:
        r = await c.get("/version")
    assert r.status_code == 200
    body = r.json()
    assert len(body["sim_version"]) == 16
    assert body["grid"] == {"w": 960, "h": 540, "cell_px": 2}
    # Phase 3 구현은 끝났지만 밸런싱 값은 아직 잠정이다.
    # 이 목록이 비면 밸런싱 기준선이 잡혔다는 뜻이고, 그때 이 단정을 뒤집는다.
    assert "GRAVITY" in body["provisional"]
    assert "MAX_SETTLE_STEPS" in body["provisional"]


async def test_constants_dump_has_no_floats(client: httpx.AsyncClient) -> None:
    async with client as c:
        r = await c.get("/constants")
    assert r.status_code == 200
    for name, value in r.json()["constants"].items():
        assert not isinstance(value, float), f"{name} 이 부동소수점이다"


async def test_sandbox_is_served(client: httpx.AsyncClient) -> None:
    """Phase 0 샌드박스가 정적으로 서빙된다."""
    async with client as c:
        r = await c.get("/sandbox/")
    if r.status_code == 404:
        pytest.skip("NEODEOL_STATIC_DIR 이 tools/ 를 가리키지 않는다 (로컬 pytest 실행)")
    assert r.status_code == 200
    assert "모래 자동자 샌드박스" in r.text


async def test_prototype_is_linked_and_served(client: httpx.AsyncClient) -> None:
    """로컬 Docker 첫 화면에서 플레이어블 프로토타입으로 바로 들어갈 수 있다."""
    async with client as c:
        root = await c.get("/dev")
        prototype = await c.get("/tools/prototype/")
    if prototype.status_code == 404:
        pytest.skip("NEODEOL_STATIC_DIR 이 tools/ 를 가리키지 않는다 (로컬 pytest 실행)")
    assert root.status_code == 200
    assert "/tools/prototype/" in root.text
    assert prototype.status_code == 200
    assert "Neodeol" in prototype.text


async def test_multiplayer_harness_is_linked_and_served(client: httpx.AsyncClient) -> None:
    """Phase 4 네트워크 하네스를 로컬 첫 화면에서 바로 열 수 있다."""
    async with client as c:
        root = await c.get("/dev")
        multiplayer = await c.get("/tools/multiplayer/")
    if multiplayer.status_code == 404:
        pytest.skip("NEODEOL_STATIC_DIR 이 tools/ 를 가리키지 않는다 (로컬 pytest 실행)")
    assert root.status_code == 200
    assert "/tools/multiplayer/" in root.text
    assert multiplayer.status_code == 200
    assert "MULTIPLAYER NETWORK HARNESS" in multiplayer.text


async def test_trig_table_is_served_for_browser_lockstep(client: httpx.AsyncClient) -> None:
    async with client as c:
        response = await c.get("/tables/trig.bin")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/octet-stream")
    assert len(response.content) == 7204


async def test_root_opens_game_or_dev_fallback(client: httpx.AsyncClient) -> None:
    async with client as connection:
        response = await connection.get("/")
    assert response.status_code == 307
    assert response.headers["location"] in ("/tools/prototype/", "/dev")


async def test_singleplayer_interface_assets(client: httpx.AsyncClient) -> None:
    async with client as connection:
        page = await connection.get("/tools/prototype/")
        if page.status_code == 404:
            pytest.skip("NEODEOL_STATIC_DIR does not point at tools")
        for asset in ("interface.css", "base.css", "operations.js", "canyon.svg"):
            response = await connection.get(f"/tools/prototype/{asset}")
            assert response.status_code == 200
            assert len(response.content) > 100
    assert 'id="homeScreen"' in page.text
    assert 'id="bQuickPlay"' in page.text
    assert 'id="battleGuide"' in page.text
