const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function setup(options = {}) {
  let listener;
  const local = {};
  const session = {};
  const commands = [];
  const messages = [];
  let frames = options.frames || [{ frameId: 0 }, ...(options.frameId ? [{ frameId: options.frameId }] : [])];
  const frameStates = new Map(Object.entries(options.frameStates || {}).map(([id, state]) => [Number(id), state]));
  let jobText = options.jobText ?? "跨境电商财务";
  const frameJobs = new Map(Object.entries(options.frameJobs || {}).map(([id, text]) => [Number(id), text]));
  let frameOffset = 0;
  let offsetRequests = 0;
  let resumeFinalOffset;
  let reachedFinalOffset;
  const finalOffsetRequested = new Promise((resolve) => { reachedFinalOffset = resolve; });
  let resumeState;
  let reachedState;
  let statePaused = false;
  const stateRequested = new Promise((resolve) => { reachedState = resolve; });
  let ownerReads = 0;
  let resumeOwnerRead;
  let reachedOwnerRead;
  const ownerReadPaused = new Promise((resolve) => { reachedOwnerRead = resolve; });
  const storage = (data) => ({
    get: async (keys) => {
      const value = typeof keys === "string" ? { [keys]: structuredClone(data[keys]) } : { ...keys, ...structuredClone(data) };
      if (data === session && keys === "bossFinanceRunOwner" && ++ownerReads === options.pauseOwnerReadAt) {
        reachedOwnerRead();
        return new Promise((resolve) => { resumeOwnerRead = () => resolve(value); });
      }
      return value;
    },
    set: async (value) => { Object.assign(data, structuredClone(value)); },
    remove: async (key) => { delete data[key]; }
  });
  const sender = { tab: { id: 7, url: "https://www.zhipin.com/web/chat/recommend", active: true },
    frameId: options.frameId || 0, url: "https://www.zhipin.com/web/chat/recommend" };
  const chrome = {
    storage: { local: storage(local), session: storage(session) },
    runtime: { onMessage: { addListener: (handler) => { listener = handler; } } },
    tabs: {
      get: (_id, callback) => callback({ ...sender.tab, active: options.active !== false }),
      sendMessage: (_id, message, target, callback) => {
        messages.push({ frameId: target.frameId, message: structuredClone(message) });
        const state = message.type === options.failControl ? new Error("Could not establish connection. Receiving end does not exist.") : frameStates.get(target.frameId);
        if (state instanceof Error) {
          chrome.runtime.lastError = { message: state.message };
          callback();
          delete chrome.runtime.lastError;
          return;
        }
        if (message.type === "BGA_PAGE_CONTEXT") callback({ ok: true, context: {
          ...(options.frameJobStatuses?.[target.frameId] ? { jobStatus: options.frameJobStatuses[target.frameId] } : {}),
          currentJobText: frameJobs.has(target.frameId) ? frameJobs.get(target.frameId) : jobText
        } });
        else if (message.type === "BGA_GET_FRAME_RECT") {
          offsetRequests += 1;
          const reply = () => callback({ ok: true, rect: { left: frameOffset, top: 0, width: 800, height: 600 } });
          if (options.pauseFinalOffset && offsetRequests === 3) { resumeFinalOffset = reply; reachedFinalOffset(); }
          else reply();
        }
        else if (message.type === "BGA_VALIDATE_TARGET") callback({ ok: options.validTarget !== false });
        else {
          const current = session.bossFinanceRunOwner;
          const response = message.type === "BGA_STATE" && options.frameResponses?.[target.frameId] || { ok: true, state: frameStates.has(target.frameId) ? state : {
            frameReady: true, runnerVersion: "0.2.0",
            running: current?.frameId === target.frameId, runId: current?.frameId === target.frameId ? current.runId : ""
          } };
          if (message.type === "BGA_STATE" && target.frameId === options.pauseStateFrame && !statePaused) {
            statePaused = true;
            resumeState = () => callback(response);
            reachedState();
          } else callback(response);
        }
      },
      onRemoved: { addListener() {} }
    },
    webNavigation: {
      getAllFrames: (_id, callback) => callback(frames.map((frame) => ({ url: sender.url, ...frame }))),
      onCommitted: { addListener() {} }
    },
    debugger: {
      attach: (_target, _version, callback) => { if (options.moveFrameOnAttach) frameOffset = 200; callback(); },
      detach: (_target, callback) => callback(),
      sendCommand: (_target, method, params, callback) => {
        commands.push({ method, params });
        if (options.stopOnMove && params.type === "mouseMoved") delete session.bossFinanceRunOwner;
        const failThisClick = options.failClick === true ||
          (options.failClick === "press" && params.type === "mousePressed");
        if (failThisClick && method === "Input.dispatchMouseEvent") {
          chrome.runtime.lastError = { message: "simulated uncertain click" };
          callback();
          delete chrome.runtime.lastError;
        } else callback({ cssVisualViewport: { clientWidth: 1000, clientHeight: 800 } });
      },
      onDetach: { addListener() {} }
    }
  };
  const sandbox = vm.createContext({ chrome, URL, Date, Set, setTimeout, clearTimeout });
  sandbox.importScripts = (file) => vm.runInContext(readFileSync(path.join(__dirname, "../src/background", file), "utf8"), sandbox);
  vm.runInContext(readFileSync(path.join(__dirname, "../src/background/serviceWorker.js"), "utf8"), sandbox);
  const call = (message, from = sender) => new Promise((resolve) => listener(message, from, resolve));
  return { call, local, session, commands, messages, sender, finalOffsetRequested,
    setFrames: (value) => { frames = value; }, setFrameState: (id, state) => frameStates.set(id, state),
    stateRequested, resumeState: () => resumeState(),
    ownerReadPaused, resumeOwnerRead: () => resumeOwnerRead(),
    resumeFinalOffset: () => resumeFinalOffset(), setJob: (value) => { jobText = value; },
    setFrameJob: (id, value) => frameJobs.set(id, value) };
}

test("only one run can claim the UI even with concurrent starts", async () => {
  const app = setup();
  const responses = await Promise.all(["a", "b"].map((runId) => app.call({ type: "BGA_CLAIM_RUN", runId, dryRun: true })));
  assert.equal(responses.filter((item) => item.ok).length, 1);
});

test("unidentified vacancy allows scanning but blocks sending", async () => {
  const app = setup({ jobText: "" });
  assert.equal((await app.call({ type: "BGA_CLAIM_RUN", runId: "a", dryRun: false })).ok, false);
  assert.equal((await app.call({ type: "BGA_CLAIM_RUN", runId: "a", dryRun: true })).ok, true);
  assert.equal((await app.call({ type: "BGA_PREPARE_ATTEMPT", runId: "a", candidateKey: "x" })).ok, false);
});

test("selected job in the initiating candidate iframe authorizes the run", async () => {
  const app = setup({ frameId: 3, frameJobs: { 0: "", 3: "跨境电商会计-双休朝九晚六_宁波 6-7K" } });
  const response = await app.call({ type: "BGA_CLAIM_RUN", runId: "iframe-job", dryRun: false });
  assert.equal(response.ok, true, response.error);
  assert.equal(response.jobText, "跨境电商会计-双休朝九晚六_宁波 6-7K");
  assert.deepEqual(app.messages.filter((item) => item.message.type === "BGA_PAGE_CONTEXT").map((item) => item.frameId), [0, 3]);
});

test("conflicting top and candidate-frame selected jobs cannot authorize sending", async () => {
  const app = setup({ frameId: 3, frameJobs: { 0: "跨境电商财务", 3: "国内会计" } });
  const response = await app.call({ type: "BGA_CLAIM_RUN", runId: "conflict", dryRun: false });
  assert.equal(response.ok, false);
  assert.equal(app.session.bossFinanceRunOwner, undefined);
  assert.equal(app.commands.length, 0);
});

test("a changed candidate-frame selected job blocks preparation despite an unchanged top job", async () => {
  const app = setup({ frameId: 3, frameJobs: { 0: "跨境电商财务", 3: "跨境电商财务" } });
  assert.equal((await app.call({ type: "BGA_CLAIM_RUN", runId: "changed-child", dryRun: false })).ok, true);
  app.setFrameJob(3, "国内会计");
  const response = await app.call({ type: "BGA_PREPARE_ATTEMPT", runId: "changed-child", candidateKey: "id:synth" });
  assert.equal(response.ok, false);
  assert.deepEqual(app.local.bossFinanceGreetingAttempts || [], []);
  assert.equal(app.commands.length, 0);
});

test("losing any frame that established the selected job blocks validation and preparation", async () => {
  for (const frameId of [0, 3]) {
    const app = setup({ frameId: 3, frameJobs: { 0: "跨境电商财务", 3: "跨境电商财务" } });
    assert.equal((await app.call({ type: "BGA_CLAIM_RUN", runId: "lost-job", dryRun: false })).ok, true);
    app.setFrameJob(frameId, "");
    assert.equal((await app.call({ type: "BGA_VALIDATE_RUN", runId: "lost-job" })).ok, false);
    assert.equal((await app.call({ type: "BGA_PREPARE_ATTEMPT", runId: "lost-job", candidateKey: "id:lost" })).ok, false);
    assert.deepEqual(app.local.bossFinanceGreetingAttempts || [], []);
    assert.equal(app.commands.length, 0);
  }
});

test("losing the selected source after preparation prevents the trusted click", async () => {
  const app = setup({ frameId: 3, frameJobs: { 0: "跨境电商财务", 3: "跨境电商财务" } });
  assert.equal((await app.call({ type: "BGA_CLAIM_RUN", runId: "lost-prepared", dryRun: false })).ok, true);
  assert.equal((await app.call({ type: "BGA_PREPARE_ATTEMPT", runId: "lost-prepared", candidateKey: "id:lost-prepared" })).allowed, true);
  app.setFrameJob(3, "");
  assert.equal((await app.call({ type: "BGA_TRUSTED_CLICK", runId: "lost-prepared", candidateKey: "id:lost-prepared",
    rect: { left: 10, top: 10, width: 50, height: 20 } })).ok, false);
  assert.equal(app.commands.length, 0);
});

test("local selector ambiguity cannot fall back to the other frame's valid job", async () => {
  const app = setup({ frameId: 3, frameJobs: { 0: "跨境电商财务", 3: "" }, frameJobStatuses: { 3: "ambiguous" } });
  assert.equal((await app.call({ type: "BGA_CLAIM_RUN", runId: "ambiguous-child", dryRun: false })).ok, false);
  assert.equal(app.session.bossFinanceRunOwner, undefined);
});

test("a definitely missing top receiver does not hide a selected candidate-frame job", async () => {
  const app = setup({ frameId: 3, frameJobs: { 3: "跨境电商会计" },
    frameStates: { 0: new Error("Could not establish connection. Receiving end does not exist.") } });
  const response = await app.call({ type: "BGA_CLAIM_RUN", runId: "missing-top", dryRun: false });
  assert.equal(response.ok, true, response.error);
  assert.equal(response.jobText, "跨境电商会计");
});

test("candidate attempts persist across runs and cannot be retried", async () => {
  const app = setup();
  await app.call({ type: "BGA_CLAIM_RUN", runId: "a", dryRun: false });
  assert.equal((await app.call({ type: "BGA_PREPARE_ATTEMPT", runId: "a", candidateKey: "x" })).allowed, true);
  await app.call({ type: "BGA_RELEASE_RUN", runId: "a" });
  await app.call({ type: "BGA_CLAIM_RUN", runId: "b", dryRun: false });
  assert.equal((await app.call({ type: "BGA_PREPARE_ATTEMPT", runId: "b", candidateKey: "x" })).allowed, false);
});

test("a click that fails before the press releases the attempt", async () => {
  // 鼠标还没按下就失败（坐标换算、校验、连接），说明根本没发出去，不该永久封掉候选人。
  const app = setup({ failClick: true });
  await app.call({ type: "BGA_CLAIM_RUN", runId: "a", dryRun: false });
  await app.call({ type: "BGA_PREPARE_ATTEMPT", runId: "a", candidateKey: "x" });
  const click = { type: "BGA_TRUSTED_CLICK", runId: "a", candidateKey: "x", rect: { left: 100, top: 100, width: 50, height: 30 } };
  assert.equal((await app.call(click)).ok, false);
  assert.equal(app.local.bossFinanceGreetingAttempts.length, 0);
  const count = app.commands.length;
  assert.equal((await app.call(click)).ok, false);
  assert.equal(app.commands.length, count, "缺少持久记录时不得再发一次点击");
});

test("an uncertain press keeps the record and never dispatches twice", async () => {
  const app = setup({ failClick: "press" });
  await app.call({ type: "BGA_CLAIM_RUN", runId: "a", dryRun: false });
  await app.call({ type: "BGA_PREPARE_ATTEMPT", runId: "a", candidateKey: "x" });
  const click = { type: "BGA_TRUSTED_CLICK", runId: "a", candidateKey: "x", rect: { left: 100, top: 100, width: 50, height: 30 } };
  assert.equal((await app.call(click)).ok, false);
  assert.equal(app.local.bossFinanceGreetingAttempts[0].status, "clicked_unknown");
  const count = app.commands.length;
  assert.equal((await app.call(click)).ok, false);
  assert.equal(app.commands.length, count);
});

test("a changed job or inactive tab prevents dispatch", async () => {
  for (const mode of ["job", "tab", "target"]) {
    const app = setup({ active: mode !== "tab", validTarget: mode !== "target" });
    await app.call({ type: "BGA_CLAIM_RUN", runId: "a", dryRun: false });
    await app.call({ type: "BGA_PREPARE_ATTEMPT", runId: "a", candidateKey: "x" });
    if (mode === "job") app.setJob("仓库主管");
    const result = await app.call({ type: "BGA_TRUSTED_CLICK", runId: "a", candidateKey: "x", rect: { left: 10, top: 10, width: 50, height: 20 } });
    assert.equal(result.ok, false);
    assert.equal(app.commands.length, 0);
  }
});

test("attempt cap counts unconfirmed attempts, not just successes", async () => {
  const app = setup();
  await app.call({ type: "BGA_CLAIM_RUN", runId: "a", dryRun: false });
  for (let index = 0; index < 60; index += 1) {
    assert.equal((await app.call({ type: "BGA_PREPARE_ATTEMPT", runId: "a", candidateKey: String(index) })).allowed, true);
  }
  assert.equal((await app.call({ type: "BGA_PREPARE_ATTEMPT", runId: "a", candidateKey: "61" })).ok, false);
});

test("lookalike hosts and ambiguous candidate frames fail closed", async () => {
  const app = setup({ frames: [{ frameId: 0 }, { frameId: 1 }] });
  const fake = { ...app.sender, url: "https://fakezhipin.com/a" };
  assert.equal((await app.call({ type: "BGA_CLAIM_RUN", runId: "a", dryRun: true }, fake)).ok, false);
  const routed = await app.call({ type: "BGA_ROUTE_TO_CANDIDATE", tabId: 7, payload: { type: "BGA_START" } });
  assert.equal(routed.ok, false);
});

test("stop prevents new sends while an in-flight outcome can still be recorded", async () => {
  const app = setup();
  await app.call({ type: "BGA_CLAIM_RUN", runId: "a", dryRun: false });
  await app.call({ type: "BGA_PREPARE_ATTEMPT", runId: "a", candidateKey: "x" });
  await app.call({ type: "BGA_RELEASE_RUN", runId: "a" });
  assert.equal((await app.call({ type: "BGA_TRUSTED_CLICK", runId: "a", candidateKey: "x" })).ok, false);
  assert.equal((await app.call({ type: "BGA_FINISH_ATTEMPT", runId: "a", candidateKey: "x", outcome: "unconfirmed" })).ok, true);
});

test("moving iframe after debugger attach cancels before dispatch", async () => {
  const app = setup({ frameId: 3, moveFrameOnAttach: true });
  await app.call({ type: "BGA_CLAIM_RUN", runId: "a", dryRun: false });
  await app.call({ type: "BGA_PREPARE_ATTEMPT", runId: "a", candidateKey: "x" });
  const result = await app.call({ type: "BGA_TRUSTED_CLICK", runId: "a", candidateKey: "x", rect: { left: 10, top: 10, width: 50, height: 20 } });
  assert.equal(result.ok, false);
  assert.equal(app.commands.some((item) => item.params.type === "mousePressed"), false);
});

test("stop received after pointer movement cancels the pending press", async () => {
  const app = setup({ stopOnMove: true });
  await app.call({ type: "BGA_CLAIM_RUN", runId: "a", dryRun: false });
  await app.call({ type: "BGA_PREPARE_ATTEMPT", runId: "a", candidateKey: "x" });
  const result = await app.call({ type: "BGA_TRUSTED_CLICK", runId: "a", candidateKey: "x", rect: { left: 10, top: 10, width: 50, height: 20 } });
  assert.equal(result.ok, false);
  assert.equal(app.commands.some((item) => item.params.type === "mouseMoved"), true);
  assert.equal(app.commands.some((item) => item.params.type === "mousePressed"), false);
});

test("profile URL identity followed by a data id never allows a second attempt", async () => {
  const app = setup();
  await app.call({ type: "BGA_CLAIM_RUN", runId: "a", dryRun: false });
  await app.call({ type: "BGA_PREPARE_ATTEMPT", runId: "a", candidateKey: "profile:person123" });
  await app.call({ type: "BGA_RELEASE_RUN", runId: "a" });
  await app.call({ type: "BGA_CLAIM_RUN", runId: "b", dryRun: false });
  const result = await app.call({ type: "BGA_PREPARE_ATTEMPT", runId: "b", candidateKey: "id:person123" });
  assert.equal(result.allowed, false);
  assert.equal(app.local.bossFinanceGreetingAttempts.length, 1);
});

test("co-occurring aliases preserve no-retry after the profile link disappears", async () => {
  const app = setup();
  app.local.bossFinanceGreetingAttempts = [{ candidateKey: "https://www.zhipin.com/geek/person123.html?source=old", status: "clicked_unknown" }];
  await app.call({ type: "BGA_CLAIM_RUN", runId: "a", dryRun: false });
  assert.equal((await app.call({ type: "BGA_PREPARE_ATTEMPT", runId: "a", candidateKey: "id:new-data-id",
    candidateAliases: ["id:new-data-id", "profile:person123"] })).allowed, false);
  assert.equal((await app.call({ type: "BGA_PREPARE_ATTEMPT", runId: "a", candidateKey: "id:new-data-id" })).allowed, false);
  assert.equal(app.local.bossFinanceGreetingAttempts.length, 1);
});

test("legacy bare ids and tracking URLs remain protected", async () => {
  for (const previous of ["person123", "https://www.zhipin.com/web/geek/detail/person123.html?source=old"]) {
    const app = setup();
    app.local.bossFinanceGreetingAttempts = [{ candidateKey: previous, status: "unconfirmed" }];
    await app.call({ type: "BGA_CLAIM_RUN", runId: "a", dryRun: false });
    assert.equal((await app.call({ type: "BGA_PREPARE_ATTEMPT", runId: "a", candidateKey: "profile:person123" })).allowed, false);
  }
});

test("acknowledged stop during the final iframe lookup cancels mouse press", async () => {
  const app = setup({ frameId: 3, pauseFinalOffset: true });
  await app.call({ type: "BGA_CLAIM_RUN", runId: "a", dryRun: false });
  await app.call({ type: "BGA_PREPARE_ATTEMPT", runId: "a", candidateKey: "x" });
  const clicking = app.call({ type: "BGA_TRUSTED_CLICK", runId: "a", candidateKey: "x",
    rect: { left: 10, top: 10, width: 50, height: 20 } });
  await app.finalOffsetRequested;
  assert.equal((await app.call({ type: "BGA_RELEASE_RUN", runId: "a" })).ok, true);
  app.resumeFinalOffset();
  assert.equal((await clicking).ok, false);
  assert.equal(app.commands.some((item) => item.params.type === "mousePressed"), false);
});

const missingReceiver = () => new Error("Could not establish connection. Receiving end does not exist.");
const route = (app, type = "BGA_STATE") => app.call({ type: "BGA_ROUTE_TO_CANDIDATE", tabId: 7, payload: { type } });

test("STATE returns an online top frame and precise missing-receiver diagnostics before iframe readiness", async () => {
  const pageDiagnostics = { cardCount: 0, reason: "loading", nested: { selector: ".candidate" } };
  const app = setup({
    frames: [
      { frameId: 0, url: "https://www.zhipin.com/web/chat/recommend?token=secret#detail" },
      { frameId: 3, url: "https://www.zhipin.com/web/frame/recommend?token=secret#detail" },
      { frameId: 4, url: "https://fakezhipin.com/frame?token=secret" },
      { frameId: 5, url: "http://www.zhipin.com/frame?token=secret" },
      { frameId: 6, url: "https://www.zhipin.com.evil.test/frame" },
      { frameId: 7, url: "about:blank" },
      { frameId: 8, url: "https://sub.zhipin.com/frame?token=secret" }
    ],
    frameStates: { 0: { frameReady: false, runnerVersion: "0.2.0", pageDiagnostics },
      3: missingReceiver(), 4: missingReceiver(), 5: missingReceiver(), 6: missingReceiver(),
      7: missingReceiver(), 8: new Error("The message port closed before a response was received.") }
  });
  const result = await route(app);
  assert.equal(result.ok, true);
  assert.equal(result.response.frameId, 0);
  assert.equal(result.response.state.frameReady, false);
  assert.deepEqual(result.response.state.pageDiagnostics, pageDiagnostics);
  const diagnostics = result.response.state.connectionDiagnostics;
  assert.deepEqual(Array.from(diagnostics.missingFrameIds), [3]);
  assert.equal(diagnostics.ownerStale, false);
  assert.deepEqual(JSON.parse(JSON.stringify(diagnostics.frames[0])), {
    frameId: 0, url: "https://www.zhipin.com/web/chat/recommend", connected: true,
    frameReady: false, runnerVersion: "0.2.0", error: ""
  });
  assert.deepEqual(JSON.parse(JSON.stringify(diagnostics.frames[1])), {
    frameId: 3, url: "https://www.zhipin.com/web/frame/recommend", connected: false,
    frameReady: false, runnerVersion: "", error: missingReceiver().message
  });
  assert.equal(diagnostics.frames.some((frame) => /[?#]/.test(frame.url)), false);
  assert.deepEqual(app.messages.map((item) => item.frameId), [0, 3, 4, 5, 6, 7, 8]);
  assert.equal(app.messages.every((item) => item.message.type === "BGA_STATE"), true);
});

test("STATE stays connected with all frames online and no candidate cards, then discovers the newly ready iframe", async () => {
  const app = setup({ frames: [{ frameId: 0 }, { frameId: 3 }],
    frameStates: { 0: { frameReady: false }, 3: { frameReady: false } } });
  const loading = await route(app);
  assert.equal(loading.ok, true);
  assert.equal(loading.response.state.frameReady, false);
  assert.equal(loading.response.state.connectionDiagnostics.frames.length, 2);
  assert.deepEqual(Array.from(loading.response.state.connectionDiagnostics.missingFrameIds), []);
  assert.equal((await route(app, "BGA_START")).ok, false);
  assert.equal(app.messages.some((item) => item.message.type === "BGA_START"), false);

  app.setFrameState(3, { frameReady: true, pageDiagnostics: { cardCount: 2 } });
  app.messages.length = 0;
  const ready = await route(app);
  assert.equal(ready.ok, true);
  assert.equal(ready.response.frameId, 3);
  assert.equal(ready.response.state.frameReady, true);
  assert.deepEqual(ready.response.state.pageDiagnostics, { cardCount: 2 });
  assert.deepEqual(app.messages.map((item) => item.frameId), [0, 3]);
  assert.equal((await route(app, "BGA_START")).ok, true);
  assert.deepEqual(app.messages.filter((item) => item.message.type === "BGA_START").map((item) => item.frameId), [3]);
});

test("no online scripts retains receiver_not_found for popup reinjection", async () => {
  const app = setup({ frames: [{ frameId: 0 }, { frameId: 3 }],
    frameStates: { 0: missingReceiver(), 3: missingReceiver() } });
  const result = await route(app);
  assert.equal(result.ok, false);
  assert.match(result.error, /receiver_not_found/);
  assert.equal(app.messages.length, 2);
});

test("offline STATE preserves frame diagnostics for confirmed missing receivers", async () => {
  const app = setup({ frameStates: { 0: missingReceiver() } });
  const result = await route(app);
  assert.equal(result.ok, false);
  assert.match(result.error, /receiver_not_found/);
  assert.deepEqual(Array.from(result.connectionDiagnostics.missingFrameIds), [0]);
  assert.equal(result.connectionDiagnostics.frames[0].connected, false);
});

test("offline STATE identifies a slow receiver instead of declaring it missing", async () => {
  const app = setup({ pauseStateFrame: 0 });
  const pending = route(app);
  await app.stateRequested;
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /frame_state_timeout/);
  assert.deepEqual(Array.from(result.connectionDiagnostics.missingFrameIds), []);
  assert.equal(result.connectionDiagnostics.frames[0].error, "frame_state_timeout");
});

test("offline STATE preserves handler errors without treating them as absent receivers", async () => {
  const app = setup({ frameResponses: { 0: { ok: false, error: "Synthetic initialization failure" } } });
  const result = await route(app);
  assert.equal(result.ok, false);
  assert.match(result.error, /page_script_error/);
  assert.deepEqual(Array.from(result.connectionDiagnostics.missingFrameIds), []);
  assert.equal(result.connectionDiagnostics.frames[0].error, "page_script_error: Synthetic initialization failure");
});

test("handler errors containing transport names never become missing receivers", async () => {
  for (const error of ["receiver_not_found: synthetic handler fault", "frame_state_timeout"]) {
    const app = setup({ frames: [{ frameId: 0 }, { frameId: 3 }], frameStates: { 0: { frameReady: false } },
      frameResponses: { 3: { ok: false, error } } });
    const result = await route(app);
    assert.equal(result.ok, true);
    assert.deepEqual(Array.from(result.response.state.connectionDiagnostics.missingFrameIds), []);
    assert.equal(result.response.state.connectionDiagnostics.frames[1].error, "page_script_error: " + error);
    app.setFrames([{ frameId: 3 }]);
    const offline = await route(app);
    assert.equal(offline.ok, false);
    assert.match(offline.error, /page_script_error/);
    assert.deepEqual(Array.from(offline.connectionDiagnostics.missingFrameIds), []);
  }
});

test("removed owner cancels an in-flight old click before release and STATE can discover a new ready frame", async () => {
  const app = setup({ frameId: 3, pauseFinalOffset: true,
    frameStates: { 0: { frameReady: false } } });
  await app.call({ type: "BGA_CLAIM_RUN", runId: "old", dryRun: false });
  await app.call({ type: "BGA_PREPARE_ATTEMPT", runId: "old", candidateKey: "x" });
  const oldOwner = structuredClone(app.session.bossFinanceRunOwner);
  const clicking = app.call({ type: "BGA_TRUSTED_CLICK", runId: "old", candidateKey: "x",
    rect: { left: 10, top: 10, width: 50, height: 20 } });
  await app.finalOffsetRequested;
  const attempts = structuredClone(app.local.bossFinanceGreetingAttempts);
  app.setFrames([{ frameId: 0 }, { frameId: 9 }]);
  app.setFrameState(3, missingReceiver());
  app.setFrameState(9, { frameReady: true, runId: "", running: false });
  const recovered = await route(app);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.response.frameId, 9);
  assert.equal(recovered.response.state.connectionDiagnostics.ownerStale, true);
  assert.equal(app.session.bossFinanceRunOwner, undefined);
  assert.deepEqual(app.local.bossFinanceGreetingAttempts, attempts);

  // Even a late write of the old owner must not revive the suspended press.
  app.session.bossFinanceRunOwner = oldOwner;
  app.resumeFinalOffset();
  assert.equal((await clicking).ok, false);
  assert.equal(app.commands.some((item) => item.params.type === "mousePressed"), false);
  assert.deepEqual(app.local.bossFinanceGreetingAttempts, attempts);
});

test("owner is reused only for the same running run, and stale control requires a new explicit start", async () => {
  for (const stale of ["removed", "missing", "changed-run", "stopped", "legacy"]) {
    const app = setup({ frameId: 3, frameStates: { 0: { frameReady: false } } });
    await app.call({ type: "BGA_CLAIM_RUN", runId: "old", dryRun: true });
    const active = await route(app, "BGA_STOP");
    assert.equal(active.ok, true);
    assert.equal(active.response.frameId, 3);
    app.setFrames([{ frameId: 0 }, ...(stale === "removed" ? [] : [{ frameId: 3 }]), { frameId: 9 }]);
    app.setFrameState(3, stale === "missing" || stale === "removed" ? missingReceiver() : {
      frameReady: false, ...(stale === "legacy" ? {} : { runId: stale === "changed-run" ? "other" : "old", running: stale !== "stopped" })
    });
    app.setFrameState(9, { frameReady: true });
    const before = app.messages.filter((item) => item.message.type === "BGA_START").length;
    const rejected = await route(app, "BGA_START");
    assert.equal(rejected.ok, false, stale);
    assert.match(rejected.error, /重新开始/);
    assert.equal(app.messages.filter((item) => item.message.type === "BGA_START").length, before);
    assert.equal(app.session.bossFinanceRunOwner, undefined);
    assert.equal((await route(app, "BGA_START")).response.frameId, 9);
    assert.equal((await app.call({ type: "BGA_CLAIM_RUN", runId: "old", dryRun: true })).ok, false);
  }
});

test("STATE preserves the running owner when another candidate list becomes ready", async () => {
  for (const frameReady of [false, true]) {
    const app = setup({ frameId: 3, frames: [{ frameId: 0 }, { frameId: 3 }, { frameId: 9 }],
      frameStates: { 0: { frameReady: false }, 3: { frameReady, running: true, runId: "active" },
        9: { frameReady: true, running: false, runId: "" } } });
    await app.call({ type: "BGA_CLAIM_RUN", runId: "active", dryRun: true });
    app.messages.length = 0;
    const result = await route(app);
    assert.equal(result.ok, true);
    assert.equal(result.response.frameId, 3);
    assert.equal(result.response.state.runId, "active");
    assert.equal(result.response.state.running, true);
    assert.equal(result.response.state.frameReady, frameReady);
    assert.equal(app.messages.every((item) => item.message.type === "BGA_STATE"), true);
    assert.equal((await route(app, "BGA_STOP")).response.frameId, 3);
    assert.deepEqual(app.messages.filter((item) => item.message.type === "BGA_STOP").map((item) => item.frameId), [3]);
  }
});

test("STOP reaches the owner without waiting for an unrelated unresponsive frame", async () => {
  const app = setup({ frameId: 3, frames: [{ frameId: 0 }, { frameId: 3 }, { frameId: 9 }], pauseStateFrame: 9,
    frameStates: { 0: { frameReady: false }, 3: { frameReady: true, running: true, runId: "active" },
      9: { frameReady: false } } });
  await app.call({ type: "BGA_CLAIM_RUN", runId: "active", dryRun: true });
  const result = await Promise.race([route(app, "BGA_STOP"), app.stateRequested.then(() => ({ blockedByOtherFrame: true }))]);
  assert.equal(result.blockedByOtherFrame, undefined);
  assert.equal(result.ok, true);
  assert.deepEqual(app.messages.filter((item) => item.message.type === "BGA_STOP").map((item) => item.frameId), [3]);
});

test("STATE has a bounded wait for an unresponsive frame and retains online diagnostics", async () => {
  const app = setup({ frames: [{ frameId: 0 }, { frameId: 9 }], pauseStateFrame: 9,
    frameStates: { 0: { frameReady: false }, 9: { frameReady: false } } });
  let timer;
  try {
    const result = await Promise.race([route(app), new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), 2500);
    })]);
    assert.equal(result.timedOut, undefined);
    assert.equal(result.ok, true);
    assert.equal(result.response.state.frameReady, false);
    const frame = result.response.state.connectionDiagnostics.frames.find((item) => item.frameId === 9);
    assert.equal(frame.connected, false);
    assert.match(frame.error, /timeout/i);
    assert.deepEqual(Array.from(result.response.state.connectionDiagnostics.missingFrameIds), []);
  } finally { clearTimeout(timer); }
});

test("overlapping stale-owner cleanup cannot remove a newly claimed run", async () => {
  const app = setup({ frameId: 3, pauseOwnerReadAt: 3, frameStates: { 0: { frameReady: false } } });
  await app.call({ type: "BGA_CLAIM_RUN", runId: "old", dryRun: true });
  app.setFrames([{ frameId: 0 }, { frameId: 9 }]);
  app.setFrameState(9, { frameReady: true, running: true, runId: "new" });
  const first = route(app);
  await app.ownerReadPaused;
  const second = route(app);
  await new Promise(setImmediate);
  const claim = app.call({ type: "BGA_CLAIM_RUN", runId: "new", dryRun: true }, { ...app.sender, frameId: 9 });
  await new Promise(setImmediate);
  app.resumeOwnerRead();
  const responses = await Promise.all([first, second, claim]);
  assert.equal(responses[2].ok, true);
  assert.equal(app.session.bossFinanceRunOwner?.runId, "new");
  assert.equal((await app.call({ type: "BGA_CLAIM_RUN", runId: "third", dryRun: true })).ok, false);
  assert.equal(app.commands.length, 0);
});

test("multiple ready frames never receive a start even with an active owner", async () => {
  const app = setup({ frames: [{ frameId: 0 }, { frameId: 3 }] });
  await app.call({ type: "BGA_CLAIM_RUN", runId: "active", dryRun: true });
  const result = await route(app, "BGA_START");
  assert.equal(result.ok, false);
  assert.match(result.error, /多个候选列表/);
  assert.equal(app.messages.some((item) => item.message.type === "BGA_START"), false);
  assert.equal(app.session.bossFinanceRunOwner.runId, "active");
});

test("failed start and click controls are sent once without broadcast or retry", async () => {
  for (const type of ["BGA_START", "BGA_TRUSTED_CLICK"]) {
    const app = setup({ frames: [{ frameId: 0 }, { frameId: 3 }], failControl: type,
      frameStates: { 0: { frameReady: false }, 3: { frameReady: true } } });
    assert.equal((await route(app, type)).ok, false);
    assert.deepEqual(app.messages.filter((item) => item.message.type === type).map((item) => item.frameId), [3]);
  }
});

test("owner cancelled or replaced while other frames are probed cannot dispatch an old control", async () => {
  const app = setup({ frames: [{ frameId: 0 }, { frameId: 9 }], pauseStateFrame: 9,
    frameStates: { 0: { frameReady: false, runId: "old", running: true }, 9: { frameReady: true } } });
  await app.call({ type: "BGA_CLAIM_RUN", runId: "old", dryRun: true });
  const starting = route(app, "BGA_START");
  await app.stateRequested;
  assert.equal((await app.call({ type: "BGA_RELEASE_RUN", runId: "old" })).ok, true);
  assert.equal((await app.call({ type: "BGA_CLAIM_RUN", runId: "new", dryRun: true }, { ...app.sender, frameId: 9 })).ok, true);
  app.resumeState();
  const result = await starting;
  assert.equal(result.ok, false);
  assert.match(result.error, /重新开始/);
  assert.equal(app.messages.some((item) => item.message.type === "BGA_START"), false);
  assert.equal(app.session.bossFinanceRunOwner.runId, "new");
});

test("lookalike and insecure source URLs still cannot claim or click", async () => {
  for (const url of ["https://fakezhipin.com/a", "https://zhipin.com.evil.test/a", "http://www.zhipin.com/a"]) {
    const app = setup();
    const fake = { ...app.sender, url };
    assert.equal((await app.call({ type: "BGA_CLAIM_RUN", runId: "bad", dryRun: false }, fake)).ok, false);
    await app.call({ type: "BGA_CLAIM_RUN", runId: "good", dryRun: false });
    await app.call({ type: "BGA_PREPARE_ATTEMPT", runId: "good", candidateKey: "x" });
    assert.equal((await app.call({ type: "BGA_TRUSTED_CLICK", runId: "good", candidateKey: "x" }, fake)).ok, false);
    assert.equal(app.commands.length, 0);
  }
});
