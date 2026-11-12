"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

async function setup(settings = { maxGreetings: 60 }, state = {}, startError = "") {
  const elements = new Map();
  const listeners = new Map();
  const data = { bossFinanceSettings: settings };
  const requests = [];
  const removed = [];
  function node() {
    return { style: {}, dataset: {}, value: "", checked: false, children: [],
      classList: { toggle() {} }, append(...children) { this.children.push(...children); },
      replaceChildren() {}, removeAttribute() {}, querySelectorAll: () => [], closest: node,
      addEventListener(type, listener) { listeners.set(this.id + ":" + type, listener); }
    };
  }
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, Object.assign(node(), { id }));
    return elements.get(id);
  };
  get("minDelay").value = "2";
  get("maxDelay").value = "5";
  get("maxGreetings").value = "60";
  get("maxCandidates").value = "100";
  get("dryRun").checked = true;
  const document = { documentElement: node(), getElementById: get, createElement: node,
    createDocumentFragment: node, querySelectorAll: () => [], addEventListener() {} };
  const liveState = { frameReady: true, runnerVersion: "0.5.6", profileId: "cross_border_finance",
    rulesVersion: "test", status: "idle", running: false, ...state };
  const tab = { id: 1, windowId: 1, url: "https://www.zhipin.com/synthetic" };
  const chrome = {
    runtime: { async sendMessage(envelope) {
      requests.push(structuredClone(envelope.payload));
      if (envelope.payload.type === "BGA_START" && startError) {
        return { ok: true, response: { ok: false, error: startError } };
      }
      return { ok: true, response: { ok: true, state: liveState } };
    } },
    tabs: { query: async () => [tab], get: async () => tab },
    storage: {
      local: { get: async (defaults) => ({ ...defaults, ...data }),
        async set(value) { Object.assign(data, structuredClone(value)); },
        async remove(key) { for (const name of [].concat(key)) { removed.push(name); delete data[name]; } } },
      onChanged: { addListener() {} }
    }
  };
  const window = { addEventListener() {}, confirm: () => true, BossFinanceRules: { PROFILE: {
    id: "cross_border_finance", title: "test", version: "test", requirements: [{ key: "test" }]
  } } };
  const context = vm.createContext({ window, document, chrome, URL, setTimeout, clearTimeout,
    setInterval: () => 1, clearInterval() {} });
  vm.runInContext(readFileSync(path.join(__dirname, "../src/popup/popup.js"), "utf8"), context);
  await new Promise((resolve) => setImmediate(resolve));
  return { get, data, requests, async change(id, value) {
    get(id).value = String(value);
    const listener = listeners.get(id + ":change");
    assert.ok(listener, `${id} must be a persisted setting`);
    await listener();
    await new Promise((resolve) => setImmediate(resolve));
  }, removed, async start() { await listeners.get("start:click")(); },
  async click(id) { await listeners.get(id + ":click")(); await new Promise((resolve) => setImmediate(resolve)); } };
}

test("popup migrates legacy settings and sends both independent caps in its start command", async () => {
  const app = await setup({ maxGreetings: 9 });
  assert.equal(Number(app.get("maxCandidates").value), 100);
  assert.equal(Number(app.get("maxGreetings").value), 9);
  assert.equal(app.get("start").disabled, false);
  await app.change("maxCandidates", 13);
  await app.start();
  assert.equal(app.data.bossFinanceSettings.maxCandidates, 13);
  assert.equal(app.data.bossFinanceSettings.maxGreetings, 9);
  const starts = app.requests.filter((request) => request.type === "BGA_START");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].config.maxCandidates, 13);
  assert.equal(starts[0].config.maxGreetings, 9);
  assert.equal(starts[0].config.dryRun, true);
  assert.match(app.get("settingsSummary").textContent, /扫描 13 人.*打招呼 9 人/);
});

test("popup clamps scan settings without raising the 60-attempt greeting cap", async () => {
  const app = await setup({ maxCandidates: 999, maxGreetings: 999 });
  assert.equal(Number(app.get("maxCandidates").value), 100);
  assert.equal(Number(app.get("maxGreetings").value), 60);
  await app.change("maxCandidates", 0);
  assert.equal(app.data.bossFinanceSettings.maxCandidates, 1);
  await app.change("maxCandidates", "");
  assert.equal(app.data.bossFinanceSettings.maxCandidates, 100);
});

test("popup locks the scan cap during a run and displays its specific stop reason", async () => {
  const running = await setup({}, { running: true, status: "running" });
  assert.equal(running.get("maxCandidates").disabled, true);
  const stopped = await setup({}, { status: "scan_limit_reached", phase: "stopped",
    lastMessage: "已达到本次扫描人数上限（100 人）" });
  assert.equal(stopped.get("status").textContent, "已达扫描人数上限");
  assert.equal(stopped.get("failure").textContent, "已达到本次扫描人数上限（100 人）");
});

test("settings HTML names scanning and greeting limits separately", () => {
  const html = readFileSync(path.join(__dirname, "../src/popup/popup.html"), "utf8");
  assert.match(html, /for="maxCandidates"><span>扫描人数上限<\/span>.*id="maxCandidates"[^>]*min="1"[^>]*max="100"/);
  assert.match(html, /for="maxGreetings"><span>打招呼上限<\/span>.*id="maxGreetings"[^>]*min="1"[^>]*max="60"/);
});

test("a start error omits the internal page-script prefix from the visible action note", async () => {
  const app = await setup(undefined, {}, "当前岗位选择不明确");
  await app.start();
  assert.match(app.get("actionNote").textContent, /^当前岗位选择不明确。/);
  assert.doesNotMatch(app.get("actionNote").textContent, /page_script_error:/);
  assert.equal(app.requests.filter((request) => request.type === "BGA_START").length, 1);
});

test("clearing send records removes the attempt store so a never-sent candidate can retry", async () => {
  const app = await setup();
  assert.equal(app.get("clearAttempts").disabled, false);
  await app.click("clearAttempts");
  assert.deepEqual(app.removed, ["bossFinanceGreetingAttempts"]);
});
