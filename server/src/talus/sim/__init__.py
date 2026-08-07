"""순수 시뮬레이션 — `client/src/sim/` 의 1:1 번역 (Phase 3).

`docs/roadmap.md` Phase 3: **TypeScript 구현의 번역이며 창의성을 발휘하지 않는다.**
규칙을 다시 설계하면 Phase 0 의 실측 검증이 무효가 된다.
여기서 하는 유일한 창의는 **같은 규칙을 numpy 벡터로 표현하는 방법**이다.

    intmath.py   floor_div · isqrt · hash32(벡터/스칼라) · fnv1a32
    terrain.py   모래 자동자, 폭발 카빙, 흙 쌓기, 연결성 검사
    ballistics.py  탄도 적분, 피해, 탱크 재배치
    weapons.py     무기 8종과 특수 발동
    mapgen.py      초기 격자와 스폰 생성
    match.py       라운드·턴·경제·승패

절대 규칙 (CLAUDE.md)

1. `asyncio`, 소켓, 파일, 시계, `random.random()` 금지.
   입력은 `(state, inputs)`, 출력은 `new_state`.
2. 부동소수점 금지. 나눗셈은 `>>` 또는 `intmath.floor_div` 만.
3. 제안(propose) → 해소(resolve) → 커밋(commit) 3단계. 순서 의존 금지.

교차 검증은 `server/tests/test_cross_sim.py` 가 한다 —
TS 가 만든 골든 리플레이를 재생해 매 표본 지점의 체크섬을 대조한다.
"""
