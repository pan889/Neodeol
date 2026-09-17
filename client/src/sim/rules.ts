/* ═══════════════════════════════════════════════════════════════════════════
   규칙 지문 — 두 구현이 **같은 규칙으로 계산하고 있는가**

   `docs/netcode.md` §7.3 의 접속 시 호환성 검사가 쓴다.

   ───────────────────────────────────────────────────────────────────────────
   왜 `simVersion` 으로는 안 되는가

   `SIM_VERSION` 은 `server/src/neodeol/constants.py` 전체의 SHA-256 이고 **Python 만
   계산할 수 있다.** 그래서 클라이언트는 `GET /version` 으로 받아 접속할 때 되돌려
   보내고 있었고, 서버는 그걸 자기 값과 비교했다 — **동어반복이라 원리적으로 불일치가
   나지 않는다.** 규칙이 다른 두 빌드가 같은 방에 들어갈 수 있었다.

   지문은 다르다. **양쪽이 각자의 규칙 표에서 독립적으로 계산한다.** 값이 갈라져 있으면
   지문이 갈라지고, 그때 비로소 핸드셰이크가 발화한다.

   ───────────────────────────────────────────────────────────────────────────
   무엇을 넣고 무엇을 빼는가

   넣는다: 시뮬레이션 결과를 바꾸는 값 전부 — 무기 수치, 지질 프로파일, 매치 규칙,
           탄도 상수, 자동자 확률·저항.
   뺀다:   표현 텍스트(무기 이름·설명), `SUBSTEPS` 같은 표현 상수.
           이름을 번역했다고 같은 방에 못 들어가면 곤란하다 (`terrain.md` §3.4 와 같은 이유).

   **문자열을 해시에 넣지 않는다.** 인코딩·정규화가 언어마다 다를 수 있어서, 순수 정수
   수열을 리틀엔디언 int32 로 편 뒤 FNV-1a 를 돌린다 — 골든의 `ptsHash` 와 같은 방식이고
   이미 양쪽이 일치하는 것이 검증된 패턴이다. `kind` 처럼 구조를 정하는 문자열은
   고정 인덱스로 바꿔 넣는다.
   ═══════════════════════════════════════════════════════════════════════════ */

import { fnv1a32, hex8 } from "./intmath.ts";
import * as T from "./terrain.ts";
import * as B from "./ballistics.ts";
import * as Wp from "./weapons.ts";
import * as M from "./mapgen.ts";
import { MATCH_VERSION, RULES } from "./match.ts";

/** `kind` 문자열을 고정 인덱스로. 순서를 바꾸면 지문이 바뀐다 — 바꾸지 마라 */
const KIND_INDEX: readonly Wp.WeaponKind[] = ["plain", "split", "burrow", "roll", "deposit"];

function kindIndex(kind: Wp.WeaponKind): number {
  const i = KIND_INDEX.indexOf(kind);
  if (i < 0) throw new Error(`모르는 무기 kind: ${kind}`);
  return i;
}

/**
 * 규칙 전체를 정수 수열로 편다. **양쪽 구현이 같은 순서로 같은 값을 내야 한다.**
 * 항목을 추가하면 `server/src/neodeol/sim/rules.py` 도 같이 고친다 —
 * 한쪽만 고치면 모든 접속이 거부된다(안전한 방향이지만 원인을 찾기 어렵다).
 */
export function ruleFingerprint(): number[] {
  const out: number[] = [];

  /* 1. 버전 태그 */
  out.push(MATCH_VERSION, M.MAPGEN_VERSION);

  /* 2. 무기 — 이름·설명은 뺀다 */
  out.push(Wp.WEAPONS.length);
  for (const w of Wp.WEAPONS) {
    out.push(
      w.id,
      kindIndex(w.kind),
      w.maxDamage,
      w.blastRadius,
      w.carveCells,
      w.ammo0 === null ? -1 : w.ammo0,
      w.price,
      w.splitCount ?? 0,
      w.splitSpread ?? 0,
      w.burrowCells ?? 0,
      w.rollCells ?? 0,
      w.depositCells ?? 0,
      w.depositMat ?? 0,
    );
  }

  /* 3. 아이템 — 가격만. key·name 은 표현이다 */
  out.push(Wp.ITEMS.length);
  for (const item of Wp.ITEMS) out.push(item.id, item.price);

  /* 4. 지질 프로파일과 맵 생성 상수 */
  out.push(M.PROVINCES.length);
  for (const p of M.PROVINCES) out.push(...p.bands, p.bedrockDepth);
  out.push(M.NOISE_SHIFT, M.SURFACE_BASE, M.SURFACE_AMP, M.BEDROCK_Y, M.PROVINCE_BLEND);
  out.push(M.SPAWN_MIN_GAP, M.SPAWN_MAX_RELIEF);

  /* 5. 매치 규칙 */
  out.push(
    RULES.rounds,
    RULES.roundTurnCap,
    RULES.startGold,
    RULES.goldPerDamage,
    RULES.goldPerKill,
    RULES.goldSurvive,
    RULES.goldLastPlaceBonus,
    RULES.killScore,
    RULES.damageScore,
    RULES.surviveScore,
    RULES.fuelCellsPerUnit,
    RULES.moveMaxStepUp,
    RULES.maxSettleSteps,
    RULES.connectivityMaxRounds,
  );

  /* 6. 탄도 */
  out.push(
    B.MAX_POWER,
    B.CFG.gravity,
    B.CFG.powerScale,
    B.CFG.windMax,
    B.CFG.windScaleQ8,
    B.CFG.dragQ16,
    B.CFG.maxFlightTicks,
    B.CFG.selfHitIgnore,
    B.CFG.barrelLen,
    B.CFG.fallSafePx,
    B.CFG.fallDamageNum,
    B.CFG.fallDamageShift,
    B.CFG.burialPermille,
    B.CFG.burialDamage,
    B.CFG.burialReliefCells,
  );

  /* 7. 자동자. `seed` 는 매치마다 달라지므로 넣지 않는다 */
  out.push(
    T.CFG.slideSandQ8,
    T.CFG.slideSoilQ8,
    T.CFG.slideScreeQ8,
    T.CFG.slideGateStatic ? 1 : 0,
    T.CFG.bothDirections ? 1 : 0,
  );
  for (const material of [T.SAND, T.SOIL, T.SCREE, T.ROCK, T.BEDROCK]) {
    out.push(material, T.CFG.blastResistQ8[material] ?? -1);
  }

  return out;
}

/** 규칙 지문의 FNV-1a. 8자리 대문자 hex */
export function ruleHash(): string {
  const values = ruleFingerprint();
  /* `undefined` 가 섞이면 `| 0` 이 **조용히 0 으로** 만든다. 실제로 그랬다 —
     `PROVINCE_BLEND` 를 export 하지 않아서 길이는 맞고 값만 달랐고, 그 상태로
     지문을 내면 모든 접속이 거부된다. 원인이 지문 안에 숨으므로 여기서 터뜨린다. */
  for (let i = 0; i < values.length; i++) {
    if (!Number.isInteger(values[i])) {
      throw new Error(`규칙 지문 ${i}번이 정수가 아니다: ${values[i]}`);
    }
  }
  const packed = new Int32Array(values.length);
  for (let i = 0; i < values.length; i++) packed[i] = values[i] | 0;
  return hex8(fnv1a32(new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength)));
}
