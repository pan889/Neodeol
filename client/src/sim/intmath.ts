/* ═══════════════════════════════════════════════════════════════════════════
   Neodeol — 정수 수학 헬퍼   docs/simulation.md §2.2 · §5.1, docs/terrain.md §7

   **`sim/` 안에서 나눗셈과 32비트 해시가 허용되는 유일한 파일이다.**
   `tools/check-no-float.mjs` 가 이 파일만 화이트리스트로 예외 처리한다.
   다른 곳에서 `/` 나 `Math.*` 가 나오면 정적 검사가 거부한다.

   ───────────────────────────────────────────────────────────────────────────
   시프트 두 종류를 구분한다 (§2.2)

     좌표·속도 나눗셈   `>>`  (산술)  — 음수에서 floor 여야 한다
     해시·체크섬 비트   `>>>` (논리)  — uint32 를 유지해야 한다

   JS 의 `>>` 는 ToInt32 를 거쳐 **부호 확장**한다. 해시 중간값이 2^31 을 넘는
   약 절반의 경우에 `>>` 를 쓰면 전혀 다른 값이 나온다 — `terrain.md` §7.1.1 실측.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * floor 나눗셈. `docs/simulation.md` §4.3 이 허용한 **유일한 나눗셈**이다.
 *
 * 2의 거듭제곱 제수는 `>>` 로 처리하므로 이 함수는 서브스텝 분할처럼
 * 제수가 2의 거듭제곱이 아닌 곳에서만 쓴다.
 *
 * Python 의 `//` 와 numpy int32 나눗셈이 같은 결과를 낸다:
 *   floorDiv(-7, 2) === -4   (JS 의 `(-7/2)|0` 은 -3 이라 쓸 수 없다)
 */
export function floorDiv(a: number, b: number): number {
  const q = (a - (((a % b) + b) % b)) / b;
  return q | 0;
}

/**
 * 정수 제곱근. `floor(sqrt(n))`. 뉴턴법.
 * `Math.sqrt()` 금지 — libm 이 플랫폼마다 마지막 자리에서 다를 수 있다 (§3 과 같은 이유).
 */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  if (n < 4) return 1;
  let x = n;
  let y = (x + 1) >> 1;
  while (y < x) {
    x = y;
    y = (x + floorDiv(n, x)) >> 1;
  }
  return x;
}

/** 절댓값. `Math.abs` 를 쓰지 않는 이유는 정적 검사를 단순하게 유지하기 위해서다. */
export function iabs(v: number): number {
  return v < 0 ? -v : v;
}

export function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/* ── FNV-1a 상수 ─────────────────────────────────────────────────────── */
export const FNV_OFFSET = 0x811c9dc5 | 0;
export const FNV_PRIME = 0x01000193 | 0;

/**
 * 결정론 해시.  `docs/terrain.md` §7.1
 *
 *   h = avalanche( fnv1a32( seed ^ x*0x9E3779B1 ^ y*0x85EBCA77 ^ step*0xC2B2AE3D ) )
 *
 * **최종 확산 단계를 빼면 안 된다.** FNV-1a 는 하위 비트로 확산되지 않아
 * `h & 1` 이 입력 비트의 순수 XOR 패리티가 되고, 그러면 방향장이 평생 두 배치만
 * 갖는다 — `terrain.md` §7.1.1 에 실측이 있다.
 *
 * 모든 시프트는 **논리**(`>>>`)다. numpy 는 `uint32` 로 고정한다.
 */
export function hash32(seed: number, x: number, y: number, step: number): number {
  const v =
    (seed ^
      Math.imul(x, 0x9e3779b1) ^
      Math.imul(y, 0x85ebca77) ^
      Math.imul(step, 0xc2b2ae3d)) >>>
    0;
  let h = FNV_OFFSET;
  h = Math.imul(h ^ (v & 0xff), FNV_PRIME);
  h = Math.imul(h ^ ((v >>> 8) & 0xff), FNV_PRIME);
  h = Math.imul(h ^ ((v >>> 16) & 0xff), FNV_PRIME);
  h = Math.imul(h ^ ((v >>> 24) & 0xff), FNV_PRIME);
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x2545f491) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * 바이트 배열의 FNV-1a 32비트.  `docs/terrain.md` §7.2
 * 격자 체크섬이 이걸 쓴다. 항상 `uint32` 로 돌려준다.
 */
export function fnv1a32(bytes: Uint8Array): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], FNV_PRIME);
  return h >>> 0;
}

/** uint32 를 8자리 대문자 hex 로. 로그·리플레이 파일 표기에 쓴다. */
export function hex8(u: number): string {
  return (u >>> 0).toString(16).toUpperCase().padStart(8, "0");
}
