import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("./msgpack.js", import.meta.url), "utf8");
const context = vm.createContext({
  window: {},
  TextEncoder,
  TextDecoder,
  Uint8Array,
  ArrayBuffer,
  DataView,
  BigInt,
});
vm.runInContext(source, context, { filename: "msgpack.js" });

const { encode, decode } = context.window.TalusMsgpack;
const sample = {
  t: "fullState",
  deadlineMs: 1_786_000_000_123,
  wind: -17,
  ok: true,
  slots: [0, 1, 5],
  gridGzip: Uint8Array.from([31, 139, 8, 0, 255]),
};
const decoded = decode(encode(sample));

assert.equal(decoded.t, sample.t);
assert.equal(decoded.deadlineMs, sample.deadlineMs);
assert.equal(decoded.wind, sample.wind);
assert.equal(decoded.ok, true);
assert.deepEqual(Array.from(decoded.slots), sample.slots);
assert.deepEqual(Array.from(decoded.gridGzip), Array.from(sample.gridGzip));

const knownPong = encode({ t: "pong", t0: 1 });
assert.equal(Buffer.from(knownPong).toString("hex"), "82a174a4706f6e67a2743001");
assert.throws(() => encode({ t: "bad", value: 0.5 }), /safe integers/);

console.log("multiplayer msgpack codec ok");
