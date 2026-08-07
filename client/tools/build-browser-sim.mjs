import fs from "node:fs";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceDir = path.join(root, "client/src/sim");
const outputDir = path.join(root, "tools/multiplayer/sim");
const files = [
  "intmath.ts",
  "trig.ts",
  "terrain.ts",
  "ballistics.ts",
  "weapons.ts",
  "mapgen.ts",
  "match.ts",
];

function build(name) {
  const source = fs.readFileSync(path.join(sourceDir, name), "utf8");
  const transformed = stripTypeScriptTypes(source, { mode: "transform", sourceMap: false })
    .replace(/(from\s+["'][^"']+)\.ts(["'])/g, "$1.js$2");
  return `// Generated from client/src/sim/${name}. Do not edit.\n${transformed}`;
}

function patchText() {
  const lines = ["*** Begin Patch"];
  for (const name of files) {
    const target = `tools/multiplayer/sim/${name.replace(/\.ts$/, ".js")}`;
    lines.push(`*** Add File: ${target}`);
    for (const line of build(name).split("\n")) lines.push(`+${line}`);
  }
  lines.push("*** End Patch", "");
  return lines.join("\n");
}

function check() {
  let failed = false;
  for (const name of files) {
    const target = path.join(outputDir, name.replace(/\.ts$/, ".js"));
    const expected = build(name);
    const actual = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    if (actual !== expected) {
      console.error(`browser sim stale: ${path.relative(root, target)}`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
  console.log("browser sim mirror ok");
}

if (process.argv.includes("--emit-patch")) {
  process.stdout.write(patchText());
} else if (process.argv.includes("--check")) {
  check();
} else {
  fs.mkdirSync(outputDir, { recursive: true });
  for (const name of files) {
    fs.writeFileSync(path.join(outputDir, name.replace(/\.ts$/, ".js")), build(name));
  }
  console.log(`wrote ${files.length} browser sim modules`);
}
