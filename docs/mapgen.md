# 초기 맵 생성

`mapSeed` 하나에서 Python 서버와 TypeScript 클라이언트가 **비트 단위로 같은 초기 격자**를
만드는 명세다. `docs/netcode.md` 의 `matchInit.mapSeed` 가 이 문서의 유일한 입력이다.

이 문서는 Phase 3의 결정론적 기준선이다. Phase 6에서 지형 종류를 늘릴 수 있지만,
규칙을 바꾸면 `MAPGEN_VERSION`과 골든 리플레이를 함께 갱신한다.

---

## 1. 공개 API

```text
buildMap(mapSeed: uint32) -> MaterialGrid[960 * 540]
chooseSpawnCells(grid, playerCount: 2..6) -> cellX[]
```

- `buildMap`은 새 격자를 반환하고 전역 `MaterialGrid`를 수정하지 않는다.
- 생성 직후 호출자가 격자를 sim에 적재하고, `seed = mapSeed`, `step = 0`, 전 행 활성으로
  정착시킨다. 정착 후 연결성 재검사 루프까지 끝나야 초기 상태가 확정된다.
- 스폰은 **정착이 끝난 격자**에서 선택한다. 생성 전 표면을 기준으로 잡으면 첫 정착 뒤 탱크가
  공중에 남거나 서로 가까워질 수 있다.

---

## 2. 금지 사항

- float, `Math.random()`, `random.*`, 런타임 노이즈 라이브러리 금지
- 언어별 라이브러리 보간 함수 금지
- `set`/`dict` 순회 순서에 의존하는 배치 금지
- 생성 직후 전체 격자를 네트워크로 보내는 정상 경로 금지

난수는 전부 `terrain.md` §7.1의 `hash32`를 좌표 해시로 사용한다.

---

## 3. 지표면

상수:

| 이름 | 값 |
|---|---:|
| `MAPGEN_VERSION` | 1 |
| `NOISE_SHIFT` | 7 |
| `SURFACE_BASE` | 170 cells |
| `SURFACE_AMP` | 60 cells |
| `BEDROCK_Y` | 522 |

열 `x`의 지표면은 128셀 간격 정수 값노이즈로 만든다.

```text
i  = x >> 7
f  = x & 127
a  = hash32(mapSeed, i,     0x4D47, 0) & 0xFFFF
b  = hash32(mapSeed, i + 1, 0x4D47, 0) & 0xFFFF
n  = a + (((b - a) * f) >> 7)
y0 = 170 + (((n - 32768) * 60) >> 16)
```

`y0`는 `96..260`으로 clamp한다. 모든 연산은 부호 있는 정수 산술 시프트다.

---

## 4. 지층

각 열에서 `y0`부터 아래 순서로 채운다.

| 순서 | 재질 | 두께 |
|---:|---|---:|
| 1 | `SAND` | 18 |
| 2 | `SOIL` | 28 |
| 3 | `SAND` | 10 |
| 4 | `SCREE` | 12 |
| 5 | `SOIL` | 40 |
| 6 | `ROCK` | `BEDROCK_Y`까지 |
| 7 | `BEDROCK` | `y >= 522` |

지층 두께는 Phase 3 기준선이다. 값 변경은 규칙 변경이며 골든을 재생성한다.

---

## 5. 기반암 앵커

후반에 맵 전체가 평평해지는 것을 막기 위해 기반암 기둥 4개를 묻는다.

```text
baseX  = [160, 320, 640, 800][i]                 // i = 0..3
jitter = (hash32(mapSeed, i, 0xA11C, 0) & 31) - 15
x      = clamp(baseX + jitter, 24, 935)
top    = clamp(surface[x] + 96, 220, 500)
```

`x-3 .. x+2`, `top .. 539`를 `BEDROCK`으로 채운다. 최하단 기반암층과 연결되므로
연결성 검사의 영구 앵커가 된다.

기준점과 지터 범위는 아래 암반 아치의 최대 범위 `x=345..615`와 겹치지 않게 고정한다.
생성 순서는 지층 → 기반암 앵커 → 암반 아치 → 좌우 봉인이다.

---

## 6. 암반 아치

모래 자동자의 구조 붕괴를 첫 맵부터 검증할 수 있도록 암반 아치 하나를 넣는다.

```text
center = 480 + ((hash32(mapSeed, 0, 0xA2C4, 0) & 127) - 63)
left   = center - 72
right  = center + 72
roofY  = max(surface[left..right]) + 24
```

- 지붕: `x = left..right`, `y = roofY..roofY+7`을 `ROCK`
- 빈 공간: `x = left+8..right-8`, `y = roofY+8..roofY+56`을 `EMPTY`
- 다리: 좌우 8열을 `roofY..legBottom`까지 `ROCK`
- `legBottom = max(roofY+64, surface[left]+112, surface[right]+112)`, 상한 510

다리는 아래 `ROCK`층에 닿고, 한쪽 다리만 끊으면 버티며 두 다리가 모두 끊기면 지붕이
`SCREE`로 변환되어 무너진다. `BEDROCK`으로 만들지 않는 이유는 파괴 가능해야 하기 때문이다.

---

## 7. 좌우 봉인

`terrain.md` §1.1대로 최외곽 2열을 봉인한다.

- 왼쪽은 `x=2`, 오른쪽은 `x=957`의 최초 비-`EMPTY` 행을 기준으로 한다.
- `x=0,1,958,959`를 그 행부터 바닥까지 `BEDROCK`으로 채운다.
- 인덱스 래핑으로 이웃 열을 읽지 않는다.

---

## 8. 초기 정착

호출 순서는 고정한다.

```text
grid = buildMap(mapSeed)
terrain.seed = mapSeed
terrain.resetGateCache()
terrain.connectivity()
terrain.markAll()
terrain.step = 0
정착 → 연결성 재검사 → 필요하면 정착 재개
```

- 자동자 스텝 예산은 `MAX_SETTLE_STEPS`를 공유한다.
- 연결성 재개 상한은 `CONNECTIVITY_MAX_ROUNDS`다.
- 초기 정착이 강제 종료에 걸리면 그 맵은 생성 실패다. 정상 매치에 사용하지 않는다.

---

## 9. 스폰 선택

플레이어 수 `n`은 2~6이다. 목표 열은 균등 배치한다.

```text
target(i) = ((i + 1) * 960) // (n + 1)
```

각 목표에서 `±72`열을 탐색한다. 후보 `x`의 점수:

```text
y  = surface(x)
flat = abs(surface(x-6) - y) + abs(surface(x+6) - y)
score = flat * 256 + abs(x - target)
```

- 후보 범위는 `16..943`으로 clamp한다.
- 이미 고른 스폰과 96셀 미만이면 제외한다.
- 가장 작은 점수를 고르고, 동점이면 `x`가 작은 쪽을 고른다.
- 후보가 없으면 목표 열을 clamp한 값을 폴백으로 쓴다.
- 결과는 슬롯 오름차순과 같은 `x` 오름차순이다.

스폰의 `y`는 `ballistics.makeTank()`가 정착된 지표면에서 계산한다.

---

## 10. 검증

`test_cross_sim_mapgen`은 여러 `mapSeed`와 플레이어 수에 대해 아래를 대조한다.

1. 정착 전 격자 체크섬
2. 초기 정착 스텝 수와 정착 후 체크섬
3. 질량
4. 스폰 열 배열
5. 좌우 2열 봉인과 기반암 불변식

초기 맵 골든은 `mapSeed`만 담고 `.grid.gz` 사이드카를 사용하지 않는다.
