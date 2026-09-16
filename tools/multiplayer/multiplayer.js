import { ruleHash } from "./sim/rules.js";

(function () {
  "use strict";

  const MP = window.NeodeolMsgpack;
  const ACTIVE_SESSION_KEY = "neodeol.multiplayer.active.v1";
  const SAVED_SESSIONS_KEY = "neodeol.multiplayer.sessions.v1";
  const LEGACY_SESSION_KEY = "neodeol.multiplayer.session";
  const $ = (id) => document.getElementById(id);
  const state = {
    version: null,
    session: null,
    ws: null,
    room: null,
    mySlot: null,
    turn: null,
    roundNo: 0,
    players: [],
    grid: null,
    reconnectTimer: null,
    reconnectAttempt: 0,
    connectionEpoch: 0,
    leaving: false,
  };

  function log(text, cls = "") {
    const line = document.createElement("div");
    line.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
    if (cls) line.className = cls;
    $("log").prepend(line);
  }

  function setStatus(text) {
    $("status").textContent = text.toUpperCase();
  }

  function apiError(body) {
    return body && body.detail ? body.detail.msg || JSON.stringify(body.detail) : "요청 실패";
  }

  async function post(url, body) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(apiError(data));
    return data;
  }

  async function createRoom() {
    try {
      const data = await post("/api/rooms", {
        name: $("name").value,
        maxPlayers: +$("maxPlayers").value,
      });
      saveSession(data);
      connect();
    } catch (error) {
      log(error.message, "err");
    }
  }

  async function joinRoom() {
    try {
      const code = $("joinCode").value.trim().toUpperCase();
      const data = await post(`/api/rooms/${encodeURIComponent(code)}/join`, {
        name: $("name").value,
      });
      saveSession(data);
      connect();
    } catch (error) {
      log(error.message, "err");
    }
  }

  function readSavedSessions() {
    try {
      const parsed = JSON.parse(localStorage.getItem(SAVED_SESSIONS_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function writeSavedSessions(sessions) {
    localStorage.setItem(SAVED_SESSIONS_KEY, JSON.stringify(sessions));
  }

  function makeSessionId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function saveSession(data) {
    const session = {
      ...data,
      id: data.id || makeSessionId(),
      name: $("name").value.trim() || "포병",
      savedAt: Date.now(),
    };
    const sessions = readSavedSessions();
    sessions[session.id] = session;
    writeSavedSessions(sessions);
    activateSession(session);
  }

  function activateSession(session) {
    state.leaving = false;
    state.session = session;
    state.mySlot = session.slot;
    sessionStorage.setItem(ACTIVE_SESSION_KEY, session.id);
    $("roomCode").textContent = session.roomCode;
    $("mySlot").textContent = `slot ${session.slot}`;
    $("lobbyPanel").classList.add("hidden");
    $("sessionPanel").classList.remove("hidden");
    document.title = `Neodeol · ${session.roomCode}`;
  }

  function resumeSelectedSession() {
    const session = readSavedSessions()[$("recentSessions").value];
    if (!session) return;
    activateSession(session);
    connect();
  }

  function renderRecentSessions() {
    const sessions = Object.values(readSavedSessions()).sort((a, b) => b.savedAt - a.savedAt);
    $("recentWrap").classList.toggle("hidden", sessions.length === 0);
    $("recentSessions").innerHTML = sessions.map((session) => (
      `<option value="${escapeHtml(session.id)}">${escapeHtml(session.roomCode)} · ${escapeHtml(session.name)} · slot ${session.slot}</option>`
    )).join("");
  }

  function clearSession() {
    state.leaving = true;
    clearTimeout(state.reconnectTimer);
    const sessions = readSavedSessions();
    if (state.session) delete sessions[state.session.id];
    writeSavedSessions(sessions);
    sessionStorage.removeItem(ACTIVE_SESSION_KEY);
    if (state.ws) state.ws.close(1000, "session cleared");
    location.reload();
  }

  function connect() {
    if (!state.session || !state.version) return;
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    const previous = state.ws;
    const epoch = ++state.connectionEpoch;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const query = new URLSearchParams({
      token: state.session.token,
      protocolVersion: String(state.version.protocol_version),
      ruleHash: ruleHash(),
      buildHash: "phase4-harness",
    });
    const ws = new WebSocket(
      `${scheme}://${location.host}/ws/rooms/${state.session.roomCode}?${query}`,
    );
    ws.binaryType = "arraybuffer";
    state.ws = ws;
    setStatus("connecting");
    if (previous && previous.readyState < WebSocket.CLOSING) previous.close(1000, "reconnect");

    ws.onopen = () => {
      if (state.ws !== ws || state.connectionEpoch !== epoch) return;
      state.reconnectAttempt = 0;
      setStatus("connected");
      log("WebSocket 연결");
    };
    ws.onclose = (event) => {
      if (state.ws !== ws || state.connectionEpoch !== epoch) return;
      state.ws = null;
      setStatus("offline");
      log(`연결 종료 ${event.code} ${event.reason || ""}`, event.code === 1000 ? "" : "err");
      if (!state.leaving && event.code !== 1000 && event.code !== 4001 && !(event.code >= 4400 && event.code < 4500)) {
        scheduleReconnect();
      }
    };
    ws.onerror = () => {
      if (state.ws === ws) log("WebSocket 오류", "err");
    };
    ws.onmessage = (event) => {
      if (state.ws !== ws) return;
      try {
        void handle(MP.decode(event.data));
      } catch (error) {
        log(`decode 실패: ${error.message}`, "err");
      }
    };
  }

  function scheduleReconnect() {
    clearTimeout(state.reconnectTimer);
    const delay = Math.min(10000, 750 * (2 ** state.reconnectAttempt));
    state.reconnectAttempt += 1;
    setStatus(`retry ${Math.ceil(delay / 1000)}s`);
    state.reconnectTimer = setTimeout(connect, delay);
  }

  function send(message) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      log("연결되지 않았다", "err");
      return false;
    }
    state.ws.send(MP.encode(message));
    return true;
  }

  async function handle(message) {
    log(`← ${message.t}`, message.t === "error" || message.t === "desync" ? "err" : "event");
    if (message.t === "hello") {
      state.mySlot = message.mySlot;
      $("mySlot").textContent = `slot ${message.mySlot}`;
    } else if (message.t === "roomState") {
      state.room = message;
      setStatus(message.status);
      if (message.status === "lobby" || message.status === "starting" || state.players.length === 0) {
        state.players = message.players;
      } else {
        state.players = mergeRoomMetadata(state.players);
      }
      renderPlayers();
      const me = message.players.find((player) => player.slot === state.mySlot);
      $("start").disabled = !(me && me.host && message.status === "lobby" && message.players.length >= 2);
      if (message.telemetry && message.telemetry.desyncs > 0) {
        log(`DESYNC 누적 ${message.telemetry.desyncs}회`, "err");
      }
    } else if (message.t === "matchInit") {
      state.players = mergeRoomMetadata(message.players);
      state.roundNo = 1;
      renderPlayers();
      log(`mapSeed ${message.mapSeed} · checksum ${hex(message.checksum)}`);
    } else if (message.t === "fullState") {
      state.players = mergeRoomMetadata(message.state.players);
      state.roundNo = message.state.roundNo;
      state.turn = null;
      renderPlayers();
      renderTurn();
      $("shopReady").disabled = message.status !== "shop";
      await inspectFullStateGrid(message.gridGzip, message.checksum);
    } else if (message.t === "turnBegin") {
      state.turn = message;
      state.roundNo = message.roundNo;
      setStatus("aim");
      renderTurn();
      renderPlayers();
    } else if (message.t === "turnResolve") {
      setStatus("resolving");
      $("fire").disabled = true;
      log(`slot ${message.activeSlot} 발사 · ${message.intent.angle10 / 10}° / ${message.intent.power}`);
    } else if (message.t === "turnResult") {
      state.players = mergeRoomMetadata(message.players);
      renderPlayers();
      setStatus(message.phase);
      log(`TURN ${message.turnNo} 결과 · checksum ${hex(message.checksum)} · settle ${message.settle.steps}`);
      if (message.phase === "aim") {
        setTimeout(() => send({ t: "playbackDone", turnNo: message.turnNo, checksum: message.checksum }), 450);
      }
    } else if (message.t === "roundEnd") {
      state.roundNo = message.roundNo;
      state.turn = null;
      renderTurn();
      setStatus("shop");
      $("shopReady").disabled = false;
    } else if (message.t === "roundStart") {
      state.roundNo = message.roundNo;
      state.turn = null;
      state.players = mergeRoomMetadata(message.players);
      renderPlayers();
      renderTurn();
      $("shopReady").disabled = true;
    } else if (message.t === "buyResult") {
      const index = state.players.findIndex((player) => player.slot === message.slot);
      if (index >= 0) state.players[index] = mergeRoomMetadata([message.player])[0];
      renderPlayers();
    } else if (message.t === "matchEnd") {
      state.turn = null;
      renderTurn();
      setStatus("done");
      log(`MATCH END · winner ${message.winners.join(", ")}`, "event");
    } else if (message.t === "ping") {
      send({ t: "pong", t0: message.t0 });
    } else if (message.t === "error") {
      log(`ERROR ${message.code}: ${message.msg}`, "err");
    }
  }

  function mergeRoomMetadata(players) {
    const seats = new Map(((state.room && state.room.players) || []).map((seat) => [seat.slot, seat]));
    return players.map((player) => {
      const seat = seats.get(player.slot);
      return {
        ...player,
        name: seat ? seat.name : player.name,
        host: seat ? seat.host : Boolean(player.host),
        connected: seat ? seat.connected : Boolean(player.connected),
      };
    });
  }

  function renderPlayers() {
    if (!state.players || !state.players.length) return;
    $("players").innerHTML = state.players.map((player) => {
      const active = state.turn && state.turn.activeSlot === player.slot;
      const hp = player.hp == null ? "" : ` · HP ${player.hp} · ${player.gold}G`;
      return `<div class="player${player.slot === state.mySlot ? " me" : ""}${active ? " active" : ""}"><span class="slot">#${player.slot}</span><span>${escapeHtml(player.name)}${player.host ? " · HOST" : ""}${hp}</span><span class="${player.connected ? "online" : "offline"}">${player.connected ? "ONLINE" : "OFFLINE"}</span></div>`;
    }).join("");
  }

  function renderTurn() {
    if (!state.turn) {
      $("turn").classList.add("hidden");
      return;
    }
    $("turn").classList.remove("hidden");
    $("turnLabel").textContent = `ROUND ${state.turn.roundNo} · TURN ${state.turn.turnNo} · SLOT ${state.turn.activeSlot}`;
    $("deadline").textContent = new Date(state.turn.deadlineMs).toLocaleTimeString();
    const mine = state.turn.activeSlot === state.mySlot;
    $("fire").disabled = !mine;
    const player = state.players.find((candidate) => candidate.slot === state.mySlot);
    if (player && player.angle10 != null) {
      $("angle").value = (player.angle10 / 10).toFixed(1);
      $("power").value = player.power;
      $("weapon").value = String(player.weaponId);
    }
  }

  function fire() {
    if (!state.turn) return;
    const sent = send({
      t: "intent",
      turnNo: state.turn.turnNo,
      activeSlot: state.turn.activeSlot,
      angle10: Math.round(+$("angle").value * 10),
      power: Math.round(+$("power").value),
      weaponId: +$("weapon").value,
      moveDx: Math.round(+$("move").value),
      useShield: $("shield").checked,
    });
    if (sent) $("fire").disabled = true;
  }

  async function inspectFullStateGrid(compressed, expectedChecksum) {
    if (!("DecompressionStream" in window)) {
      log(`FULL STATE ${compressed.length.toLocaleString()} bytes · gzip 검증 미지원`, "err");
      return;
    }
    try {
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
      const grid = new Uint8Array(await new Response(stream).arrayBuffer());
      if (grid.length !== 518400) throw new Error(`격자 길이 ${grid.length}`);
      for (let index = 0; index < grid.length; index += 1) {
        if (grid[index] > 5) throw new Error(`재질 범위 초과 idx=${index} value=${grid[index]}`);
      }
      const checksum = fnv1a32(grid);
      if (checksum !== expectedChecksum) {
        throw new Error(`checksum ${hex(checksum)} != ${hex(expectedChecksum)}`);
      }
      state.grid = grid;
      log(`FULL STATE 검증 완료 · raw ${grid.length.toLocaleString()} bytes · ${hex(checksum)}`);
    } catch (error) {
      log(`FULL STATE 검증 실패: ${error.message}`, "err");
    }
  }

  function fnv1a32(bytes) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < bytes.length; index += 1) {
      hash = Math.imul(hash ^ bytes[index], 0x01000193) >>> 0;
    }
    return hash;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char]);
  }

  function hex(value) {
    return `0x${Number(value).toString(16).toUpperCase().padStart(8, "0")}`;
  }

  function migrateLegacySession() {
    try {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_SESSION_KEY) || "null");
      if (legacy && legacy.token) saveSession(legacy);
    } catch (_) {
      localStorage.removeItem(LEGACY_SESSION_KEY);
    }
    localStorage.removeItem(LEGACY_SESSION_KEY);
  }

  $("create").onclick = createRoom;
  $("join").onclick = joinRoom;
  $("resume").onclick = resumeSelectedSession;
  $("start").onclick = () => send({ t: "start" });
  $("resync").onclick = () => send({
    t: "resyncReq",
    turnNo: state.turn ? state.turn.turnNo : 0,
    myChecksum: state.grid ? fnv1a32(state.grid) : 0,
  });
  $("reconnect").onclick = connect;
  $("leave").onclick = clearSession;
  $("fire").onclick = fire;
  $("shopReady").onclick = () => {
    if (send({ t: "shopReady", roundNo: state.roundNo })) $("shopReady").disabled = true;
  };
  $("shopReady").disabled = true;
  window.addEventListener("online", () => {
    if (state.session && !state.ws && !state.leaving) connect();
  });

  (async function boot() {
    try {
      const response = await fetch("/version");
      if (!response.ok) throw new Error(`/version HTTP ${response.status}`);
      state.version = await response.json();
      $("version").textContent = `protocol ${state.version.protocol_version} · sim ${state.version.sim_version}`;
      migrateLegacySession();
      renderRecentSessions();
      const activeId = sessionStorage.getItem(ACTIVE_SESSION_KEY);
      const active = activeId && readSavedSessions()[activeId];
      if (active) {
        activateSession(active);
        connect();
      }
    } catch (error) {
      log(`부팅 실패: ${error.message}`, "err");
    }
  })();
})();
