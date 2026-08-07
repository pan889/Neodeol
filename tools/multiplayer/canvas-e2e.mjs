#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const base = process.env.TALUS_BASE || `http://localhost:${process.env.TALUS_PORT || "8000"}`;
const chromeBin = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const savedSessionsKey = "talus.multiplayer.sessions.v1";
const activeSessionKey = "talus.multiplayer.active.v1";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

class CdpPage {
  constructor(label, socket) {
    this.label = label;
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.errors = [];

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result || {});
        return;
      }
      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params.exceptionDetails;
        const description = details.exception?.description || details.text || "runtime exception";
        this.errors.push(description);
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        const text = message.params.args.map((arg) => arg.value || arg.description || "").join(" ");
        this.errors.push(`console.error: ${text}`);
      }
    });

    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`${this.label}: CDP socket closed`));
      }
      this.pending.clear();
    });
  }

  async send(method, params = {}) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label}: CDP ${method} timed out`));
      }, 10000);
      this.pending.set(id, { resolve, reject, method, timer });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      const description = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
      throw new Error(`${this.label}: ${description}`);
    }
    return response.result?.value;
  }

  async navigate(url) {
    await this.send("Page.navigate", { url });
    await this.waitFor("document.readyState === 'complete'", 20000, `load ${url}`);
  }

  async waitFor(expression, timeoutMs, description) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(expression)) return;
        lastError = null;
      } catch (error) {
        lastError = error;
      }
      await sleep(100);
    }
    const snapshot = await this.snapshot().catch(() => null);
    const suffix = lastError ? `; last error=${lastError.message}` : "";
    throw new Error(`${this.label}: timeout waiting for ${description}${suffix}; state=${JSON.stringify(snapshot)}`);
  }

  async snapshot() {
    return this.evaluate(`(() => ({
      title: document.title,
      room: document.querySelector('#netRoom')?.textContent || '',
      connection: document.querySelector('#netConn')?.textContent || '',
      phase: document.querySelector('#oPhase')?.textContent || '',
      who: document.querySelector('#whoTurn')?.textContent || '',
      startDisabled: document.querySelector('#bSetup')?.disabled ?? null,
      fireDisabled: document.querySelector('#bFire')?.disabled ?? null,
      log: (document.querySelector('#log')?.textContent || '').slice(0, 1200),
    }))()`);
  }

  close() {
    this.socket.close();
  }
}

async function connectCdpPage(debugBase, label) {
  const response = await fetch(`${debugBase}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" });
  if (!response.ok) throw new Error(`Chrome target HTTP ${response.status}`);
  const target = await response.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const page = new CdpPage(label, socket);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  return page;
}

async function waitForChrome(debugBase, chrome, output) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (chrome.exitCode !== null) throw new Error(`Chrome exited ${chrome.exitCode}: ${output.value}`);
    try {
      const response = await fetch(`${debugBase}/json/version`);
      if (response.ok) return;
    } catch (_) {
      // Chrome is still starting.
    }
    await sleep(100);
  }
  throw new Error(`Chrome debugging endpoint did not open: ${output.value}`);
}

function sessionRecord(data, id, name) {
  return { ...data, id, name, savedAt: Date.now() };
}

async function primeSession(page, sessions, activeId) {
  await page.navigate(`${base}/tools/multiplayer/`);
  await page.evaluate(`(() => {
    localStorage.setItem(${JSON.stringify(savedSessionsKey)}, ${JSON.stringify(JSON.stringify(sessions))});
    sessionStorage.setItem(${JSON.stringify(activeSessionKey)}, ${JSON.stringify(activeId)});
    return true;
  })()`);
  await page.navigate(`${base}/tools/prototype/?multiplayer=1`);
  await page.waitFor(
    "document.querySelector('#netConn')?.textContent.includes('연결됨')",
    20000,
    "authoritative room connection",
  );
}

async function main() {
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.ok, true, `${base} server is not healthy`);

  const hostData = await postJson(`${base}/api/rooms`, { name: "E2E Alpha", maxPlayers: 2 });
  const guestData = await postJson(`${base}/api/rooms/${hostData.roomCode}/join`, { name: "E2E Bravo" });
  const host = sessionRecord(hostData, "canvas-e2e-host", "E2E Alpha");
  const guest = sessionRecord(guestData, "canvas-e2e-guest", "E2E Bravo");
  const sessions = { [host.id]: host, [guest.id]: guest };

  const port = await freePort();
  const debugBase = `http://127.0.0.1:${port}`;
  const profile = await mkdtemp(path.join(os.tmpdir(), "talus-canvas-e2e-"));
  const chromeOutput = { value: "" };
  const chrome = spawn(chromeBin, [
    "--headless=new",
    "--disable-gpu",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [chrome.stdout, chrome.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      chromeOutput.value = `${chromeOutput.value}${chunk}`.slice(-8000);
    });
  }

  let hostPage;
  let guestPage;
  try {
    await waitForChrome(debugBase, chrome, chromeOutput);
    [hostPage, guestPage] = await Promise.all([
      connectCdpPage(debugBase, "host"),
      connectCdpPage(debugBase, "guest"),
    ]);
    await Promise.all([
      primeSession(hostPage, sessions, host.id),
      primeSession(guestPage, sessions, guest.id),
    ]);
    console.log(`canvas e2e connected room=${host.roomCode}`);

    await hostPage.waitFor("document.querySelector('#bSetup')?.disabled === false", 20000, "host start button");
    assert.equal(await guestPage.evaluate("document.querySelector('#bSetup')?.disabled"), true);
    await hostPage.evaluate("document.querySelector('#bSetup').click(); true");

    await hostPage.waitFor("document.querySelector('#bFire')?.disabled === false", 30000, "host turn 1 aim");
    await guestPage.waitFor(
      "document.querySelector('#bFire')?.disabled === true && document.querySelector('#whoTurn')?.textContent.includes('E2E Alpha')",
      30000,
      "guest observes host turn 1",
    );
    console.log("canvas e2e turn1 ready");
    const aimBefore = await hostPage.evaluate(`(() => {
      const rect = document.querySelector('#stage').getBoundingClientRect();
      return {
        angle: Number(document.querySelector('#iAngle').value),
        power: Number(document.querySelector('#iPower').value),
        x: rect.left + rect.width * .72,
        y: rect.top + rect.height * .28,
      };
    })()`);
    await hostPage.evaluate(`document.querySelector('#stage').dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, clientX: ${aimBefore.x}, clientY: ${aimBefore.y},
    }))`);
    await hostPage.waitFor(
      `Number(document.querySelector('#iAngle')?.value) !== ${aimBefore.angle}`,
      3000,
      "mouse click angle adjustment",
    );
    await hostPage.evaluate(`document.querySelector('#stage').dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, clientX: ${aimBefore.x}, clientY: ${aimBefore.y}, deltaY: -120,
    }))`);
    await hostPage.waitFor(
      `Number(document.querySelector('#iPower')?.value) === ${Math.min(1000, aimBefore.power + 25)}`,
      3000,
      "mouse wheel power adjustment",
    );
    const pinInput = await hostPage.evaluate(`(() => {
      const rect = document.querySelector('#chargeMeter').getBoundingClientRect();
      return {
        angle: Number(document.querySelector('#iAngle').value),
        x: rect.left + rect.width * .68,
        y: rect.top + rect.height * .5,
      };
    })()`);
    await hostPage.evaluate(`document.querySelector('#chargeMeter').dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, clientX: ${pinInput.x}, clientY: ${pinInput.y},
    }))`);
    await hostPage.waitFor(
      "document.querySelector('#chargeTargetValue')?.textContent === '0680'",
      3000,
      "charge target pin placement",
    );
    assert.equal(await hostPage.evaluate("Number(document.querySelector('#iAngle').value)"), pinInput.angle);
    console.log("canvas e2e input click+wheel+target-pin ok");
    await hostPage.evaluate("document.querySelector('#bFire').click(); true");

    await guestPage.waitFor("document.querySelector('#bFire')?.disabled === false", 60000, "guest turn 2 aim");
    console.log("canvas e2e turn2 ready");
    let summary = await (await fetch(`${base}/api/rooms/${host.roomCode}`)).json();
    assert.equal(summary.telemetry.turns, 1);
    assert.equal(summary.telemetry.desyncs, 0);
    await guestPage.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', {
      key: ' ', code: 'Space', bubbles: true, cancelable: true,
    }))`);
    await guestPage.waitFor(
      "document.querySelector('#powerChargeHud')?.classList.contains('active') === true",
      3000,
      "space charge starts",
    );
    await sleep(420);
    assert.ok(
      await guestPage.evaluate("Number(document.querySelector('#iPower')?.value) >= 150"),
      "space charge gauge did not rise",
    );
    await guestPage.evaluate(`window.dispatchEvent(new KeyboardEvent('keyup', {
      key: ' ', code: 'Space', bubbles: true, cancelable: true,
    }))`);

    await hostPage.waitFor("document.querySelector('#bFire')?.disabled === false", 60000, "host turn 3 aim");
    console.log("canvas e2e turn3 ready");
    summary = await (await fetch(`${base}/api/rooms/${host.roomCode}`)).json();
    assert.equal(summary.telemetry.turns, 2);
    assert.equal(summary.telemetry.desyncs, 0);

    const snapshots = await Promise.all([hostPage.snapshot(), guestPage.snapshot()]);
    for (const [index, page] of [hostPage, guestPage].entries()) {
      assert.deepEqual(page.errors, [], `${page.label} runtime errors: ${page.errors.join("\n")}`);
      assert.equal(snapshots[index].log.includes("DESYNC"), false, `${page.label} reported DESYNC`);
      assert.equal(snapshots[index].log.includes("부팅 실패"), false, `${page.label} boot failed`);
      assert.equal(snapshots[index].log.includes("네트워크 처리 실패"), false, `${page.label} message handling failed`);
    }

    console.log(
      `canvas e2e ok room=${host.roomCode} turns=${summary.telemetry.turns} `
      + `desyncs=${summary.telemetry.desyncs} input=click+wheel+target-pin+space-charge host=${snapshots[0].who} guest=${snapshots[1].who}`,
    );
  } finally {
    hostPage?.close();
    guestPage?.close();
    if (chrome.exitCode === null) chrome.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => chrome.once("exit", resolve)),
      sleep(3000),
    ]);
    if (chrome.exitCode === null) chrome.kill("SIGKILL");
    await rm(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
