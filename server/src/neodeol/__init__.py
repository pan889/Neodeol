"""Neodeol — 턴제 포병 대전 게임 서버.

패키지 배치는 CLAUDE.md §저장소 구조를 따른다.

    sim/    순수 시뮬레이션. I/O 없음. 게임의 진실.   (Phase 3)
    room/   턴 루프, 입력 수집, 이벤트 브로드캐스트.  (Phase 4)
    net/    FastAPI, WebSocket, msgpack.
    lobby/  매치메이킹, 룸 배정, JWT.                 (Phase 4)
    store/  Redis, PostgreSQL 접근.
"""

__version__ = "0.0.0"
