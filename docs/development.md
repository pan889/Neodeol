# 개발 환경

로컬에서 무엇을 어떻게 띄우는가. 배포(EKS)는 Phase 7 이고 별도 문서로 분리한다.

---

## 1. 지금 무엇이 돌아가는가

**Phase 3 서버 미러, Phase 3.5 Canvas 감성 패스와 Phase 4 Canvas lockstep 수직 슬라이스까지 구현했다.**
현재는 4인 실기기·장기 매치·재접속/오프라인 완료 조건을 닫는 Phase 4 안정화 단계다.

| 것 | 어디 | 무엇 | URL |
|---|---|---|---|
| 모래 자동자 샌드박스 | `tools/sandbox/` | Phase 0. 자동자를 손으로 만져보는 하네스 | `/sandbox/` |
| Canvas 전장 | `tools/prototype/` | 로컬 핫시트와 Phase 4 권위 lockstep 재생 | `/tools/prototype/`, `/tools/prototype/?multiplayer=1` |
| 멀티 네트워크 하네스 | `tools/multiplayer/` | Phase 4. 코드형 룸·WebSocket·재접속 검증 | `/tools/multiplayer/` |
| 탄도 검산기 | `tools/ballistics-check.mjs` | `simulation.md` §8 표를 재생성 | — |
| 클라이언트 sim | `client/src/sim/` | Phase 2. 정수 TS 이식. **부동소수점 0개** | — |
| 서버 sim | `server/src/talus/sim/` | Phase 3. 지형·탄도·무기·맵 생성·매치의 Python 미러 | — |
| 골든 리플레이 | `tests/replays/` | 자동자 20 + 장기 2 + 발사 + 맵 생성 + 매치 | — |
| 룸 서버 | `server/` | 정적 서빙 + 코드형 로비 + 권위 WebSocket 룸 | `/` |

프로토타입은 샌드박스의 `automaton.js` 를 **그대로 재사용한다.** 지형 자동자 사본은 하나뿐이다.

**포팅 방향은 브라우저 → TS → Python 이다.** TS 가 진실의 원본이고 Python 은 번역이다.
번역이 맞는지는 골든 리플레이가 판정한다 (§4.2).

Phase 4 기반은 프로세스 풀 권위 시뮬레이션, 프로세스 메모리 룸 저장소, gzip 리싱크,
token 재접속과 실제 Canvas lockstep 재생까지 포함한다. Redis 영속화는 Phase 7 범위다.

---

## 2. 도커로 띄운다

```bash
docker compose up -d --build
```

| 주소 | 무엇 |
|---|---|
| http://localhost:8000/sandbox/ | **Phase 0 샌드박스** |
| http://localhost:8000/tools/prototype/ | **Phase 1 플레이어블 프로토타입** |
| http://localhost:8000/tools/multiplayer/ | **Phase 4 멀티 네트워크 하네스** |
| http://localhost:8000/tools/prototype/?multiplayer=1 | **저장된 룸 세션으로 들어가는 멀티 Canvas 전장** |
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

컨테이너 health, HTTP·개발 도구, 브라우저 sim 미러, 실제 2인 WebSocket 턴,
Chrome 두 탭의 Canvas 2턴, 컨테이너 내부 pytest를 순서대로 검사한다.

직접 확인할 때는 `/tools/multiplayer/`를 두 탭에서 열어 한쪽이 룸을 만들고 다른 쪽이 참가한다.
각 탭의 **멀티 Canvas 전장 열기**를 누른 뒤 호스트가 시작하면, 활성 슬롯만 조준·발사할 수 있고
비행·폭발·지형 정착이 끝난 뒤에만 다음 슬롯의 조작이 열린다.

### 2.1 소스를 고치면

`server/src`, `server/tests`, `tools`, `docs`, `scripts`, `tables` 는 **읽기전용 바인드 마운트**다.

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
| `test_seeds_actually_differ` | 동작 | 시드를 무시하는 구현이 `test_replay_stable` 을 통과하는 것 |
| `test_interleaved_runs_do_not_contaminate` | 동작 | 게이트 캐시가 시드 사이에 오염되는 것 |
| `test_settle_terminates` | 동작 (전 격자판은 `slow`) | 정착이 안 끝나 **턴이 안 끝나는 것** |
| `test_trig_table` | 동작 | `trig.bin` 이 서버·클라에서 달라지는 것 |
| `test_cross_sim` | 동작 (20개) | 스텝 단위로 Python 이 TS 와 갈라지는 것 |
| `test_replay_stable` | 동작 (60턴 / 1000턴은 `slow`) | **턴 경계**에서 갈라지는 것 |
| `test_long_replay_is_long_enough` | 동작 | 턴이 no-op 인 리플레이로 완료 조건을 형식만 채우는 것 |
| `test_long_replays_divide_the_work` | 동작 | 장기 골든 한쪽만 재생성해 짝이 어긋나는 것 / 둘이 같은 성격이 되어 시간만 두 배 쓰는 것 |
| `test_flat_range_matches_doc_table` | 동작 | 탄도가 TS·문서 표와 갈라지는 것 |
| `test_ballistics_fits_int32` | 동작 | 중간값이 int32 를 넘어 TS 의 `>>` 절단과 갈라지는 것 |
| `test_two_player_turn_desync_and_reconnect` | 동작 | 룸 턴 순서·리싱크·동일 슬롯 재접속 회귀 |

실행 중인 Docker 포트를 직접 타는 짧은 검증은 다음 명령이다.

```bash
docker compose exec -T server python /app/scripts/smoke-multiplayer.py
```

> **skip 을 지우고 `pass` 로 바꾸지 마라.** 결정론 버그를 은폐하는 가장 흔한 경로다.
> 위 표의 skip 은 Phase 3 에서 전부 풀렸다. 골든이 없으면 다시 skip 으로 돌아가는데,
> 그건 "통과"가 아니라 "검사 안 함"이다 — `npm --prefix client run test:cross-sim` 이
> 골든 개수를 세서 20개 미만이면 실패시킨다.

### 4.3 결정론 게이트

```bash
npm --prefix client test                            # float·사본 stale·결정론. 약 1분
docker compose exec server python -m pytest /app/tests/test_determinism.py   # 약 2분
npm --prefix client run test:cross-sim              # 60턴까지. 약 5분
npm --prefix client run test:cross-sim -- --slow    # 1000턴 포함. 약 25분

# 릴리스 전에만 — 전 격자 정착 종료성 (지형 하나가 약 60초)
docker compose exec server python -m pytest /app/tests/test_determinism.py -m slow
```

교차 검증의 **대조는 Python 이 한다** (`server/tests/test_cross_sim.py`). npm 스크립트는
골든 무결성(사이드카 해시, 개수, mapgen/match 존재)을 보고 재생을 pytest 에 넘긴다. 도커가 떠 있으면 컨테이너에서,
아니면 호스트 `python3` 로 돌린다.

`slow` 마크는 기본 제외다 (`server/pyproject.toml` 의 `addopts`). 1000턴 리플레이는 재생만
10분 가까이 걸려서, 상시 게이트에 넣으면 아무도 게이트를 안 돌리게 된다.
상시 그물은 60턴짜리(`terrain-long`, 178,031스텝)다.

두 장기 리플레이는 **역할을 나눠 맡는다.** 둘 다 크게 만들면 검증 비용이 규칙 변경을
막는 수준이 된다 — 대형 폭발로 1000턴을 돌리면 300만 스텝이라 생성 34분 + 재생 57분이다.

| | 턴 | 폭발 반경 | 총 스텝 | 무엇을 보는가 |
|---|---|---|---|---|
| `terrain-long` | 60 | 14~59 (대형) | 178,031 | 한 턴의 **규모** |
| `terrain-long1k` | 1000 | 8~27 (중간) | 953,354 | **지속** — 누적 상태가 오래 가도 안 어긋나는가 |

> **`server/pyproject.toml` 을 고쳤으면 컨테이너를 재생성한다.**
>
> ```bash
> docker compose up -d --force-recreate server
> ```
>
> compose 가 이 파일을 **단일 파일 바인드 마운트**로 올리는데, 에디터가 파일을 원자적 교체
> (새 inode 에 쓰고 rename)로 저장하면 컨테이너 쪽 마운트는 지워진 옛 inode 를 계속 가리킨다.
> 증상은 `FileNotFoundError: '/app/pyproject.toml'` 이고, 소스(`/app/src`)는 디렉터리
> 마운트라 이 문제가 없어서 "왜 이것만" 하고 헤매기 쉽다. `restart` 로는 안 풀린다 —
> 마운트를 다시 해석하려면 컨테이너를 새로 만들어야 한다.

---

## 5. `SIM_VERSION` 이 하는 일

`server/src/talus/constants.py` 는 `docs/simulation.md` §8, `docs/terrain.md` §4,
`docs/mapgen.md`, `docs/match.md`의 **기계 판독 사본**이다. **문서가 기준이고** 어긋나면 문서를 먼저 고친다.

`SIM_VERSION` 은 이 상수 집합 전체의 SHA-256 앞 16자리다. 상수가 하나라도 바뀌면 값이 바뀐다.
상수 밖의 sim 절차가 바뀌면 `RULES_VERSION`을 올리고, 누락은 교차 골든이 잡는다.

```
$ curl -s localhost:8000/version
{"app_version":"0.0.0","protocol_version":2,"sim_version":"<16 hex>",
 "provisional":["... constants.PROVISIONAL의 현재 값 ..."],
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
    sim/                       Phase 3 완료: terrain/ballistics/weapons/mapgen/match
    room/                       Phase 4 룸 수명주기·권위 턴·프로세스 풀
    net/multiplayer.py          코드형 로비 REST·WebSocket
    net/protocol.py             msgpack 와이어 검증
  tests/
    test_determinism.py       결정론 게이트
    test_health.py            앱 기동
```

client/
  src/sim/                     Phase 2~3 TypeScript 기준 구현
  tests/                       결정론·교차 검증 진입점
  tools/                       float 검사·골든 생성기

---

## 7. 자주 걸리는 것

| 증상 | 원인 |
|---|---|
| `port is already allocated` | §2.2 — 호스트 포트 변경 |
| `/readyz` 503 | Redis/PostgreSQL 미기동. `docker compose ps` 로 health 확인 |
| `/sandbox/` 404 | `TALUS_STATIC_DIR` 이 `tools/` 를 안 가리킨다 |
| pytest 가 `sim/` 을 못 찾음 | `PYTHONPATH=src`. 테스트는 설치된 패키지에서 경로를 찾으므로 컨테이너에서도 동작한다 |
| 샌드박스에서 자동자를 고쳤는데 반영 안 됨 | `automaton.js` 는 정적 파일이다. 하드 리로드 |
