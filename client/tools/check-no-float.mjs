#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   client/src/sim/ 정적 검사 — docs/simulation.md §9 `test_no_float` 의 TS 쪽

     node client/tools/check-no-float.mjs

   서버 쪽(`server/tests/test_determinism.py::test_no_float`)과 같은 취지다.
   과하다고 느껴질 수 있는데, **결정론 버그는 재현이 어렵고 발견이 늦다.**
   정적으로 잡을 수 있는 건 정적으로 잡는다.

   ───────────────────────────────────────────────────────────────────────────
   왜 정규식인가

   TS AST 파서(typescript, @babel/parser)는 네트워크 설치가 필요하고, 이 검사가
   잡아야 하는 것은 전부 토큰 수준이다. 대신 **주석과 문자열을 먼저 제거**해서
   설명문 안의 `0.5` 나 `/` 를 오탐하지 않게 한다.
   ═══════════════════════════════════════════════════════════════════════════ */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIM_DIR = path.join(HERE, "..", "src", "sim");

/** 나눗셈과 32비트 해시가 허용되는 유일한 파일 (docs/simulation.md §4.3) */
const DIVISION_WHITELIST = new Set(["intmath.ts"]);

/** `sim/` 안에서 금지된 식별자 */
const FORBIDDEN = [
  { re: /\bMath\.(random|sin|cos|tan|sqrt|atan2?|PI|E|log|exp|pow|hypot|round|ceil|trunc|sign|cbrt)\b/g,
    why: "Math 부동소수점/난수 호출 — trig.ts 표와 intmath.ts 헬퍼를 쓴다" },
  { re: /\bMath\.(abs|max|min|floor)\b/g,
    why: "Math.abs/max/min/floor — intmath.iabs / clampInt / 명시적 비교를 쓴다" },
  { re: /\bDate\b|\bperformance\.now\b/g, why: "시계 — sim 은 순수해야 한다" },
  { re: /\bparseFloat\b|\bNumber\.parseFloat\b/g, why: "parseFloat" },
  { re: /\bFloat(32|64)Array\b/g, why: "부동소수점 배열" },
  { re: /\bfetch\b|\brequire\s*\(|\bnode:fs\b|\bnode:net\b/g, why: "I/O — sim 은 순수해야 한다" },
];

/** 주석과 문자열 리터럴을 공백으로 바꾼다. 줄 수는 보존한다. */
function strip(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let state = "code"; // code | line | block | sq | dq | tpl
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === "code") {
      if (c === "/" && c2 === "/") { state = "line"; out += "  "; i += 2; continue; }
      if (c === "/" && c2 === "*") { state = "block"; out += "  "; i += 2; continue; }
      if (c === "'") { state = "sq"; out += " "; i++; continue; }
      if (c === '"') { state = "dq"; out += " "; i++; continue; }
      if (c === "`") { state = "tpl"; out += " "; i++; continue; }
      out += c; i++; continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += "\n"; i++; continue; }
      out += " "; i++; continue;
    }
    if (state === "block") {
      if (c === "*" && c2 === "/") { state = "code"; out += "  "; i += 2; continue; }
      out += c === "\n" ? "\n" : " "; i++; continue;
    }
    /* 문자열 안 — 이스케이프를 건너뛴다 */
    if (c === "\\") { out += "  "; i += 2; continue; }
    if ((state === "sq" && c === "'") || (state === "dq" && c === '"') || (state === "tpl" && c === "`")) {
      state = "code"; out += " "; i++; continue;
    }
    out += c === "\n" ? "\n" : " "; i++; continue;
  }
  return out;
}

const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;

function checkFile(file) {
  const raw = fs.readFileSync(file, "utf8");
  const src = strip(raw);
  const name = path.basename(file);
  const problems = [];

  /* 1) 부동소수점 리터럴 — 1.5, .5, 1e-3, 1_000.5 */
  const floatRe = /(?<![\w.$])(?:\d[\d_]*\.\d|\.\d|\d[\d_]*(?:\.\d[\d_]*)?[eE][-+]?\d)/g;
  for (const m of src.matchAll(floatRe)) {
    problems.push(`${name}:${lineOf(src, m.index)} 부동소수점 리터럴 \`${m[0]}\``);
  }

  /* 2) `/` 연산자. 정규식·주석은 이미 제거됐다. `//` 도 제거됐다. */
  if (!DIVISION_WHITELIST.has(name)) {
    const divRe = /(?<![*/])\/(?![*/=])/g;
    for (const m of src.matchAll(divRe)) {
      problems.push(`${name}:${lineOf(src, m.index)} \`/\` 연산자 — \`>>\` 또는 floorDiv 를 쓴다`);
    }
    for (const m of src.matchAll(/\/=/g)) {
      problems.push(`${name}:${lineOf(src, m.index)} \`/=\` 연산자`);
    }
  }

  /* 3) 금지 식별자 */
  for (const f of FORBIDDEN) {
    f.re.lastIndex = 0;
    for (const m of src.matchAll(f.re)) {
      /* intmath.ts 는 Math.imul 을 쓴다 — imul 은 정수 곱이라 위 목록에 없다 */
      problems.push(`${name}:${lineOf(src, m.index)} ${f.why} (\`${m[0]}\`)`);
    }
  }
  return problems;
}

const files = fs
  .readdirSync(SIM_DIR)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => path.join(SIM_DIR, f))
  .sort();

if (files.length === 0) {
  console.error(`검사할 파일이 없다: ${SIM_DIR}`);
  process.exit(1);
}

let total = 0;
const all = [];
for (const f of files) {
  const p = checkFile(f);
  total += p.length;
  all.push(...p);
}

const G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[2m", X = "\x1b[0m";
console.log(`${D}검사 대상 ${files.length}개 파일 · 나눗셈 화이트리스트: ${[...DIVISION_WHITELIST].join(", ")}${X}`);
if (total === 0) {
  console.log(`${G}PASS${X}  client/src/sim/ 에 부동소수점·나눗셈·Math 호출이 없다`);
  process.exit(0);
}
console.log(`${R}FAIL${X}  ${total}건`);
for (const p of all) console.log("  " + p);
process.exit(1);
