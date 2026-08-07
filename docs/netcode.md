# 네트코드

**턴제라서 Bulwark보다 근본적으로 쉽다.** 클라이언트 예측도, 지연 보상도, 히트박스 되감기도 없다.
대신 **결정론적 lockstep**의 요구사항이 훨씬 엄격하다. 실시간 게임은 스냅샷으로 오차를 덮을 수 있지만, lockstep은 덮을 방법이 없다.

---

## 1. 기본 구조

```
클라이언트 → 서버 :  이번 턴의 의도 (각도, 파워, 무기)  ... 턴당 1회, ~12바이트
서버 → 클라이언트 :  활성 슬롯의 의도 + 시드 + 체크섬    ... 턴당 1회, ~24바이트
```

**지형을 네트워크로 보내지 않는다** (절대 규칙 4).
서버와 모든 클라이언트가 같은 시드에서 같은 맵을 생성하고, 같은 입력으로 같은 결과에 도달한다.

턴당 트래픽이 100바이트 수준이라 룸 하나의 대역폭이 사실상 0이다.
**성능 문제는 전부 결정론 문제로 치환됐다.** 그래서 `simulation.md` §9의 테스트가 이 프로젝트의 실질적 안전망이다.

---

## 2. 왜 lockstep인가

| 대안 | 검토 결과 |
|---|---|
| **결정론적 lockstep** ✅ | 대역폭 최소. 리플레이가 공짜. 관전이 공짜. 대신 결정론이 깨지면 즉시 치명적 |
| 서버가 지형 diff 전송 | 큰 붕괴 한 번에 수만 셀이 바뀐다. RLE로 줄여도 턴당 수십 KB. lockstep 대비 이득이 전혀 없다 |
| 서버가 궤적 폴리라인만 전송 | 지형은 어차피 클라가 계산해야 한다. 절반만 lockstep이면 결정론 요구는 그대로인데 이득만 없다 |
| P2P lockstep (서버 없음) | 치팅 검증 불가. 한 명 끊기면 판이 멈춘다 |

**서버도 동일 시뮬레이션을 돌린다.** 서버는 lockstep의 참가자가 아니라 **심판**이다.
서버 결과가 진실이고, 클라이언트 체크섬이 다르면 클라이언트가 틀린 것이다.

---

## 3. 턴 수명주기

매치 시작 시 서버는 `matchInit` 뒤 **초기 `fullState` 한 번**을 보내고 첫 `turnBegin`을 연다.
Canvas 클라이언트가 맵 생성 구현이나 로딩 타이밍과 무관하게 동일한 기준 격자에서 시작하게 하는
부트스트랩 경로다. 이후 정상 턴에서는 격자를 보내지 않고 intent와 결과 체크섬만 교환한다.

```
       ┌─────────────────────────────────────────┐
       │  TURN_BEGIN                              │
       │  서버 → 전원 : turnNo, activeSlot,       │
       │               deadline, wind             │
       └──────────────────┬──────────────────────┘
                          ↓
       ┌─────────────────────────────────────────┐
       │  AIM  (20s)                              │
       │  활성 클라 → 서버 : intent               │
       │  다른 클라는 관전만 한다                  │
       └──────────────────┬──────────────────────┘
                          ↓ 확정 or 타임아웃
       ┌─────────────────────────────────────────┐
       │  TURN_RESOLVE                            │
       │  서버 → 전원 : activeSlot, intent,        │
       │               turnSeed                   │
       │  서버: 한 발의 전체 해결 계산             │
       │  클라: 같은 계산을 60fps로 재생           │
       └──────────────────┬──────────────────────┘
                          ↓ 서버 계산 완료
       ┌─────────────────────────────────────────┐
       │  TURN_RESULT                             │
       │  서버 → 전원 : 체크섬, HP, 사망, 골드    │
       │  클라: 자기 계산 결과와 대조              │
       └─────────────────────────────────────────┘
```

### 3.1 서버는 클라이언트 재생을 기다리지 않는다

서버는 `TURN_RESOLVE`를 보낸 직후 계산을 끝내고 `TURN_RESULT`까지 곧바로 보낸다.
클라이언트는 애니메이션을 재생하는 동안 이미 결과를 손에 쥐고 있다.

**다음 턴 시작만 클라이언트 재생이 끝날 때까지 기다린다.**

```
next_turn_delay = max(모든 클라의 예상 재생 시간, 서버 최소 대기)
단, 상한 8초. 넘으면 그냥 진행한다.
```

느린 클라이언트 하나가 판 전체를 잡아두면 안 된다. 재생을 못 따라온 클라는 결과 상태로 스냅한다.

### 3.2 조준 초안을 중계하지 않는 이유

`AIM` 단계에서는 활성 플레이어의 확정 전 각도·파워를 중계하지 않는다. 초안은 매 프레임 바뀌는
표현 상태이고 lockstep 입력이 아니기 때문이다. 확정 또는 타임아웃 뒤 `TURN_RESOLVE`에서 intent를
전원에게 공개하며, 다른 플레이어는 그 한 발의 비행·착탄·정착을 본 뒤 자기 턴을 시작한다.

---

## 4. 리싱크

### 4.1 트리거

| 상황 | 처리 |
|---|---|
| 체크섬 불일치 | 클라가 `RESYNC_REQ` → 전체 상태 수신 |
| 재접속 | 접속 시 전체 상태 수신 |
| 관전자 입장 | 전체 상태 수신 |

### 4.2 전체 상태 페이로드

```
mapSeed, turnNo, activeSlot, phase, 전원 상태(위치·HP·인벤토리·골드), wind
+ 지형 격자 (gzip 압축)
```

격자는 압축 전 **518,400 바이트**이고 값이 6종(`EMPTY` 포함)뿐이며 공간 상관이 극단적으로 높다.
어떤 범용 압축을 써도 잘 줄어든다. 리싱크가 빈번하지 않은 한 문제되지 않는다.

#### 격자 직렬화 형식

| 항목 | 값 |
|---|---|
| 논리 형식 | `MaterialGrid` 바이트 배열. `idx = y*960 + x` 오름차순 (`terrain.md` §1) |
| 압축 전 길이 | **정확히 518,400 바이트.** 상수다 |
| 값 범위 | 0~5 (`terrain.md` §2 의 재질 enum). 그 밖의 값은 프로토콜 위반 |
| 와이어 타입 | msgpack `bin` |
| 부분 전송 | 없다. 격자는 항상 전체를 보낸다 |

**수신 측은 길이가 518,400 인지, 모든 값이 0~5 인지 검사한 뒤 적용한다.**
길이가 상수라서 검사가 공짜이고, 여기서 거르지 않으면 잘린 격자를 그대로 채택해
**그 다음 턴부터 매 턴 체크섬 불일치**로 증상이 나타난다 — 원인 추적이 가장 어려운 형태다.

**격자를 적용한 뒤 활성 행 마스크는 비운 상태로 시작한다.** `terrain.md` §5.1·§5.2 대로
마스크와 스텝 카운터는 턴을 넘기지 않으므로 페이로드에 넣지 않는다.
격자에서 마스크를 재계산해서도 안 된다 — 서버와 갈라진다.

`uAge` 격자를 함께 보낼지는 `decisions.md` B8. 격자는 **gzip**으로 압축한다. 브라우저의 표준
`DecompressionStream("gzip")`을 바로 쓸 수 있고, 리싱크는 정상 턴 경로가 아니므로 zstd 대비 압축률
차이보다 무의존성이 중요하다.

### 4.3 체크섬 불일치는 버그다

조용히 복구만 하고 넘어가지 않는다.

```
텔레메트리로 반드시 전송 : mapSeed, turnNo, activeSlot, intent, 클라 체크섬, 서버 체크섬,
                          클라 빌드 해시, 브라우저/OS
```

이 로그만 있으면 로컬에서 정확히 재현할 수 있다. **재현 가능한 리플레이가 결정론 버그의 유일한 해결 수단이다.**
`RESYNC` 발생률을 대시보드 최상단 지표로 둔다. 이 숫자가 0이 아니면 다른 작업보다 우선한다.

---

## 5. 프로토콜

msgpack. 모든 메시지는 `{t: <type>, ...}` 형태.

### 5.0 와이어 표기 규약

**필드마다 타입·폭·단위를 적는다.** 이게 없으면 Python 이 `int`, TS 가 `number` 로 보내고
어느 쪽이 어디서 잘랐는지 아무도 모르는 상태가 된다. lockstep 에서 그건 곧 갈라짐이다.

| 규약 | 내용 | 근거 |
|---|---|---|
| 부동소수점 금지 | 와이어에도 `float` 를 싣지 않는다. 모든 수치는 정수 | 절대 규칙 2, `simulation.md` §2.1 |
| 위치·속도 | subpx 정수 (`1 px = 16 subpx`) | `simulation.md` §2.1 |
| 각도 | 데시도 정수 0~1800 (각도 × 10) | `simulation.md` §3 |
| 비율·확률 | Q8 정수 0~256 | `terrain.md` §4.1 |
| 시각·기간 | ms 정수 | — |
| 시드·체크섬 | `uint32` | `terrain.md` §7.1 의 `hash32` 정의역, §7.2 |
| 격자 | msgpack `bin`. 재질 enum 0~5 의 바이트 배열 | `terrain.md` §1·§2 |

**배열은 슬롯 번호 오름차순으로 정렬해 보낸다.** `players[]`, `scores[]`가 해당한다.
한 턴의 `intent`는 `activeSlot` 한 명의 값이므로 배열이 아니다. 슬롯 번호 자체의 정의·할당 주체는
`decisions.md` B10이다.

**버전 필드는 두 개이고 수명주기가 다르다.**

| 필드 | 무엇 | 언제 바뀌나 |
|---|---|---|
| `protocolVersion` | 와이어 형식 신원. `constants.PROTOCOL_VERSION` (현재 `2`) | 메시지 구조가 바뀔 때. 손으로 올린다 |
| `simVersion` | 시뮬레이션 규칙 신원. `constants.SIM_VERSION`. §7.3 | 상수가 하나라도 바뀔 때. 자동 |

메시지 구조만 바뀐 릴리스에서 `simVersion` 이 흔들려선 안 되고, 상수만 바뀐 릴리스에서
`protocolVersion` 이 그대로여야 한다. `server/src/talus/constants.py` 가 이 분리를 이미 구현하고 있다
(`_EXCLUDED_FROM_HASH` 가 `PROTOCOL_VERSION` 을 해시에서 뺀다).

### 5.1 클라이언트 → 서버

WebSocket 경로는 `/ws/rooms/{roomCode}`다. 업그레이드 쿼리에 `token`, `protocolVersion`,
`simVersion`, `buildHash`를 보낸다. 개발 로비의 token은 256비트 불투명 문자열이며 매치 시작 뒤에도
같은 슬롯으로 재접속하는 키다.

| `t` | 필드 | 타입·폭 | 단위·범위 | 설명 |
|---|---|---|---|---|
| `intent` | `turnNo` | uint32 | — | 현재 턴이어야 한다(§5.3) |
| | `activeSlot` | uint8 | 0~5 | `turnBegin.activeSlot`과 같아야 하며, 송신자의 슬롯이어야 한다 |
| | `angle10` | uint16 | 차체 기준 데시도 0~1800 | 월드 발사각은 `angle10 - tankTilt10`. 상한은 `trig.bin` 배열 경계 |
| | `power` | uint16 | 0~1000 | `v0 = (power * POWER_SCALE) >> 10` 의 정의역 |
| | `weaponId` | uint8 | — | 무기 테이블 인덱스. 테이블 스키마는 `decisions.md` C1 |
| | `moveDx` | int16 | cell | 연료 이동 의도. `docs/match.md` §5.1 |
| | `useShield` | bool | — | 이번 턴 차폐막 사용 |
| `playbackDone` | `turnNo` | uint32 | — | 해당 턴의 로컬 재생 완료 |
| | `checksum` | uint32 | — | 로컬 최종 격자 체크섬. 불일치면 `desync` + `fullState` |
| `buy` | `roundNo` | uint8 | — | 현재 상점 라운드 |
| | `kind` | str enum | `weapon`/`item` | 한 요청에 하나만 구매 |
| | `weaponId` | uint8 | — | `kind=weapon`일 때 |
| | `itemKey` | str enum | shield/parachute/fuel/anemo | `kind=item`일 때 |
| `shopReady` | `roundNo` | uint8 | — | 구매 완료. 전원 ready 또는 30초 뒤 다음 라운드 |
| `resyncReq` | `turnNo` | uint32 | — | |
| | `myChecksum` | uint32 | — | 격자 체크섬 (`terrain.md` §7.2) |
| `pong` | `t0` | uint64 | ms | `ping`(§5.2)이 보낸 값을 그대로 반사한다 |

- **`join` 에 `simVersion` 이 없던 것은 표의 누락이다.** §7.3 이 이미 "join 시 클라가 simVersion 전송"을
  규정하고, 서버는 `GET /version` 으로 같은 값을 노출한다(`docs/development.md` §5).
  불일치 시 반환할 `error.code` 표는 `decisions.md` B10
- `turnNo` 는 매치 전역으로 증가하고 라운드가 바뀌어도 리셋하지 않는다 (`docs/match.md` §1.3)

### 5.2 서버 → 클라이언트

| `t` | 필드 | 타입·폭 | 단위·범위 | 설명 |
|---|---|---|---|---|
| `hello` | `protocolVersion`/`simVersion` | uint16/str | — | WebSocket 핸드셰이크 승인과 규칙 신원 |
| | `roomCode`/`mySlot`/`status` | str/uint8/str | — | 재접속한 룸·슬롯·현재 페이즈 |
| `roomState` | `roomCode`/`status`/`maxPlayers` | str/str/uint8 | — | 로비와 연결 상태 스냅샷 |
| | `players[]`/`telemetry` | 배열/map | — | 간소 플레이어 목록과 턴·리싱크 카운트 |
| `matchInit` | `mapSeed` | uint32 | — | `terrain.md` §7.1 `hash32` 의 `seed` 인자와 같은 폭이어야 한다 |
| | `mySlot` | uint8 | 0~5 | 수신자 자신의 슬롯. 슬롯 정의·할당은 `decisions.md` B10 |
| | `players[]` | 배열 | 슬롯 오름차순 | 스키마는 `decisions.md` B10 |
| | `rules` | map | — | 라운드 수·인원·모드. `decisions.md` B10 |
| `turnBegin` | `turnNo` | uint32 | — | 매치 전역 증가. 라운드에서 리셋하지 않음 |
| | `activeSlot` | uint8 | 0~5 | 이번 턴에 intent를 낼 수 있는 유일한 슬롯 |
| | `deadlineMs` | uint64 | Unix epoch ms | 라운드 첫 발 30초, 이후 20초 |
| | `wind` | int16 | subpx/tick² | 직전 바람과 `mapSeed, turnNo`에서 파생한 이번 턴 권위값. 평상시 변화 1, 돌풍 최대 3 |
| `turnResolve` | `turnNo` | uint32 | — | |
| | `activeSlot` | uint8 | 0~5 | `turnBegin`과 같아야 한다 |
| | `turnSeed` | uint32 | — | `= hash32(mapSeed, turnNo, 0, 0)`. **파생값이므로 표시·검증용 참고값이다** |
| | `intent` | map | — | §5.1 `intent`의 5개 게임 입력 필드. 활성 슬롯 한 명의 값 |
| `turnResult` | `turnNo` | uint32 | — | |
| | `checksum` | uint32 | — | **격자만.** `terrain.md` §7.2 |
| | `players[]` | 배열 | 슬롯 오름차순 | 스키마는 `decisions.md` B10 |
| | `events[]` | 배열 | — | 권위 표현·진단 이벤트. `t`와 해당 정수 필드로 구성 |
| | `phase` | str enum | aim/shop/done | 권위 매치 페이즈 |
| | `nextActiveSlot` | uint8/null | 0~5 | 다음 턴 슬롯. 라운드 종료면 null |
| `roundEnd` | `roundNo` | uint8 | — | |
| | `scores[]` | 배열 | 슬롯 오름차순 | 점수 공식은 `decisions.md` B7 |
| | `shopOpenMs` | uint32 | ms | 상점 30초(`game-design.md` §7) → `30000` |
| `roundStart` | `roundNo`/`wind` | uint8/int16 | —/subpx/tick² | 새 라운드 권위 상태 |
| | `spawnCells[]`/`players[]` | 배열/배열 | cell/슬롯 오름차순 | 재스폰 위치와 전체 플레이어 상태 |
| `matchEnd` | `finalScores[]` | 배열 | 슬롯 오름차순 | |
| `buyResult` | `ok` | bool | — | 구매 성공 여부 |
| | `player` | map | — | 요청 슬롯의 전체 권위 상태와 인벤토리 |
| `fullState` | `state` | map | — | `match.md` §1.3 전체 상태 |
| | `checksum` | uint32 | — | 압축 전 격자 체크섬 |
| | `gridGzip` | bin | gzip | 압축 해제 후 정확히 518,400바이트 |
| `desync` | `turnNo` | uint32 | — | 불일치 턴 |
| | `clientChecksum`/`serverChecksum` | uint32 | — | 텔레메트리와 복구 진입용 |
| `ping` | `t0` | uint64 | ms | 10초 간격(§6). 클라는 `pong` 으로 그대로 반사한다 |
| `error` | `code` | uint16 | — | 코드 표는 `decisions.md` B10 |
| | `msg` | str | — | 사람이 읽는 설명. **클라가 이 문자열로 분기하지 않는다** |

**`ping` 이 표에 없던 것은 누락이다.** §6 이 10초 간격 ping/pong 을 규정하고 §5.1 에 `pong` 이 있다.

### 5.3 공통 와이어 스키마

`players[]`는 `slot,name,x,y,hp,alive,buried,angle10,power,gold,weaponId,ammo[],items,
score,kills,damageDone,shieldUp,connected`를 가진다. `items`는
`shield,parachute,fuel,anemo` 정수 맵이다. 로비 `roomState.players[]`는 이 중
`slot,name,connected,host`만 보낸다.

슬롯은 서버가 로비 입장 순서대로 가장 낮은 빈 번호를 배정한다. 매치 시작 뒤 슬롯을 재사용하거나
압축하지 않는다. 연결이 끊겨도 token으로 같은 슬롯에 복귀한다.

### 5.4 코드형 로비 REST

| 메서드·경로 | 요청 | 응답·역할 |
|---|---|---|
| `POST /api/rooms` | `name,maxPlayers` | 룸 생성. `roomCode,token,slot,protocolVersion,simVersion,wsPath` |
| `POST /api/rooms/{code}/join` | `name` | 가장 낮은 빈 슬롯 참가와 재접속 token 발급 |
| `GET /api/rooms/{code}` | — | 현재 `roomState` 조회. 개발·진단용 |
| `POST /api/rooms/{code}/start` | `token` | 호스트 시작. WebSocket `start`와 같은 개발 편의 경로 |

### 5.5 오류 코드

| code | 이름 | 의미 |
|---:|---|---|
| 1000 | BAD_MESSAGE | msgpack/필드 형식 오류 |
| 1001 | ROOM_NOT_FOUND | 룸 코드 없음 |
| 1002 | ROOM_FULL | 정원 초과 |
| 1003 | TOKEN_INVALID | 재접속 token 불일치 |
| 1004 | VERSION_MISMATCH | protocol/sim 버전 불일치 |
| 1005 | NOT_HOST | 호스트 전용 요청 |
| 1006 | ROOM_STARTED | 시작 뒤 로비 변경 요청 |
| 1007 | NOT_ACTIVE | 활성 슬롯이 아닌 intent |
| 1008 | TURN_MISMATCH | turnNo가 현재 턴과 다름 |
| 1009 | BAD_PHASE | 현재 페이즈에서 허용되지 않는 요청 |
| 1010 | PURCHASE_REJECTED | 골드·대상·탄약 규칙으로 구매 거절 |
| 1011 | INTERNAL | 서버 내부 오류. 상세 예외는 클라에 노출하지 않음 |

### 5.6 `checksum` 의 정의

**지형 격자만이다.** `terrain.md` §7.2 가 확정했으므로 여기서는 참조만 한다.

| 항목 | 값 |
|---|---|
| 알고리즘 | FNV-1a 32bit |
| 입력 | `MaterialGrid` 바이트 518,400개, `idx = y*960 + x` 오름차순 |
| 폭 | `uint32` |
| 계산 시점 | **최종 정착 완료 직후.** 정착 후 연결성 검사가 `ROCK`→`SCREE` 변환을 만들어 정착이 재개되면(`terrain.md` §6.1) 그 마지막 정착 뒤에 계산한다 |
| 제외 | 활성 행 마스크, 자동자 스텝 카운터 — `terrain.md` §5.2 대로 턴을 넘기지 않으므로 상태가 아니다 |
| 제외 | 탱크 위치·HP·골드·인벤토리 |

**플레이어 상태는 체크섬에 섞지 않고 `turnResult.players[]` 로 직접 대조한다.**
근거: 지형이 갈라진 것과 피해 정산이 갈라진 것은 복구 비용이 전혀 다른 두 문제다.
한 값에 섞으면 불일치가 났을 때 519 KB 격자를 다시 받는 것 말고 할 수 있는 일이 없어진다.
대조가 실패했을 때의 처리는 `decisions.md` B10.

`resyncReq.myChecksum` 도 같은 값이며, 같은 시점에 계산한 것이어야 한다.

### 5.7 intent 검증

서버는 `intent`를 반드시 검증한다.

```
turnNo가 현재 턴인가
angle10 ∈ [0, 1800]
power ∈ [0, 1000]
weaponId를 실제로 보유하고 있는가, 탄약이 남았는가
이미 이번 턴에 확정하지 않았는가
플레이어가 살아있는가
```

검증 실패 시 **필드별로 직전 턴 값을 사용한다.** 무효/소진 무기는 직전 무기, 그것도 소진이면
표준탄으로 폴백한다. 첫 턴은 탱크 기본 각도·파워·표준탄을 쓴다. 연결을 끊지 않는다.
근거: 버그로 잘못된 값이 나갈 수도 있는데 그때마다 판에서 튕기면 사용자 경험이 최악이다.
단, 검증 실패율은 텔레메트리로 수집해 치팅 시도를 탐지한다.

---

## 6. 연결 관리

| 항목 | 처리 |
|---|---|
| 조준 중 끊김 | 직전 턴 값으로 자동 발사. 자리 유지 |
| 60초 이상 끊김 | Phase 4 기반에서는 직전 값 자동 발사를 유지. AI 인계는 Phase 6 |
| 재접속 | `fullState` 수신 후 즉시 복귀 |
| 하트비트 | 10초 간격 ping/pong |
| 룸 유휴 | 전원 이탈 후 60초에 파기 |

**끊긴 사람을 즉시 제거하지 않는다.** 6인전에서 한 명이 사라지면 지형 서사가 무너지고 밸런스가 깨진다.
AI 인계가 훨씬 낫다.

---

## 7. 인프라

**Bulwark의 인프라 문서를 그대로 재사용한다.** 틱 루프 관련 부분만 걷어내면 된다.

| 항목 | 구성 |
|---|---|
| 룸 서버 | EKS StatefulSet + 룸 어피니티 라우팅 |
| 로비 | stateless Deployment. 매치메이킹 후 JWT 발급 |
| 룸 상태 | Redis |
| 전적/상점 | PostgreSQL |
| 드레이닝 | 신규 룸 배정 중단 → 진행 중 매치 종료 대기 → 파드 종료 |

### 7.1 Bulwark 대비 완화되는 것

- **30Hz 스냅샷 브로드캐스트가 없다.** 룸당 CPU와 대역폭이 한 자릿수 퍼센트 수준
- 파드당 수용 룸 수가 훨씬 많다
- 지연 시간 요구가 낮아 리전 배치가 자유롭다

### 7.2 대신 새로 생기는 것

- **서버가 턴당 시뮬레이션을 한 번에 계산한다.** 대형 붕괴가 있는 턴은 수백 ms의 CPU 스파이크가 생긴다
- 이걸 이벤트 루프에서 그냥 돌리면 같은 파드의 다른 룸이 전부 멈춘다

> **턴 해결 계산은 반드시 별도 프로세스 풀에서 돌린다.**
> `ProcessPoolExecutor` 또는 전용 워커. `sim/`이 순수 함수이므로 프로세스 경계를 넘기기 쉽다 —
> 입력은 `(state, intent, seed)`, 출력은 `(new_state, events)`뿐이다.
> **순수성 제약이 여기서 실질적인 이득으로 돌아온다.**

### 7.3 클라이언트 빌드 해시

`sim/` 코드가 바뀌면 결정론이 바뀔 수 있다. 서버와 클라이언트의 **시뮬레이션 버전**을 명시적으로 맞춘다.

```
join 시 클라가 simVersion 전송 → 서버와 불일치하면 새로고침 유도
```

**`simVersion` 은 상수 집합과 `RULES_VERSION`의 해시다.** `server/src/talus/constants.py` 의
`SIM_VERSION` — 해시 대상 상수 전체를 정렬 JSON 으로 직렬화한 SHA-256 의 앞 16자리다
(`docs/development.md` §5). 상수값이 그대로인 절차·알고리즘 변경은 `RULES_VERSION`을 올린다.

**이전 판의 정의("`client/src/sim/` 전체 + `tables/trig.bin` 의 해시")는 성립할 수 없다.**
핸드셰이크는 두 값이 **같은지**를 보는데, TypeScript 소스의 해시와 Python 소스의 해시가
같아질 방법이 없다. 서버는 `client/src/sim/` 을 해시할 수도 없다. 대조 대상은
**양쪽이 같은 문서 표를 구현하면 같은 값이 나오는 것**, 즉 상수 집합의 해시여야 한다.

양쪽이 같은 값을 내려면 정규화 규칙도 같아야 한다. `constants.py` 의 구현이 기준이다.

| 단계 | 규칙 |
|---|---|
| 대상 | 대문자 상수 전체에서 `SIM_VERSION`·`PROTOCOL_VERSION`·`PROVISIONAL`·`TRIG_TABLE_PATH` 를 뺀다 (화이트리스트가 아니라 **블랙리스트** — 상수를 추가했는데 해시가 안 바뀌는 사고를 막는다) |
| dict 값 | 키를 문자열로 바꾸고 키 오름차순 |
| 직렬화 | JSON, 키 정렬, 구분자에 공백 없음 (`","` / `":"`) |
| 해시 | SHA-256, 앞 16자 소문자 hex |

`SUBSTEPS` 는 대상에 없다 — `terrain.md` §3.4 대로 표현 상수이므로, 값이 다른 두 클라이언트도
같은 방에 들어갈 수 있어야 한다.

**빌드 신원은 `buildHash` 라는 별도 필드로 분리하고 대조하지 않는다.**
§4.3 의 텔레메트리 항목이 이미 "클라 빌드 해시"를 따로 요구한다. 이걸 대조에 쓰면
클라 릴리스마다 접속이 전부 거부된다.

접속 전에 `GET /version` 으로 서버 값을 미리 볼 수 있다(`docs/development.md` §5).

> `RULES_VERSION` 갱신을 잊는 사고는 교차 골든 CI가 잡는다. 런타임 게이트와 실증 게이트를
> 둘 다 유지한다 (`decisions.md` B9).

---

## 8. 미결 항목

- [ ] 재생 대기 상한 8초의 적정성 (§3.1)
- [ ] AI 인계 시점 60초의 적정성
- [ ] 관전 모드에서 활성 플레이어의 확정 전 조준 초안을 보여줄지
- [ ] 리플레이 저장 — `mapSeed + 시간순 intent`만 저장하면 되므로 매우 저렴하다. 어느 단계에서 넣을지
- [ ] 랭크 매치에서 `simVersion` 불일치 시 매치 무효 처리 여부
- [ ] **상수는 같고 `sim/` 코드만 다른 빌드를 무엇이 잡는가** (§7.3) — `decisions.md` B9
- [ ] **한 턴 재생 길이의 상한과 §3.1 의 8초** — 비행 상한 30초(`MAX_FLIGHT_TICKS = 1800`)에
      단발의 다중 자탄 정착 시간까지 더하면 8초 상한으로 담기지 않는 경우가 있다
- [ ] **"직전 턴 값"이 없을 때의 폴백** (§5.3, §6) — 라운드의 첫 턴, 부활 직후, 직전 무기 탄약 소진
