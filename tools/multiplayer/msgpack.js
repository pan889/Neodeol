(function (root) {
  "use strict";

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function encode(value) {
    const chunks = [];
    write(value, chunks);
    let size = 0;
    for (const chunk of chunks) size += chunk.length;
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
  }

  function bytes(...values) { return Uint8Array.from(values); }
  function viewBytes(size, writer) {
    const out = new Uint8Array(size), view = new DataView(out.buffer);
    writer(view); return out;
  }

  function write(value, chunks) {
    if (value === null || value === undefined) { chunks.push(bytes(0xc0)); return; }
    if (value === false) { chunks.push(bytes(0xc2)); return; }
    if (value === true) { chunks.push(bytes(0xc3)); return; }
    if (typeof value === "number") { writeNumber(value, chunks); return; }
    if (typeof value === "string") { writeString(value, chunks); return; }
    if (value instanceof Uint8Array) { writeBin(value, chunks); return; }
    if (value instanceof ArrayBuffer) { writeBin(new Uint8Array(value), chunks); return; }
    if (Array.isArray(value)) { writeArray(value, chunks); return; }
    if (typeof value === "object") { writeMap(value, chunks); return; }
    throw new TypeError(`msgpack unsupported type: ${typeof value}`);
  }

  function writeNumber(value, chunks) {
    if (!Number.isSafeInteger(value)) throw new TypeError("msgpack harness only accepts safe integers");
    if (value >= 0) {
      if (value < 0x80) chunks.push(bytes(value));
      else if (value <= 0xff) chunks.push(bytes(0xcc, value));
      else if (value <= 0xffff) chunks.push(viewBytes(3, (v) => { v.setUint8(0, 0xcd); v.setUint16(1, value); }));
      else if (value <= 0xffffffff) chunks.push(viewBytes(5, (v) => { v.setUint8(0, 0xce); v.setUint32(1, value); }));
      else chunks.push(viewBytes(9, (v) => { v.setUint8(0, 0xcf); v.setBigUint64(1, BigInt(value)); }));
      return;
    }
    if (value >= -32) chunks.push(bytes(0x100 + value));
    else if (value >= -128) chunks.push(viewBytes(2, (v) => { v.setUint8(0, 0xd0); v.setInt8(1, value); }));
    else if (value >= -32768) chunks.push(viewBytes(3, (v) => { v.setUint8(0, 0xd1); v.setInt16(1, value); }));
    else chunks.push(viewBytes(5, (v) => { v.setUint8(0, 0xd2); v.setInt32(1, value); }));
  }

  function writeString(value, chunks) {
    const data = encoder.encode(value), length = data.length;
    if (length < 32) chunks.push(bytes(0xa0 | length));
    else if (length <= 0xff) chunks.push(bytes(0xd9, length));
    else if (length <= 0xffff) chunks.push(viewBytes(3, (v) => { v.setUint8(0, 0xda); v.setUint16(1, length); }));
    else chunks.push(viewBytes(5, (v) => { v.setUint8(0, 0xdb); v.setUint32(1, length); }));
    chunks.push(data);
  }

  function writeBin(data, chunks) {
    const length = data.length;
    if (length <= 0xff) chunks.push(bytes(0xc4, length));
    else if (length <= 0xffff) chunks.push(viewBytes(3, (v) => { v.setUint8(0, 0xc5); v.setUint16(1, length); }));
    else chunks.push(viewBytes(5, (v) => { v.setUint8(0, 0xc6); v.setUint32(1, length); }));
    chunks.push(data);
  }

  function writeArray(value, chunks) {
    const length = value.length;
    if (length < 16) chunks.push(bytes(0x90 | length));
    else if (length <= 0xffff) chunks.push(viewBytes(3, (v) => { v.setUint8(0, 0xdc); v.setUint16(1, length); }));
    else chunks.push(viewBytes(5, (v) => { v.setUint8(0, 0xdd); v.setUint32(1, length); }));
    for (const item of value) write(item, chunks);
  }

  function writeMap(value, chunks) {
    const entries = Object.entries(value), length = entries.length;
    if (length < 16) chunks.push(bytes(0x80 | length));
    else if (length <= 0xffff) chunks.push(viewBytes(3, (v) => { v.setUint8(0, 0xde); v.setUint16(1, length); }));
    else chunks.push(viewBytes(5, (v) => { v.setUint8(0, 0xdf); v.setUint32(1, length); }));
    for (const [key, item] of entries) { writeString(key, chunks); write(item, chunks); }
  }

  function decode(input) {
    const data = input instanceof Uint8Array ? input : new Uint8Array(input);
    const state = { data, view: new DataView(data.buffer, data.byteOffset, data.byteLength), offset: 0 };
    const value = read(state);
    if (state.offset !== data.length) throw new RangeError("msgpack trailing bytes");
    return value;
  }

  function take(state, length) {
    if (state.offset + length > state.data.length) throw new RangeError("msgpack truncated");
    const start = state.offset; state.offset += length; return start;
  }
  function readLength(state, bytesCount) {
    const at = take(state, bytesCount);
    return bytesCount === 1 ? state.view.getUint8(at)
      : bytesCount === 2 ? state.view.getUint16(at)
      : state.view.getUint32(at);
  }
  function readString(state, length) {
    const at = take(state, length); return decoder.decode(state.data.subarray(at, at + length));
  }
  function readArray(state, length) {
    const out = new Array(length); for (let i = 0; i < length; i++) out[i] = read(state); return out;
  }
  function readMap(state, length) {
    const out = {}; for (let i = 0; i < length; i++) out[read(state)] = read(state); return out;
  }

  function read(state) {
    const prefix = state.data[take(state, 1)];
    if (prefix <= 0x7f) return prefix;
    if (prefix >= 0xe0) return prefix - 0x100;
    if ((prefix & 0xe0) === 0xa0) return readString(state, prefix & 0x1f);
    if ((prefix & 0xf0) === 0x90) return readArray(state, prefix & 0x0f);
    if ((prefix & 0xf0) === 0x80) return readMap(state, prefix & 0x0f);
    switch (prefix) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: { const n = readLength(state, 1), at = take(state, n); return state.data.slice(at, at + n); }
      case 0xc5: { const n = readLength(state, 2), at = take(state, n); return state.data.slice(at, at + n); }
      case 0xc6: { const n = readLength(state, 4), at = take(state, n); return state.data.slice(at, at + n); }
      case 0xcc: return state.view.getUint8(take(state, 1));
      case 0xcd: return state.view.getUint16(take(state, 2));
      case 0xce: return state.view.getUint32(take(state, 4));
      case 0xcf: return Number(state.view.getBigUint64(take(state, 8)));
      case 0xd0: return state.view.getInt8(take(state, 1));
      case 0xd1: return state.view.getInt16(take(state, 2));
      case 0xd2: return state.view.getInt32(take(state, 4));
      case 0xd9: return readString(state, readLength(state, 1));
      case 0xda: return readString(state, readLength(state, 2));
      case 0xdb: return readString(state, readLength(state, 4));
      case 0xdc: return readArray(state, readLength(state, 2));
      case 0xdd: return readArray(state, readLength(state, 4));
      case 0xde: return readMap(state, readLength(state, 2));
      case 0xdf: return readMap(state, readLength(state, 4));
      default: throw new RangeError(`msgpack prefix 0x${prefix.toString(16)} unsupported`);
    }
  }

  root.NeodeolMsgpack = { encode, decode };
})(window);
