import { ruleHash } from "./sim/rules.js";

const ACTIVE_SESSION_KEY = "talus.multiplayer.active.v1";
const SAVED_SESSIONS_KEY = "talus.multiplayer.sessions.v1";

export function readSavedSessions() {
  try {
    const value = JSON.parse(localStorage.getItem(SAVED_SESSIONS_KEY) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch (_) {
    return {};
  }
}

export function activeSession() {
  const id = sessionStorage.getItem(ACTIVE_SESSION_KEY);
  return id ? readSavedSessions()[id] || null : null;
}

export async function fetchVersion() {
  const response = await fetch("/version");
  if (!response.ok) throw new Error(`/version HTTP ${response.status}`);
  return response.json();
}

export function fnv1a32(bytes) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index += 1) {
    hash = Math.imul(hash ^ bytes[index], 0x01000193) >>> 0;
  }
  return hash;
}

export async function decodeGridGzip(compressed, expectedChecksum) {
  if (!("DecompressionStream" in window)) {
    throw new Error("이 브라우저는 gzip DecompressionStream을 지원하지 않는다");
  }
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
  const grid = new Uint8Array(await new Response(stream).arrayBuffer());
  if (grid.length !== 518400) throw new Error(`격자 길이 ${grid.length}`);
  for (let index = 0; index < grid.length; index += 1) {
    if (grid[index] > 5) throw new Error(`재질 범위 초과 idx=${index} value=${grid[index]}`);
  }
  const checksum = fnv1a32(grid);
  if (checksum !== expectedChecksum) {
    throw new Error(`격자 checksum 0x${checksum.toString(16)} != 0x${expectedChecksum.toString(16)}`);
  }
  return grid;
}

export class RoomSocket {
  constructor({ session, version, buildHash, onMessage, onStatus }) {
    this.session = session;
    this.version = version;
    this.buildHash = buildHash;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.socket = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.epoch = 0;
    this.closed = false;
  }

  connect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const previous = this.socket;
    const epoch = ++this.epoch;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const query = new URLSearchParams({
      token: this.session.token,
      protocolVersion: String(this.version.protocol_version),
      // **자기 규칙 표에서 계산한다.** 예전에는 `GET /version` 으로 받은 값을 그대로
      // 되돌려 보내서 서버 검사가 동어반복이었다 — 규칙이 다른 빌드도 통과했다.
      ruleHash: ruleHash(),
      buildHash: this.buildHash,
    });
    const socket = new WebSocket(
      `${scheme}://${location.host}/ws/rooms/${this.session.roomCode}?${query}`,
    );
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.onStatus({ state: "connecting" });
    if (previous && previous.readyState < WebSocket.CLOSING) previous.close(1000, "reconnect");

    socket.onopen = () => {
      if (!this.isCurrent(socket, epoch)) return;
      this.reconnectAttempt = 0;
      this.onStatus({ state: "connected" });
    };
    socket.onmessage = (event) => {
      if (!this.isCurrent(socket, epoch)) return;
      try {
        this.onMessage(window.TalusMsgpack.decode(event.data));
      } catch (error) {
        this.onStatus({ state: "decode-error", error });
      }
    };
    socket.onerror = () => {
      if (this.isCurrent(socket, epoch)) this.onStatus({ state: "error" });
    };
    socket.onclose = (event) => {
      if (!this.isCurrent(socket, epoch)) return;
      this.socket = null;
      this.onStatus({ state: "offline", code: event.code, reason: event.reason });
      const fatal = event.code === 1000 || event.code === 4001 || (event.code >= 4400 && event.code < 4500);
      if (!this.closed && !fatal) this.scheduleReconnect();
    };
  }

  send(message) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(window.TalusMsgpack.encode(message));
    return true;
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    if (this.socket) this.socket.close(1000, "client close");
  }

  isCurrent(socket, epoch) {
    return this.socket === socket && this.epoch === epoch;
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(10000, 750 * (2 ** this.reconnectAttempt));
    this.reconnectAttempt += 1;
    this.onStatus({ state: "retry", delay });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
