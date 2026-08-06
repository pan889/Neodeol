# tables/

**런타임에 생성하지 않고 저장소에 커밋되는 바이너리 데이터.**
서버와 클라이언트가 **같은 파일**을 읽는다. 클라이언트는 빌드 시 임베드한다.

| 파일 | 생성 | 형식 | 문서 |
|---|---|---|---|
| `trig.bin` | `tools/gen_trig.py` | `int16` × 1801 × 2 (sin, cos) — Q12 | `docs/simulation.md` §3 |

`trig.bin` 은 아직 없다. **Phase 2**에서 만든다 (`docs/roadmap.md`).

## 왜 표를 커밋하는가

`Math.sin()` / `math.sin()` 의 libm 구현은 플랫폼마다 마지막 자리에서 다를 수 있고,
그 한 자리가 lockstep 을 깬다. 생성 스크립트를 커밋하는 것만으로는 부족하다 —
**생성 결과를 커밋**해야 서버와 클라이언트가 같은 비트를 본다.

생성 결과가 바뀌면 `server/tests/test_determinism.py::test_trig_table` 이 실패한다.
의도적으로 바꿨다면 **바꾼 이유를 커밋 메시지에 적고** 고정 해시를 갱신한다.
