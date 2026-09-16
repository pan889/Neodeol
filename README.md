# Neodeol · 너덜

**턴제 포병 대전 게임.** 각도와 파워로 포탄을 쏘고, 폭발이 지형을 파괴하고, 파괴된 흙이
모래처럼 무너져 내려 다음 턴의 지형이 바뀐다.

그리고 그 붕괴가 **Python 서버와 TypeScript 클라이언트에서 비트 단위로 똑같이** 일어난다.
이 저장소에서 볼 만한 것은 게임이 아니라 그쪽이다.

> **Neodeol**(너덜)은 **너덜겅** — 절벽 아래 무너져 쌓인 돌 더미와 그 비탈을 가리키는 우리말이다.
> 지질학의 talus/scree 지대가 바로 이것이고, 이 게임의 핵심 상수인 **안식각**(angle of repose)이
> 너덜겅이 쌓이는 기울기 그 자체다.

<sub>**In English** — A turn-based artillery game whose destructible terrain is simulated
*bit-identically* in two languages: a Python authoritative server (numpy) and a TypeScript client.
Integer subpixel coordinates, no floating point anywhere in `sim/`, an order-independent sand
automaton, and golden-replay cross-verification between the two implementations.
**All design documentation is in Korean** (~4,400 lines under `docs/`).</sub>

---

## 무엇이 어려운가

멀티플레이가 **결정론적 lockstep**이다. 서버는 발사 의도(각도·파워·무기)만 브로드캐스트하고,
지형은 각자 시뮬레이션한다. 그래서 두 구현이 한 셀이라도 어긋나면 **플레이어마다 다른 지형을
보게 된다.** 결정론이 품질 목표가 아니라 전제다.

이걸 지키려고 여섯 개를 절대 규칙으로 못박았다 ([CLAUDE.md](CLAUDE.md)).

| | |
|---|---|
| **정수 전용** | `1px = 16 subpx`, `1 cell = 32 subpx`. `sim/` 안에 부동소수점이 없다. 정적 검사가 막는다 |
| **순서 독립** | 모래 자동자는 **제안 → 충돌 해소 → 확정** 3단계다. 셀을 순회하며 그 자리에서 옮기지 않는다 |
| **순수 `sim/`** | 소켓·파일·시계·`random()` 금지. 난수는 `hash32(seed, x, y, step)` 하나뿐이다 |
| **지형은 게임 상태** | 렌더러는 읽기만 한다. "보기 좋게" 보정하는 순간 클라이언트마다 다른 게임이 된다 |
| **지형을 보내지 않는다** | 전체 전송은 재접속·체크섬 불일치 때만 쓰는 복구 경로다 |
| **클라를 믿지 않는다** | 착탄 지점도 피해도 골드도 서버가 정한다 |

**안식각은 손으로 넣은 상수가 아니라 규칙 기하에서 창발한다.** 이동 규칙만 정해두면
`SAND 26.6° < SOIL 40.3° < SCREE 44.2°` 가 실측으로 나온다. 세 각도가 이 순서로 벌어지는지를
테스트가 게이트로 지킨다.

## 포팅 방향

```
tools/sandbox/automaton.js     참조 구현. 순서 독립성을 손으로 잡은 원본
        ↓
client/src/sim/*.ts            위의 정수화 이식
        ↓
server/src/neodeol/sim/*.py    TS 의 1:1 번역. 창의성 없음
```

권위는 서버에 있지만 **구현의 원본은 클라이언트 쪽이다.** 순서를 뒤집으면 "보기에 그럴듯한
물리"를 서버에서 먼저 만들고 클라가 흉내내는 구조가 되어, 손으로 잡은 감각이 사라진다.

## 결정론 게이트

`sim/` 을 건드리는 변경은 전부 통과해야 한다.

```bash
node tools/sandbox/harness.mjs                  # 참조 구현: 재현성 · 순서 독립 · 해시 품질
npm --prefix client test                        # float 정적 검사 · 생성 사본 stale · 100회 재생
docker compose exec server python -m pytest /app/tests
npm --prefix client run test:cross-sim          # TS ↔ Python 교차 대조 (약 5분)
```

교차 검증은 **골든 리플레이**를 재생한다. TS 가 장면을 만들고, **대조는 Python 이 한다** —
검증 로직을 양쪽에 두면 둘이 어긋날 때 어느 쪽이 맞는지 판정할 방법이 없다.

대조 단위는 **스텝**과 **턴** 두 가지다. 스텝 대조 20개가 전부 통과한 뒤에 턴 대조가 이탈을
잡은 전례가 있어서 둘 중 하나만 남기지 않는다.

리플레이가 깨졌다면 **깨진 이유를 커밋 메시지에 적고** 재생성한다. 이유 없는 재생성은 금지다.
그게 결정론 버그를 은폐하는 가장 흔한 경로다.

### 밟지 않는 경로는 대조되지 않는다

이 저장소에서 실제로 잡은 desync 세 건은 전부 **골든이 밟지 않는 분기**에 있었다.

| 어디 | 무엇 |
|---|---|
| 강제 정착 종료 | 상한에 걸려 끝나는 경로만 활성 행 마스크를 안 비웠다 |
| 라운드 턴 상한 | Python 이 `× 1000` 을 달고 있었다 (40,000 vs 40) |
| 프로토타입 | 손으로 쓴 물리 사본이 정규 모듈과 갈라져 있었다 |

정상 경로 골든 20개는 셋 다 통과시킨다. 그래서 골든을 늘리는 것보다 **안 밟히는 분기를 찾아
경로를 만드는 것**이 더 값싸다.

## 지금 상태

Phase 3 서버 미러, Phase 3.5 Canvas 감성 패스, Phase 4 Canvas lockstep 수직 슬라이스 완료.
다음은 4인 실기기 · 장기 매치 · 재접속 완료 조건을 닫는 **Phase 4 안정화**다.
[docs/roadmap.md](docs/roadmap.md) 가 기준이다.

| | |
|---|---|
| 규칙 | 5라운드 · 무기 8종 · 아이템 4종 · 지질 프로빈스 4종 |
| 검사 | pytest 135(기본 133, `slow` 2) · 클라이언트 44 · Chrome E2E 2턴 desync 0 |
| 버전 | `SIM_VERSION 1d875e4391d70833` · `RULES_VERSION 6` · `PROTOCOL_VERSION 3` · `ruleHash A18FA875` |
| 분량 | `docs/` 4,393줄 · 서버 4,618줄 · 클라이언트 2,740줄 · 도구 8,006줄 · 서버 테스트 2,788줄 |

**미결 항목은 임의로 결정하지 않는다.** 확정되지 않은 값과 그 선택지는
[docs/decisions.md](docs/decisions.md) 에 모여 있고, 코드의 `PROVISIONAL` 표기가 그걸 가리킨다.

## 띄워 보기

```bash
docker compose up -d --build
```

| | |
|---|---|
| http://localhost:8000/tools/prototype/ | 플레이어블 프로토타입 (로컬 핫시트 · AI) |
| http://localhost:8000/tools/multiplayer/ | 멀티 네트워크 하네스 |
| http://localhost:8000/sandbox/ | 자동자 튜닝 샌드박스 |
| http://localhost:8000/constants | 상수 전체 |

자세한 건 [docs/development.md](docs/development.md).

## 문서

코드와 문서가 어긋나면 **문서가 기준**이고, 문서를 고치는 것이 먼저다.

| | |
|---|---|
| [decisions.md](docs/decisions.md) | **결정 대기 목록.** 다른 문서보다 먼저 본다 |
| [terrain.md](docs/terrain.md) | **모래 붕괴 자동자 명세.** 이 프로젝트의 심장 |
| [simulation.md](docs/simulation.md) | 좌표계 · 상수표 · 탄도 · 폭발 · 결정론 |
| [match.md](docs/match.md) | 라운드 · 턴 · 경제 · 승패 |
| [mapgen.md](docs/mapgen.md) | `mapSeed` → 초기 격자 · 스폰 |
| [netcode.md](docs/netcode.md) | lockstep · 룸 수명주기 · 리싱크 · 프로토콜 |
| [game-design.md](docs/game-design.md) | 게임 규칙과 확정된 기획 결정의 근거 |
| [rendering.md](docs/rendering.md) | 아트 디렉션과 렌더 파이프라인 |
| [development.md](docs/development.md) | 로컬 실행 · 도커 · 검증 |
| [roadmap.md](docs/roadmap.md) | 단계별 진행과 완료 조건 |

## 라이선스

[GNU AGPL v3.0](LICENSE).

네트워크 서버가 있는 게임이라 **§13** 이 실제로 의미를 갖는다 — 수정한 서버를 네트워크 너머로
제공하면 그 소스를 이용자에게 제공해야 한다. 고쳐서 돌리는 것은 환영하고, 고친 것을 닫는 것은
원하지 않는다는 뜻이다.

### 선행 작품에 대하여

1991년 Scorched Earth 계열(포트리스, 웜즈, 건바운드)의 **규칙 구조를 계승한다.** 게임 메카닉은
저작권 대상이 아니므로 그대로 가져간다. 다만 게임명 · 무기 고유명 · 캐릭터 · 스프라이트 ·
UI 레이아웃은 **차용하지 않는다.** 무기는 전부 자체 명명했다. [docs/game-design.md](docs/game-design.md) §6.
