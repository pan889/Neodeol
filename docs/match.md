# 매치 진행 기준선

Phase 3에서 TypeScript와 Python이 **같은 라운드·턴·경제·승패 결과**를 내기 위한 명세다.
`tools/prototype/match.js`에서 이미 플레이 가능한 절차를 가져오되, AI는 Phase 6 범위라 제외한다.

여기의 수치는 최종 밸런스가 아니라 `MATCH_VERSION = 5`의 잠정 기준선이다. 값을 바꾸면
`MATCH_VERSION`, `server/src/talus/constants.py`, match 골든을 함께 갱신한다.

---

## 1. 상태

### 1.1 의도

```text
Intent {
  angle10:   0..1800
  power:     0..1000
  weaponId:  무기 테이블 인덱스
  moveDx:    이동하려는 셀 수. 음수는 왼쪽
  useShield: 이번 턴 차폐막 사용 여부
}
```

검증 실패 필드는 직전 확정값으로 대체한다. 직전 무기의 탄약이 없거나 무효면 표준탄 `0`으로
폴백한다. 첫 턴의 직전 값은 `makeTank()` 기본값인 각도 `450/1350`, 파워 `600`, 표준탄이다.

### 1.2 플레이어

`Player`는 `ballistics.Tank` 필드에 아래를 더한다.

```text
isAI, gold, weaponId, ammo[weaponId],
items { shield, parachute, fuel, anemo },
score, kills, damageDone, intent, shieldUp
```

- 표준탄 탄약 배열 값은 `-1`, 조회값은 `AMMO_INFINITE = 0x7FFFFFFF`다.
- 배열과 플레이어는 항상 슬롯 오름차순이다. 슬롯은 `0..playerCount-1` 연속이다.
- `score`·`gold`·탄약·아이템은 라운드 사이에 이월한다.

### 1.3 매치

```text
MatchState {
  mapSeed, roundNo, turnNo, roundTurn, activeSlot, wind,
  spawnCells[], players[], phase, over
}
```

- `turnNo`는 **발사 한 번마다** 매치 전체에서 증가하고 라운드가 바뀌어도 리셋하지 않는다.
- `roundTurn`도 발사 한 번마다 증가하며 라운드 시작 시 `0`으로 돌아간다.
- `activeSlot`만 intent를 제출한다. 사망 슬롯은 건너뛰고 슬롯 오름차순으로 순환한다.
- `phase`는 `aim | shop | done`이다. 해결·정착은 순수 함수 호출 한 번 안에서 끝낸다.

---

## 2. 잠정 상수

| 이름 | 값 |
|---|---:|
| `MATCH_ROUNDS` | 5 |
| `ROUND_TURN_CAP` | 40 |
| `START_GOLD` | 1500 |
| `GOLD_PER_DAMAGE` | 8 |
| `GOLD_PER_KILL` | 400 |
| `GOLD_SURVIVE` | 300 |
| `GOLD_LAST_PLACE_BONUS` | 250 |
| `KILL_SCORE` | 100 |
| `DAMAGE_SCORE` | 1 |
| `SURVIVE_SCORE` | 50 |
| `FUEL_CELLS_PER_UNIT` | 14 |
| `MOVE_MAX_STEP_UP` | 6 cells |

상점 수치와 최초 상점 시점은 `decisions.md` C6가 아직 미결이다. Phase 3 기준선은 프로토타입과
같이 **라운드 1을 즉시 시작하고 첫 상점은 라운드 1 종료 뒤** 연다.

---

## 3. 시드와 바람

```text
turnSeed = hash32(mapSeed, turnNo, 0, 0)
roll     = hash32(mapSeed ^ 0x5715, turnNo, previousWind, 0) % 20
delta    = roll == 0 ? -3 : roll == 19 ? +3 : gentle(roll)
wind     = reflect(previousWind + delta, -WIND_MAX, +WIND_MAX)
```

- 첫 턴은 `previousWind = 0`에서 시작하며, 이후 **매 턴** 다음 바람을 파생한다.
- `gentle(roll)`은 나머지 18개 값에서 `-1/0/+1`을 반환한다.
- 전체의 90%는 완만한 변화, 10%는 `±3` 돌풍이다.
- `reflect`는 `±WIND_MAX`를 넘은 만큼 경계 안쪽으로 되돌린다. 실제 턴 변화량은 최대 3이다.
- 각 턴의 정착 시작 전에 `terrain.seed = turnSeed`, `terrain.step = 0`으로 둔다.
- 연결성 재검사로 정착을 재개할 때는 같은 턴 안이므로 `step`을 리셋하지 않는다.

---

## 4. 매치 초기화

```text
buildMap(mapSeed)
→ 초기 연결성 검사
→ step=0, 전체 활성, 초기 정착
→ chooseSpawnCells(settledGrid, playerCount)
→ 플레이어 생성·배치
→ roundNo=1, turnNo=0, roundTurn=0, activeSlot=0, phase=aim
```

라운드가 끝나도 지형은 유지한다. 다음 라운드 스폰은 **현재 정착 지형**에서 다시 고르고,
탱크만 HP 100으로 부활시킨다.

---

## 5. 한 턴 해결 순서

순서는 고정한다.

1. `activeSlot` 플레이어의 intent 하나를 검증·확정
2. 해당 플레이어의 이동과 차폐막 사용
3. 좌우 궤도 지지점에서 차체 경사를 파생하고, 상대 조준각을 월드 발사각으로 바꿔 탄도·자탄·폭발 지점 확정
4. 카빙 전 위치에서 그 발의 모든 직접 피해 계산
5. 자탄 순서대로 모든 카빙·적층 적용
6. 연결성 검사 정확히 1회
7. 직접 피해 합산 적용
8. `step=0`으로 정착, 연결성 변환이 있으면 같은 예산 안에서 재개
9. 탱크 재배치 → 낙하 피해 → 매몰 재평가·피해 → 사망 판정

   재배치는 매몰률이 `BURIAL_PERMILLE`(800‰) 밑으로 내려갈 때까지 밀어올린다.
   **매몰 판정과 같은 임계다** — 다르게 두면 그 사이 구간에 갇혀 나올 수 없다
   (`decisions.md` B13).
10. 라운드 종료 판정. 계속되면 다음 생존 슬롯 선택, 격자 체크섬 계산

한 턴의 정상 네트워크 입력은 `mapSeed + turnNo + activeSlot + intent`다. 착탄·피해·골드는 입력이 아니다.

### 5.1 이동

- 연료 한 개는 `14`셀 예산이다.
- 현재 표면보다 다음 열 표면이 `6`셀보다 더 높으면 그 앞에서 멈춘다.
- 내려가는 이동은 허용하고, 최종 위치는 `reseatTank()`가 낙하시킨다.
- **그 낙하도 낙하 피해를 받는다.** 원인이 지형 붕괴든 스스로 걸어 내려간 것이든 같다.
  낙하산도 똑같이 발동한다. 다만 유발한 발사가 없으므로 **피해 귀속 대상이 없고**
  (`by: null`) 아무도 골드를 받지 않는다 — 이 시점에는 이번 턴의 폭발이 아직 없다.
  판정은 `applyFall()` 한 군데서만 한다. §5 step 9 와 같은 함수다.
- 실제 이동량을 `ceil(movedCells / 14)`한 만큼 연료를 쓴다. 정수 `floorDiv`로 계산한다.

### 5.2 피해 귀속

- 직접 피해는 각 폭발 소유자에게 귀속한다.
- 차폐막은 첫 피격 한 번을 막고 즉시 내려간다.
- 낙하·매몰 피해는 이번 턴 **마지막 폭발의 소유자**에게 귀속한다.
- 자살은 킬로 세지 않지만 자신에게 준 피해 골드는 Phase 3 프로토타입과 동일하게 유지한다.

마지막 폭발 귀속은 분열탄 등 한 발 안의 다중 폭발에 적용한다. `decisions.md` C10의 잠정안이며
비례 분배로 바꾸면 규칙 변경이다.

---

## 6. 라운드와 경제

라운드는 생존자가 1명 이하가 되면 끝난다. 0명이면 전멸 무승부다.
`ROUND_TURN_CAP`에 닿으면 생존자 중 HP가 가장 높은 슬롯이 승자이고 동률이면 무승부다.
여기서 턴 상한은 **개별 발사 횟수**다.

라운드 정산:

```text
score += kills * 100 + damageDone * 1
생존 시 score += 50, gold += 300
```

그 뒤 누적 점수 오름차순, 동점은 슬롯 오름차순으로 정렬하고 아래에서부터
`(playerCount - 1 - rank) * 250` 골드를 지급한다. 정산 뒤 `kills`와 `damageDone`은 0으로
리셋한다.

- 직접·낙하·매몰 피해: 가해자에게 피해 1당 8골드
- 타 플레이어 킬: 400골드
- 무기 구매: 가격 지불 후 해당 탄약 1 증가
- 아이템 구매: 가격 지불 후 수량 1 증가
- 표준탄은 구매할 수 없다.
- 핵포탄은 초기 탄약 0발, `4,800G`이며 구매 1회당 1발만 증가한다 (`decisions.md` B15).

5라운드 종료 시 최고 누적 점수 슬롯들을 `winners[]`로 돌려준다. 동점 타이브레이커는 아직
결정하지 않고 공동 선두로 남긴다.

---

## 7. 공개 API

양쪽 구현은 이름 표기만 언어 관례에 맞추고 같은 절차를 제공한다.

```text
makePlayer / normalizeIntent / setIntent
ammoOf / canFire / effectiveWeapon / buyWeapon / buyItem
applyMove / resolveTurn / applyDetonations / settleTerrain / applyPhase
roundOutcome / closeRound / beginRound / matchLeaders
deriveTurnSeed / deriveWind
createMatch / nextAliveSlot / resolveMatchTurn / startNextRound
```

`resolveMatchTurn(state, intent)`는 활성 플레이어 한 명의 턴 전체를 계산하고
궤적·폭발·이벤트·정착 통계·라운드 결과를 반환한다.
렌더러는 결과를 시간에 나눠 보여도 되지만 상태 변경 순서를 바꾸면 안 된다.

---

## 8. 검증

`kind = "match"` 골든은 사이드카 없이 `mapSeed + player specs + activeSlot별 intent + purchases`만 기록한다.
각 턴에서 아래를 TS와 Python이 대조한다.

1. `turnSeed`, 바람, 정착 스텝 수
2. 궤적 조각 해시와 폭발 위치
3. 이벤트, HP·위치·탄약·아이템·골드·점수
4. 라운드 종료 원인과 다음 라운드 스폰
5. 격자 체크섬과 질량
