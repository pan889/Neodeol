# 개발 환경

로컬에서 무엇을 어떻게 띄우는가. 배포(EKS)는 Phase 7 이고 별도 문서로 분리한다.

---

## 1. 지금 무엇이 돌아가는가

현재 단계는 **Phase 0** 이다. 실제로 존재하는 것은 두 개다.

| 것 | 어디 | 무엇 | URL |
|---|---|---|---|
| 모래 자동자 샌드박스 | `tools/sandbox/` | Phase 0. 자동자를 손으로 만져보는 하네스 | `/sandbox/` |
| 손맛 프로토타입 | `tools/prototype/` | Phase 1. 탱크·탄도·바람·핫시트 | `/tools/prototype/` |
| 탄도 검산기 | `tools/ballistics-check.mjs` | `simulation.md` §8 표를 재생성 | — |
| 서버 스캐폴드 | `server/` | 정적 서빙 + 헬스체크 + 상수 노출. **게임 로직은 없다** | `/` |

프로토타입은 샌드박스의 `automaton.js` 를 **그대로 재사용한다.** 지형 자동자 사본은 하나뿐이다.

`sim/`, `room/`, `lobby/` 는 비어 있다. `docs/roadmap.md` 의 단계 순서를 지킨다 —
지형이 확정되기 전에 서버 로직을 만들면 두 구현이 갈라진 채로 굳는다.

> **왜 Phase 0 인데 서버가 있는가.** 로드맵 Phase 0 의 "하지 않는 것"에 서버가 들어 있다.
> 여기 있는 서버는 **게임 서버가 아니라 개발 인프라**다 — 샌드박스를 URL 로 열고, Redis/PostgreSQL
> 연결이 실제로 되는지 확인하고, 상수 표의 기계 판독 사본을 노출한다.
> `talus/sim/` 에 코드를 넣는 것은 여전히 Phase 3 이다.

---

## 2. 도커로 띄운다

```bash
docker compose up -d --build
```

| 주소 | 무엇 |
|---|---|
| http://localhost:8000/sandbox/ | **Phase 0 샌드박스** |
| http://localhost:8000/ | 링크 모음 |
| http://localhost:8000/healthz | liveness (의존성 안 건드림) |
| http://localhost:8000/readyz | Redis · PostgreSQL 연결 |
| http://localhost:8000/version | `sim_version`, 잠정 상수 목록 |
| http://localhost:8000/constants | 상수 전체 |
| http://localhost:8000/deps | 라이브러리 버전 |

전부 한 번에 확인:

```bash
./scripts/verify-stack.sh --up
```

컨테이너 3개의 health, HTTP 엔드포인트 5개, 샌드박스 서빙, 컨테이너 내부 pytest 를 순서대로 검사한다.

### 2.1 소스를 고치면

`server/src`, `server/tests`, `tools`, `docs`, `tables` 는 **읽기전용 바인드 마운트**다.

| 무엇을 고쳤나 | 필요한 것 |
|---|---|
| `server/src/**.py` | 없음 — `uvicorn --reload` 가 잡는다 |
| `tools/sandbox/**` | 없음 — 브라우저 새로고침 |
| `server/requirements.txt` | `docker compose up -d --build` |
| `docker-compose.yml` | `docker compose up -d` |

### 2.2 포트가 이미 쓰이고 있으면

기본 호스트 포트는 **표준 포트를 피한다.** 개발 기계에는 이미 다른 Redis/PostgreSQL 이 떠 있는 경우가 많고,
표준 포트를 점유하면 스택이 아예 안 뜬다.

| 서비스 | 컨테이너 내부 | 호스트 기본 | 환경변수 |
|---|---|---|---|
| server | 8000 | 8000 | `TALUS_PORT` |
| redis | 6379 | **16379** | `TALUS_REDIS_PORT` |
| postgres | 5432 | **15432** | `TALUS_PG_PORT` |

컨테이너끼리는 compose 네트워크 내부 이름(`redis:6379`, `postgres:5432`)으로 통신하므로
호스트 포트는 디버깅 편의일 뿐이다.

```bash
TALUS_PORT=8080 docker compose up -d      # 또는 .env 파일에 적는다
```

### 2.3 로그와 정리

```bash
docker compose logs -f server
docker compose down            # 컨테이너 제거 (pgdata 볼륨은 남는다)
docker compose down -v         # 볼륨까지 제거
```

---

## 3. 도커 없이

샌드박스는 빌드 도구가 필요 없다. `tools/sandbox/index.html` 을 브라우저로 직접 열면 된다.

헤드리스 검증은 node 만 있으면 된다.

```bash
node tools/sandbox/harness.mjs
```

서버는 Python 3.12 가 필요하다.

```bash
cd server
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
PYTHONPATH=src TALUS_STATIC_DIR=../tools uvicorn talus.net.app:app --reload
python -m pytest            # server/pyproject.toml 이 경로를 잡는다
```

`/readyz` 는 Redis·PostgreSQL 이 없으면 503 을 반환한다. 정상이다 —
Phase 0 에서 그 둘이 필요한 코드는 없다.

---

## 4. 검증 — 무엇이 무엇을 보증하는가

### 4.1 자동자 (Phase 0 의 본체)

```bash
node tools/sandbox/harness.mjs              # 전부
node tools/sandbox/harness.mjs --hash       # 해시 품질
node tools/sandbox/harness.mjs --determinism # 재현성·순서 독립성·동점
node tools/sandbox/harness.mjs --active     # 활성 행이 셀을 굶기지 않는가
node tools/sandbox/harness.mjs --repose     # 안식각 실측
node tools/sandbox/harness.mjs --sweep      # slideChance 응답 곡선
node tools/sandbox/harness.mjs --collapse   # 대형 붕괴
node tools/sandbox/harness.mjs --structure  # 아치·오버행
```

브라우저의 **결정론 자기검증** 버튼들과 **같은 코드**를 돌린다
(`tools/sandbox/lab.js` 를 양쪽이 공유한다). 그래서 "브라우저에서는 되는데 헤드리스에서는 안 되는"
상태가 생기지 않는다.

### 4.1.1 탄도 상수

```bash
node tools/ballistics-check.mjs           # 사거리 + 바람 편차
node tools/ballistics-check.mjs --sweep   # POWER_SCALE 스윕, 파워→사거리 선형성
```

`docs/simulation.md` §8.1·§8.2 의 표를 재생성한다. **상수를 바꾸면 이걸 돌려 문서 표를 갱신한다.**
닫힌형 공식이 아니라 §4.2 적분을 정수로 그대로 돌리므로, 서브스텝 절단까지 반영된 값이 나온다.

| 검사 | 무엇을 막는가 |
|---|---|
| 해시 품질 | 방향 선택이 무작위가 아니게 되는 것 (`terrain.md` §7.1) |
| 재현성 | 같은 입력이 다른 결과를 내는 것 |
| 순서 독립성 | **절대 규칙 3.** 해소가 순회 순서를 타는 것 |
| 동점 검출 | 한 목표에 두 셀이 들어가 질량이 사라지는 것 |
| 활성 행 무결성 | 이동 가능한 셀이 굶어 거짓 정착이 되는 것 |

### 4.2 서버

```bash
docker compose exec server python -m pytest /app/tests -q
```

| 테스트 | 지금 | 무엇을 막는가 |
|---|---|---|
| `test_no_float` | 동작 | `sim/` 에 float·`/`·`math.*` 가 들어오는 것 |
| `test_constants_stable` | 동작 | `SIM_VERSION` 이 프로세스마다 달라지는 것 |
| `test_constants_are_integers` | 동작 | 상수표에 실수가 섞이는 것 |
| `test_replay_stable` | skip (Phase 3) | — |
| `test_trig_table` | skip (Phase 2) | — |
| `test_cross_sim` | skip (Phase 3) | — |

> **skip 을 지우고 `pass` 로 바꾸지 마라.** 결정론 버그를 은폐하는 가장 흔한 경로다.
> `sim/` 이 생기면 `test_replay_stable` 은 자동으로 skip 이 풀리고 실패한다. 그게 의도다.

### 4.3 결정론 게이트

`CLAUDE.md` §결정론 게이트가 요구하는 두 명령 중 지금 실행 가능한 것은 첫 번째뿐이다.

```bash
docker compose exec server python -m pytest /app/tests/test_determinism.py     # 실행 가능
npm run test:cross-sim                                                          # Phase 3 이후
```

교차 검증은 Python `sim/` 과 골든 리플레이 포맷이 있어야 성립하고, 둘 다 Phase 3 산출물이다.
`docs/decisions.md` B2 참조.

---

## 5. `SIM_VERSION` 이 하는 일

`server/src/talus/constants.py` 는 `docs/simulation.md` §8 과 `docs/terrain.md` §4 의
**기계 판독 사본**이다. **문서가 기준이고** 어긋나면 문서를 먼저 고친다.

`SIM_VERSION` 은 이 상수 집합 전체의 SHA-256 앞 16자리다. 상수가 하나라도 바뀌면 값이 바뀐다.

```
$ curl -s localhost:8000/version
{"app_version":"0.0.0","protocol_version":1,"sim_version":"<16 hex>",
 "provisional":["BLAST_RESIST_Q8","GRAVITY","MAX_SETTLE_STEPS","POWER_SCALE",
                "SLIDE_CHANCE_SAND_Q8","SLIDE_CHANCE_SOIL_Q8","WIND_MAX"],
 "grid":{"w":960,"h":540,"cell_px":2}}
```

**`sim_version` 의 실제 값은 여기 적지 않는다.** 상수를 만질 때마다 바뀌므로 문서에 박아두면
반드시 어긋난다. 유일한 출처는 `constants.py` 이고, 현재 값은 위 명령으로 확인한다.
`provisional` 목록도 `constants.PROVISIONAL` 이 유일한 출처다.

`SUBSTEPS` 가 이 목록에 **없는 것이 정상이다** — 표현 상수라 애초에 상수 집합에 들어가지 않는다
(`terrain.md` §3.4). 따라서 Phase 2 완료 조건인 "`PROVISIONAL` 이 비었다"는
`SUBSTEPS` 확정을 요구하지 않는다.

- **접속 시 대조한다.** 값이 다르면 두 쪽이 다른 규칙으로 계산하고 있다는 뜻이므로
  같은 방에 넣어서는 안 된다. `docs/decisions.md` B9
- `provisional` 이 비어 있지 않으면 아직 밸런싱 기준선이 확정되지 않은 상태다.
  이 목록이 비는 것이 Phase 1 완료의 신호다

상수를 추가하면 **자동으로** 해시에 포함된다(블랙리스트 방식). 화이트리스트로 하면
상수를 추가했는데 해시가 안 바뀌는 사고가 난다.

---

## 6. 저장소 배치

```
docker-compose.yml          로컬 스택 (server + redis + postgres)
scripts/verify-stack.sh     스택 전체 검증
tables/                     커밋되는 바이너리 데이터 (trig.bin — Phase 2)

tools/sandbox/              Phase 0 — 모래 자동자
  automaton.js                [SIM] 명세 구현. 정수 전용. Phase 2 이식 대상
  lab.js                      [TOOL] 프리셋·계측·검증. 브라우저와 harness 가 공유
  index.html                  [TOOL] 렌더러 + UI
  harness.mjs                 헤드리스 검증

server/
  Dockerfile  requirements.txt  pyproject.toml
  src/talus/
    constants.py              상수 사본 + SIM_VERSION
    net/app.py                FastAPI
    store/health.py           의존성 확인
    sim/  room/  lobby/       비어 있음 (Phase 3~4)
  tests/
    test_determinism.py       결정론 게이트
    test_health.py            앱 기동
```

`client/` 는 아직 없다. Phase 2 에서 `tools/sandbox/automaton.js` 를 `client/src/sim/terrain.ts` 로
정수화·이식하면서 생긴다.

---

## 7. 자주 걸리는 것

| 증상 | 원인 |
|---|---|
| `port is already allocated` | §2.2 — 호스트 포트 변경 |
| `/readyz` 503 | Redis/PostgreSQL 미기동. `docker compose ps` 로 health 확인 |
| `/sandbox/` 404 | `TALUS_STATIC_DIR` 이 `tools/` 를 안 가리킨다 |
| pytest 가 `sim/` 을 못 찾음 | `PYTHONPATH=src`. 테스트는 설치된 패키지에서 경로를 찾으므로 컨테이너에서도 동작한다 |
| 샌드박스에서 자동자를 고쳤는데 반영 안 됨 | `automaton.js` 는 정적 파일이다. 하드 리로드 |
