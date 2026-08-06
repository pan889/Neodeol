#!/usr/bin/env bash
# 로컬 도커 스택이 실제로 동작하는지 확인한다.
#
#   ./scripts/verify-stack.sh            # 이미 떠 있는 스택을 확인
#   ./scripts/verify-stack.sh --up       # 필요하면 먼저 띄운다
#   ./scripts/verify-stack.sh --rebuild  # 이미지를 다시 빌드하고 띄운다
#
# 확인 항목
#   1. 컨테이너 3개가 healthy 인가
#   2. /healthz /readyz /version /deps 가 응답하는가
#   3. Phase 0 샌드박스가 서빙되는가
#   4. 결정론 게이트(pytest)가 컨테이너 안에서 통과하는가
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${TALUS_PORT:-8000}"
BASE="http://localhost:${PORT}"
fail=0

say()  { printf '\033[36m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mOK\033[0m   %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; fail=1; }

case "${1:-}" in
  --rebuild) say "== 이미지 재빌드 =="; docker compose up -d --build ;;
  --up)      say "== 스택 기동 =="; docker compose up -d ;;
esac

say "== 1. 컨테이너 상태 =="
for svc in server redis postgres; do
  cid="$(docker compose ps -q "$svc" 2>/dev/null || true)"
  if [ -z "$cid" ]; then bad "$svc 컨테이너가 없다 (docker compose up -d)"; continue; fi
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid")"
  state="$(docker inspect -f '{{.State.Status}}' "$cid")"
  if [ "$state" = "running" ] && { [ "$health" = "healthy" ] || [ "$health" = "none" ]; }; then
    ok "$svc  $state/$health"
  else
    bad "$svc  $state/$health"
  fi
done

say "== 2. HTTP 엔드포인트 =="
probe() { # probe <path> <expected-status> <must-contain>
  local body code
  body="$(curl -sS -m 10 -w '\n%{http_code}' "${BASE}$1" 2>/dev/null || echo $'\n000')"
  code="$(printf '%s' "$body" | tail -n1)"
  body="$(printf '%s' "$body" | sed '$d')"
  if [ "$code" != "$2" ]; then bad "$1 → HTTP $code (기대 $2)"; return; fi
  if [ -n "${3:-}" ] && ! printf '%s' "$body" | grep -q "$3"; then
    bad "$1 → 본문에 '$3' 이 없다"; return
  fi
  ok "$1 → HTTP $code"
}
probe /healthz  200 '"ok":true'
probe /readyz   200 '"ok":true'
probe /version  200 'sim_version'
probe /deps     200 'numpy'

say "== 3. Phase 0 샌드박스 =="
probe /sandbox/ 200 '모래 자동자 샌드박스'

say "== 4. 결정론 게이트 (컨테이너 내부 pytest) =="
if docker compose exec -T server python -m pytest /app/tests -q 2>&1 | tail -15; then
  ok "pytest 통과"
else
  bad "pytest 실패"
fi

echo
if [ "$fail" -eq 0 ]; then
  printf '\033[32m전부 통과.\033[0m  샌드박스: %s/sandbox/\n' "$BASE"
else
  printf '\033[31m실패 항목이 있다.\033[0m  로그: docker compose logs -f server\n'
  exit 1
fi
