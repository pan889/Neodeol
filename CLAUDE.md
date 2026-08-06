# Talus

턴제 포병 대전 게임. 웹 클라이언트 + 권위 서버(authoritative server) 구조의 멀티플레이.

각도와 파워로 포탄을 쏘고, 폭발이 지형을 파괴하고, 파괴된 흙이 **모래처럼 무너져 내려** 다음 턴의 지형이 바뀐다.
1991년 Scorched Earth 계열(포트리스, 웜즈, 건바운드)의 규칙 구조를 그대로 가져오되, 표현은 전면 재설계한다.

> **코드네임.** `Talus`는 절벽 아래 무너져 쌓인 암설 더미를 뜻하는 지질학 용어다.
> 이 게임의 핵심 상수인 안식각(angle of repose)이 talus 개념에서 나온다.
>
> **IP 주의.** Scorched Earth, 포트리스, 건바운드의 **규칙과 메카닉은 저작권 대상이 아니므로 그대로 가져간다.**
> 게임명, 무기 고유명(Death's Head, MIRV, Funky Bomb 등), 캐릭터, 스프라이트, UI 레이아웃은 차용하지 않는다.
> 무기는 전부 자체 명명한다. `docs/game-design.md` §6.

---

## 문서 순서

작업 전에 관련 문서를 먼저 읽는다. 코드와 문서가 어긋나면 **문서가 기준**이고, 문서를 고치는 것이 먼저다.

| 문서 | 내용 | 언제 읽나 |
|---|---|---|
| `docs/decisions.md` | **결정 대기 목록.** 선택지와 추천안까지 | 무언가를 확정하기 전에 항상 |
| `docs/game-design.md` | 게임 규칙, 확정된 기획 결정과 그 근거 | 게임 로직 건드릴 때 |
| `docs/terrain.md` | **모래 붕괴 자동자 명세.** 이 프로젝트의 심장 | `sim/terrain` 작업 전 필수 |
| `docs/simulation.md` | 좌표계, 상수표, 탄도, 폭발, 결정론 | `sim/` 작업 전 필수 |
| `docs/netcode.md` | 결정론적 lockstep, 룸 수명주기, 리싱크, 프로토콜 | `room/`, `net/` |
| `docs/rendering.md` | 아트 디렉션과 WebGL 파이프라인 | 클라이언트 렌더러 |
| `docs/development.md` | 로컬 실행, 도커, 검증 명령 | 처음 들어왔을 때 |
| `docs/roadmap.md` | 단계별 진행 순서와 완료 조건 | 다음에 뭘 할지 모를 때 |

**`docs/decisions.md` 가 다른 문서보다 먼저다.** 문서 본문에 없는 값을 코드에서 정하려는 순간
그 항목이 여기 있는지 먼저 본다. 있으면 결정을 요청하고, 없으면 항목으로 추가한다.

---

## 절대 규칙

이 여섯 개는 리팩터링이든 급한 수정이든 예외 없다.

**1. `sim/`은 순수해야 한다.**
`sim/` 안에서는 `asyncio`, 소켓, 파일, 시계, `random.random()` 금지.
입력은 `(state, inputs)`, 출력은 `new_state`. 난수는 상태에 담긴 시드 기반 PRNG를 쓴다.

**2. 좌표는 정수 서브픽셀이다.**
부동소수점 좌표 금지. `1px = 16 subpx`, 모든 위치·속도는 `int`.
이 게임은 **lockstep이라서 결정론이 선택이 아니라 전제**다. float를 쓰는 순간 Python 서버와 JS 클라이언트가 갈라지고, 갈라지면 화면에 보이는 지형이 서로 달라진다. `docs/simulation.md` §2.

**3. 모래 자동자는 순서 독립적이어야 한다.**
셀을 순회하며 그 자리에서 옮기는 방식 금지. **제안(propose) → 충돌 해소(resolve) 2단계**로만 구현한다.
서버는 numpy 벡터 연산, 클라이언트는 TypedArray 루프로 구현하는데, 순서 의존적 규칙을 쓰면 두 구현이 절대 일치하지 않는다. `docs/terrain.md` §3.

**4. 지형 전체를 네트워크로 보내지 않는다.**
정상 경로에서는 **발사 명령만** 브로드캐스트하고, 지형은 각자 시뮬레이션한다.
전체 지형 전송은 접속/재접속/체크섬 불일치 때만 쓰는 복구 경로다. `docs/netcode.md` §3.

**5. 클라이언트를 절대 믿지 않는다.**
클라가 보내는 건 **의도**(각도, 파워, 무기)뿐이다. 착탄 지점·데미지·골드를 클라가 주장하게 두지 않는다.
서버도 동일 시뮬레이션을 돌리고, 그 결과가 진실이다.

**6. 지형은 렌더 데이터가 아니라 게임 상태다.**
`MaterialGrid`는 `sim/`이 소유한다. 렌더러는 읽기만 한다.
"보기 좋게" 하려고 렌더러에서 지형을 보정하는 코드가 들어가는 순간 클라이언트마다 다른 게임이 된다.

---

## 저장소 구조

```
server/src/talus/
  sim/          순수 시뮬레이션. I/O 없음. 여기가 게임의 진실.
    terrain.py    MaterialGrid, 모래 자동자, 폭발 카빙
    ballistics.py 탄도 적분, 충돌 판정
    weapons.py    무기 정의 테이블과 발동 로직
    match.py      라운드/턴 진행, 경제, 승패 판정
  room/         턴 루프, 입력 수집, 이벤트 브로드캐스트
  net/          FastAPI, WebSocket, msgpack 인코딩
  lobby/        매치메이킹, 룸 배정, JWT 발급 (stateless)
  store/        Redis, PostgreSQL 접근
  tests/
    test_determinism.py   ← 가장 중요한 테스트. §결정론 게이트

client/src/
  sim/          정수 서브픽셀 시뮬레이션. Phase 2에서 만든다.
  render/       WebGL2 렌더러. sim을 읽기만 한다.
  ui/           조준 HUD, 상점, 로비
  net/          WebSocket 클라이언트

tools/
  sandbox/      모래 자동자 튜닝 하네스 (docs/roadmap.md Phase 0)
    automaton.js  [SIM] 자동자 참조 구현. 정수 전용
    lab.js        [TOOL] 프리셋·계측·검증
    index.html    [TOOL] 렌더러 + 실시간 튜닝 UI
    harness.mjs   헤드리스 검증
  gen_trig.py   tables/trig.bin 생성 (Phase 2)

server/tests/   결정론 게이트. pyproject.toml 이 testpaths 를 잡는다
scripts/        verify-stack.sh
tables/         커밋되는 바이너리 데이터
docker-compose.yml
```

**포팅 방향은 브라우저 → TS → Python 이다.**

```
Phase 0  tools/sandbox/automaton.js     ← 참조 구현. 순서 독립성이 검증된 원본
Phase 2  client/src/sim/terrain.ts      ← 위의 정수화 이식
Phase 3  server/src/talus/sim/terrain.py ← TS의 1:1 번역. 창의성 없음
```

권위는 서버에 있지만(절대 규칙 5) **구현의 원본은 클라이언트 쪽이다.** 순서를 뒤집으면
"보기에 그럴듯한 물리"를 서버에서 먼저 만들고 클라가 그걸 흉내내는 구조가 되어,
Phase 0에서 손으로 잡은 감각이 사라진다.

---

## 결정론 게이트

**`sim/`을 건드리는 모든 PR은 아래를 통과해야 한다.**

```bash
# 0) 자동자 참조 구현 — 지금 실행 가능하다
#    재현성 · 순서 독립성 · 우선순위 동점 · 활성 행 무결성 · 해시 품질
node tools/sandbox/harness.mjs

# 1) 서버 자기 자신과의 재현성 — 지금 실행 가능하다
docker compose exec server python -m pytest /app/tests/test_determinism.py
#    도커 없이:  cd server && PYTHONPATH=src python -m pytest tests/test_determinism.py

# 2) 서버 ↔ 클라이언트 교차 검증 — Phase 3 이후
#    동일 시드 + 동일 입력 로그로 양쪽을 돌려 매 턴 지형 체크섬 비교
npm run test:cross-sim
```

**(2)는 Phase 3 이전에는 존재하지 않는다.** Python `sim/` 과 골든 리플레이 포맷이 모두
Phase 3 산출물이기 때문이다. 그때까지 `sim/` 을 건드리는 변경은 (0)과 (1)로 판정한다.
골든 리플레이 포맷 자체가 아직 미결이다 — `docs/decisions.md` B2.

교차 검증은 골든 리플레이 파일(`tests/replays/*.jsonl`)을 재생한다.
의도적으로 밸런스를 바꿔 리플레이가 깨졌다면, **깨진 이유를 커밋 메시지에 적고** 골든 파일을 재생성한다.
이유 없이 재생성하는 것은 금지다. 그게 결정론 버그를 은폐하는 가장 흔한 경로다.

---

## 기술 스택

Bulwark와 동일한 스택을 쓴다. 인프라 지식과 배포 파이프라인을 재사용하기 위함이다.

| 레이어 | 선택 | 비고 |
|---|---|---|
| 서버 | Python 3.12, FastAPI + uvicorn(uvloop) | |
| 서버 수치 연산 | numpy | 모래 자동자 벡터화. 순수 Python 루프로는 못 버틴다 |
| 클라이언트 | TypeScript | |
| 렌더러 | **WebGL2** | Bulwark의 Canvas 2D와 다른 선택. `docs/rendering.md` §2에 근거 |
| 직렬화 | msgpack | |
| 상태 저장 | Redis (룸), PostgreSQL (전적/상점) | |
| 배포 | EKS StatefulSet + 룸 어피니티 라우팅 | Bulwark 패턴 그대로 |

**턴제라서 Bulwark보다 인프라 요구가 훨씬 낮다.** 30Hz 스냅샷 브로드캐스트가 없고, 룸당 트래픽이 턴당 수십 바이트다.
Bulwark 인프라 문서를 그대로 쓰되 틱 루프 관련 부분만 걷어내면 된다.

---

## 작업 원칙

- **모래 감각은 문서로 못 정한다.** 수치는 전부 `tools/sandbox/`에서 손으로 만져보고 정한다. 문서의 상수표는 시작점이지 정답이 아니다.
- **무기를 늘리기 전에 지형을 완성한다.** 무기가 20종이어도 지형이 밋밋하면 재미없고, 무기가 3종이어도 지형이 살아있으면 재밌다.
- **미결 항목은 임의로 결정하지 않는다.** 각 문서 말미의 미결 목록에 있는 항목을 코드에서 마음대로 확정하지 말고 물어본다.
