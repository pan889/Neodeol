"""Redis (룸 상태) · PostgreSQL (전적/상점) 접근.

Phase 0~3 에서는 연결 확인만 한다. 스키마와 실제 쿼리는 Phase 4 이후.
"""

from .health import DepStatus, check_postgres, check_redis

__all__ = ["DepStatus", "check_redis", "check_postgres"]
