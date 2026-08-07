/* ═══════════════════════════════════════════════════════════════════════════
   교차 검증 — 골든 리플레이를 Python·TS 양쪽에서 재생해 매 턴 체크섬 비교
   docs/simulation.md §9 / CLAUDE.md §결정론 게이트 (2) / roadmap Phase 3

     npm run test:cross-sim              스텝 20 + 60턴 + 발사 40. 약 5분
     npm run test:cross-sim -- --slow    1000턴 포함. 약 25분

   **대조 자체는 Python 이 한다** (`server/tests/test_cross_sim.py`).
   골든은 TS 가 만들고(`client/tools/gen-golden.mts`) Python 이 같은 결과를 내는지 보는
   구조라, 검증 코드를 TS 에도 두면 같은 로직이 두 벌이 되고 둘이 어긋날 때
   **어느 쪽이 맞는지 판정할 방법이 없다.** 여기서는 골든의 무결성만 확인하고
   실제 재생은 pytest 에 넘긴다.

   도커가 떠 있으면 컨테이너에서, 아니면 호스트 파이썬으로 돌린다.
   ═══════════════════════════════════════════════════════════════════════════ */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const simDir = path.join(ROOT, "server", "src", "talus", "sim");
const replayDir = path.join(ROOT, "tests", "replays");

const R = "\x1b[31m", G = "\x1b[32m", Y = "\x1b[33m", D = "\x1b[2m", X = "\x1b[0m";
const withSlow = process.argv.includes("--slow");

const pyModules = fs.existsSync(simDir)
  ? fs.readdirSync(simDir).filter((f) => f.endsWith(".py") && f !== "__init__.py")
  : [];
const replays = fs.existsSync(replayDir)
  ? fs.readdirSync(replayDir).filter((f) => f.endsWith(".jsonl")).sort()
  : [];

if (pyModules.length === 0 || replays.length === 0) {
  console.log(`${Y}SKIP${X}  교차 검증의 선행 조건이 없다`);
  console.log(`  ${D}server/src/talus/sim/  Python 모듈 ${pyModules.length}개${X}`);
  console.log(`  ${D}tests/replays/         골든 리플레이 ${replays.length}개${X}`);
  console.log(`  ${D}골든이 없으면: node --experimental-strip-types client/tools/gen-golden.mts${X}`);
  process.exit(0);
}

/* ── 1. 골든 무결성 — 사이드카가 헤더 해시와 맞는가 ───────────────────────── */
let mapgenReplays = 0, matchReplays = 0, stepReplays = 0, turnReplays = 0, shotReplays = 0, maxTurns = 0, maxShots = 0;
for (const f of replays) {
  const p = path.join(replayDir, f);
  const [head] = fs.readFileSync(p, "utf8").split("\n");
  const h = JSON.parse(head);
  if (h.v !== 1) { console.log(`${R}FAIL${X}  ${f}: 모르는 버전 ${h.v}`); process.exit(1); }
  if (h.gridFile) {
    const blob = zlib.gunzipSync(fs.readFileSync(path.join(replayDir, h.gridFile)));
    const sha = crypto.createHash("sha256").update(blob).digest("hex");
    if (sha !== h.gridSha256) {
      console.log(`${R}FAIL${X}  ${f}: 사이드카 ${h.gridFile} 가 헤더 해시와 다르다`);
      console.log(`  ${D}한쪽만 재생성됐다. gen-golden.mts 를 다시 돌린다.${X}`);
      process.exit(1);
    }
  }
  if (h.kind === "mapgen") mapgenReplays++;
  else if (h.kind === "match") matchReplays++;
  else if (h.kind === "terrain-turns") { turnReplays++; maxTurns = Math.max(maxTurns, h.turnCount); }
  else if (h.kind === "shots") { shotReplays++; maxShots = Math.max(maxShots, h.shotCount); }
  else if (h.kind === "terrain-only") stepReplays++;
  else { console.log(`${R}FAIL${X}  ${f}: 모르는 kind ${h.kind}`); process.exit(1); }
}
if (stepReplays < 20) {
  console.log(`${R}FAIL${X}  스텝 리플레이가 ${stepReplays}개뿐이다 (20개 이상 — roadmap Phase 3)`);
  process.exit(1);
}
console.log(`${D}골든 무결성 OK — 맵 ${mapgenReplays}개, 매치 ${matchReplays}개, 스텝 ${stepReplays}개, 턴 ${turnReplays}개(최대 ${maxTurns}턴), 발사 ${shotReplays}개(${maxShots}발)${X}`);
if (mapgenReplays === 0) {
  console.log(`${R}FAIL${X}  맵 생성 리플레이가 없다 — buildMap/chooseSpawnCells 가 검증되지 않는다`);
  console.log(`  ${D}node --experimental-strip-types client/tools/gen-golden.mts --mapgen-only${X}`);
  process.exit(1);
}
if (matchReplays === 0) {
  console.log(`${R}FAIL${X}  매치 리플레이가 없다 — 라운드·경제·승패가 검증되지 않는다`);
  console.log(`  ${D}node --experimental-strip-types client/tools/gen-golden.mts --match-only${X}`);
  process.exit(1);
}
if (shotReplays === 0) {
  console.log(`${R}FAIL${X}  발사 리플레이가 없다 — ballistics/weapons 가 검증되지 않는다`);
  console.log(`  ${D}node --experimental-strip-types client/tools/gen-golden.mts${X}`);
  process.exit(1);
}
if (withSlow && maxTurns < 1000) {
  console.log(`${R}FAIL${X}  --slow 인데 1000턴 리플레이가 없다`);
  console.log(`  ${D}node --experimental-strip-types client/tools/gen-golden.mts${X}`);
  process.exit(1);
}

/* ── 2. Python 재생 ──────────────────────────────────────────────────────── */
const mark = withSlow ? "slow or not slow" : "not slow";
const inDocker = spawnSync("docker", ["compose", "ps", "-q", "server"], {
  cwd: ROOT, encoding: "utf8",
}).stdout?.trim();

const [cmd, argv, opts] = inDocker
  ? ["docker", [
      "compose", "exec", "-T", "-e", "TALUS_REPLAY_DIR=/app/replays", "server",
      "python", "-m", "pytest", "/app/tests/test_cross_sim.py", "-q", "-m", mark,
    ], { cwd: ROOT }]
  : ["python3", [
      "-m", "pytest", "tests/test_cross_sim.py", "-q", "-m", mark,
    ], { cwd: path.join(ROOT, "server"), env: { ...process.env, PYTHONPATH: "src" } }];

console.log(`${D}${inDocker ? "컨테이너" : "호스트"}에서 재생: -m "${mark}"${X}`);
const res = spawnSync(cmd, argv, { stdio: "inherit", ...opts });

if (res.status !== 0) {
  console.log(`\n${R}FAIL${X}  교차 검증이 갈라졌다`);
  console.log(`  ${D}규칙을 의도적으로 바꿨다면 커밋 메시지에 이유를 적고 골든을 재생성한다.${X}`);
  console.log(`  ${D}이유 없이 재생성하는 것은 금지다 (CLAUDE.md §결정론 게이트).${X}`);
  process.exit(res.status ?? 1);
}
console.log(`${G}PASS${X}  Python·TS 교차 검증${withSlow ? " (1000턴 포함)" : ""}`);
