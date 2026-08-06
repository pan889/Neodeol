/* ═══════════════════════════════════════════════════════════════════════════
   교차 검증 — 골든 리플레이를 Python·TS 양쪽에서 재생해 매 턴 체크섬 비교
   docs/simulation.md §9 `test_cross_sim` / CLAUDE.md §결정론 게이트 (2)

     npm run test:cross-sim

   **Phase 3 산출물이다.** 지금은 실행할 수 없고, 왜 못 하는지를 명확히 알린다.
   `pass` 로 바꾸지 마라 — 결정론 버그를 은폐하는 가장 흔한 경로다.

   선행 조건 두 개가 전부 미결이다.
     · `server/src/talus/sim/` 이 비어 있다 (roadmap Phase 3)
     · 골든 리플레이 파일 스키마가 정해지지 않았다 (docs/decisions.md B2)
       turnSeed 파생 규칙은 확정됐지만 파일 형식(헤더 필드, 턴 레코드, 기대 체크섬
       포함 여부)이 남아 있다
   ═══════════════════════════════════════════════════════════════════════════ */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const simDir = path.join(ROOT, "server", "src", "talus", "sim");
const replayDir = path.join(ROOT, "tests", "replays");

const pyModules = fs.existsSync(simDir)
  ? fs.readdirSync(simDir).filter((f) => f.endsWith(".py") && f !== "__init__.py")
  : [];
const replays = fs.existsSync(replayDir)
  ? fs.readdirSync(replayDir).filter((f) => f.endsWith(".jsonl"))
  : [];

const R = "\x1b[31m", Y = "\x1b[33m", D = "\x1b[2m", X = "\x1b[0m";

if (pyModules.length === 0 || replays.length === 0) {
  console.log(`${Y}SKIP${X}  교차 검증은 Phase 3 산출물이다`);
  console.log(`  ${D}server/src/talus/sim/  Python 모듈 ${pyModules.length}개${X}`);
  console.log(`  ${D}tests/replays/         골든 리플레이 ${replays.length}개${X}`);
  console.log(`  ${D}선행: roadmap Phase 3, decisions.md B2 (리플레이 파일 스키마)${X}`);
  process.exit(0);
}

console.log(`${R}FAIL${X}  선행 조건은 갖춰졌는데 교차 검증이 구현되지 않았다`);
console.log(`  ${D}Python sim ${pyModules.length}개, 리플레이 ${replays.length}개가 존재한다.${X}`);
console.log(`  ${D}이 파일을 구현해야 한다 — 그러지 않으면 게이트 (2)가 비어 있다.${X}`);
process.exit(1);
