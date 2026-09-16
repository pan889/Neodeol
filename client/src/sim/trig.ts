/* ═══════════════════════════════════════════════════════════════════════════
   Neodeol — 고정소수점 삼각함수   docs/simulation.md §3

   **런타임에 `Math.sin()` / `Math.cos()` 를 호출하지 않는다.**
   libm 구현이 플랫폼마다 마지막 자리에서 다를 수 있고, 그 한 자리가 lockstep 을 깬다.
   `tables/trig.bin` 을 읽어 쓴다 — 서버와 클라이언트가 **같은 파일**을 본다.

   ───────────────────────────────────────────────────────────────────────────
   형식 (생성기: `tools/gen_trig.py`)

     레이아웃   SIN 배열 1801개  →  COS 배열 1801개   (연속, 헤더 없음)
     인덱스    0 ~ 1800         (데시도. 각도 × 10)
     값        int16 리틀엔디언  sin/cos × 4096  (Q12)
     크기      7,204 바이트
     sha256    100aa8d037821279b236d69f632f87c43c74e8b700d503e881672e35b6a0a61b

   사용:  vx =  ((v0 * COS[deg10]) >> 12)
          vy = -((v0 * SIN[deg10]) >> 12)      ← 괄호 필수 (§2.2)

   각도 단위는 **데시도(0~1800)** 로 통일한다. 라디안이 sim 안에 등장하면 안 된다.
   ═══════════════════════════════════════════════════════════════════════════ */

export const TRIG_DECIDEG_MAX = 1800;
export const TRIG_COUNT = TRIG_DECIDEG_MAX + 1; // 1801
export const TRIG_SHIFT = 12;
export const TRIG_SCALE = 1 << TRIG_SHIFT; // 4096
export const TRIG_BYTES = TRIG_COUNT * 2 * 2; // 7204

let SIN_ARR: Int16Array | null = null;
let COS_ARR: Int16Array | null = null;

/**
 * `tables/trig.bin` 의 바이트를 넣어 표를 초기화한다.
 * 환경마다 읽는 방법이 다르므로(node = fs, 브라우저 = 빌드 시 임베드)
 * **로딩은 호출자 책임**이고 이 모듈은 검증과 조회만 한다.
 */
export function loadTrig(bytes: Uint8Array): void {
  if (bytes.length !== TRIG_BYTES) {
    throw new Error(`trig.bin 크기가 다르다: ${bytes.length} (기대 ${TRIG_BYTES})`);
  }
  /* 리틀엔디언 int16 으로 읽는다. byteOffset 정렬을 보장하려면 복사가 안전하다. */
  const copy = new Uint8Array(bytes); // 슬라이스가 아닌 사본 — offset 0 보장
  const view = new DataView(copy.buffer);
  const sin = new Int16Array(TRIG_COUNT);
  const cos = new Int16Array(TRIG_COUNT);
  for (let i = 0; i < TRIG_COUNT; i++) {
    sin[i] = view.getInt16(i * 2, true);
    cos[i] = view.getInt16((TRIG_COUNT + i) * 2, true);
  }
  /* 경계값 검증 — 여기가 틀리면 45°·90° 발사가 조용히 어긋난다 */
  if (sin[0] !== 0 || cos[0] !== TRIG_SCALE) throw new Error("trig.bin 0° 값이 틀렸다");
  if (sin[900] !== TRIG_SCALE || cos[900] !== 0) throw new Error("trig.bin 90° 값이 틀렸다");
  if (sin[1800] !== 0 || cos[1800] !== -TRIG_SCALE) throw new Error("trig.bin 180° 값이 틀렸다");
  if (sin[450] !== 2896 || cos[450] !== 2896) throw new Error("trig.bin 45° 값이 틀렸다");

  SIN_ARR = sin;
  COS_ARR = cos;
}

export function trigLoaded(): boolean {
  return SIN_ARR !== null;
}

function table(which: "sin" | "cos"): Int16Array {
  const t = which === "sin" ? SIN_ARR : COS_ARR;
  if (t === null) throw new Error("loadTrig() 를 먼저 불러야 한다 (tables/trig.bin)");
  return t;
}

/** `sin(deg10 / 10 °) × 4096`. deg10 은 0~1800. */
export function SIN(deg10: number): number {
  return table("sin")[deg10];
}
/** `cos(deg10 / 10 °) × 4096`. 90° 를 넘으면 음수다. */
export function COS(deg10: number): number {
  return table("cos")[deg10];
}
