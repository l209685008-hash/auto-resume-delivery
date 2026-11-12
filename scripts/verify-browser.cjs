const { chromium } = require("playwright");
const { readFileSync, mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const http = require("node:http");

const root = path.resolve(__dirname, "..");
const releaseVersion = require("../manifest.json").version;
const output = path.join(root, "test-results");
mkdirSync(output, { recursive: true });
const results = [];

async function installChrome(page, options = {}) {
  await page.addInitScript((options) => {
    const data = {};
    const changes = [];
    const attempted = new Set();
    const frames = options.frames || (options.partialFrames ? [
      { frameId: 0, url: "https://www.zhipin.com/web/chat/recommend", receiver: "connected" },
      { frameId: 2, url: "https://www.zhipin.com/web/frame/recommend", receiver: "missing" }
    ] : [{ frameId: 0, url: "https://www.zhipin.com/web/chat/recommend", receiver: "missing" }]);
    const tabEvents = { activated: [], updated: [], removed: [] };
    const allowedFrame = (frame) => {
      try { const url = new URL(frame.url); return frame.frameId >= 0 && url.protocol === "https:" && (url.hostname === "zhipin.com" || url.hostname.endsWith(".zhipin.com")); }
      catch (_) { return false; }
    };
    const frameHealth = () => ({ ownerStale: false,
      missingFrameIds: frames.filter((frame) => allowedFrame(frame) && frame.receiver === "missing").map((frame) => frame.frameId),
      frames: frames.map((frame) => ({ frameId: frame.frameId, url: frame.url, connected: frame.receiver === "connected",
        frameReady: frame.receiver === "connected", runnerVersion: frame.receiver === "connected" ? "0.2.0" : "",
        error: frame.receiver === "missing" ? "receiver_not_found" : frame.error || "" })) });
    window.testBridge = { clicks: 0, prepared: 0, data, changes, owner: null, requests: [], injected: false, injections: [], frames, frameRequests: [], frameEnumerations: 0,
      tab: { id: 7, windowId: 1, url: options.tabUrl || "https://www.zhipin.com/web/chat/recommend" }, tabEvents,
      routeFailure: options.routeFailure || null, unconfirmedInjections: options.unconfirmedInjections || 0 };
    const store = {
      get(keys, callback) {
        const value = typeof keys === "string" ? { [keys]: data[keys] } : { ...keys, ...data };
        if (callback) callback(value);
        return Promise.resolve(value);
      },
      set(value, callback) {
        Object.assign(data, structuredClone(value));
        const lastAudit = value.bossGreetingAuditLog?.at(-1);
        if (options.removeMajorAfterEvaluation && lastAudit?.type === "CANDIDATE_EVALUATED" && lastAudit.payload.outcome === "match") {
          const education = document.querySelector("[data-candidate-id='synthetic-match'] [data-education]");
          if (education) education.textContent = "中专 已毕业 会计学专业";
        }
        for (const listener of changes) listener(Object.fromEntries(Object.entries(value).map(([key, newValue]) => [key, { newValue }])), "local");
        if (callback) callback();
        return Promise.resolve();
      }
    };
    window.chrome = {
      runtime: {
        getManifest: () => ({ version: options.releaseVersion }),
        onMessage: { addListener() {} },
        sendMessage(payload, callback) {
          let response;
          if (payload.type === "BGA_ROUTE_TO_CANDIDATE") {
            window.testBridge.requests.push(structuredClone(payload.payload));
            if (window.testBridge.routeFailure) {
              response = structuredClone(window.testBridge.routeFailure);
              if (callback) callback(response);
              return Promise.resolve(response);
            }
            if (options.offline) return Promise.reject(new Error(options.connectionError || "模拟页面连接断开"));
            if (options.missingAll && !window.testBridge.injected) {
              response = { ok: false, error: "receiver_not_found: 页面脚本尚未连接", connectionDiagnostics: frameHealth() };
              if (callback) callback(response);
              return Promise.resolve(response);
            }
            response = { ok: true, response: { ok: true, state: options.panelState || {
              running: false, status: "idle", frameReady: true, runnerVersion: "0.5.6", profileId: "cross_border_finance"
            } } };
            if (options.partialFrames && !window.testBridge.injected) response.response.state = {
              ...response.response.state, frameReady: false,
              connectionDiagnostics: { frames: frames.map((frame) => ({ ...frame, connected: frame.receiver === "connected",
                frameReady: false, error: frame.receiver === "missing" ? "receiver_not_found" : "" })), missingFrameIds: [2] }
            };
            if (window.testBridge.injected) response.response.state = { ...response.response.state, connectionDiagnostics: frameHealth() };
          } else if (payload.type === "BGA_CLAIM_RUN") {
            window.testBridge.owner = payload.runId;
            response = { ok: true, jobText: "跨境电商财务" };
          } else if (payload.type === "BGA_VALIDATE_RUN") response = { ok: true, jobText: "跨境电商财务" };
          else if (payload.type === "BGA_RELEASE_RUN") { window.testBridge.owner = null; response = { ok: true }; }
          else if (payload.type === "BGA_PREPARE_ATTEMPT") {
            const allowed = !attempted.has(payload.candidateKey);
            attempted.add(payload.candidateKey);
            window.testBridge.prepared += 1;
            response = { ok: true, allowed };
            if (options.stopBeforeClick) {
              window.BossGreetingAssistantHandleMessage({ type: "BGA_STOP" }).then(() => callback(response));
              return;
            }
          } else if (payload.type === "BGA_TRUSTED_CLICK") {
            window.testBridge.clicks += 1;
            if (!options.unconfirmed) document.querySelector(`[data-candidate-id='${payload.candidateKey.replace(/^id:/, "")}'] .greet`).textContent = "继续沟通";
            response = { ok: true };
          } else response = { ok: true };
          if (callback) callback(response);
          return Promise.resolve(response);
        }
      },
      storage: { local: store, onChanged: { addListener: (listener) => changes.push(listener) } },
      extension: { getViews: () => options.popup ? [window] : [] },
      tabs: {
        query: async () => [structuredClone(window.testBridge.tab)],
        get: async () => structuredClone(window.testBridge.tab),
        onActivated: { addListener: (listener) => tabEvents.activated.push(listener) },
        onUpdated: { addListener: (listener) => tabEvents.updated.push(listener) },
        onRemoved: { addListener: (listener) => tabEvents.removed.push(listener) },
        sendMessage(tabId, payload, target, callback) {
          window.testBridge.frameRequests.push(structuredClone({ tabId, payload, target }));
          const frame = frames.find((item) => item.frameId === target.frameId);
          if (frame?.receiver === "connected") callback({ ok: true, state: options.panelState });
          else if (frame?.receiver === "invalid") callback({ ok: false, error: "receiver_not_found: invalid response" });
          else if (frame?.receiver === "empty") callback();
          else {
            chrome.runtime.lastError = { message: frame?.error || "Could not establish connection. Receiving end does not exist." };
            try { callback(); } finally { delete chrome.runtime.lastError; }
          }
        }
      },
      webNavigation: { getAllFrames(_details, callback) {
        window.testBridge.frameEnumerations += 1;
        if (options.frameEnumerationError) chrome.runtime.lastError = { message: options.frameEnumerationError };
        try { callback(structuredClone(frames)); } finally { delete chrome.runtime.lastError; }
      } },
      scripting: { executeScript: async (request) => {
        window.testBridge.injections.push(structuredClone(request));
        if (options.injectionError) throw new Error(options.injectionError);
        if (options.failFirstInjection && window.testBridge.injections.length === 1) throw new Error("模拟首次补注入失败");
        if (window.testBridge.injections.length <= window.testBridge.unconfirmedInjections) return [];
        for (const frame of frames) if (request.target.frameIds.includes(frame.frameId)) frame.receiver = "connected";
        window.testBridge.injected = true;
        return [];
      } },
      sidePanel: { open: async () => {} },
      windows: { getCurrent: async () => ({ id: 1 }) }
    };
    if (options.cachedState) data.bossGreetingState = options.cachedState;
  }, { ...options, releaseVersion });
}

async function replay(browser, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 850 } });
  const page = await context.newPage();
  await installChrome(page, options);
  await page.route("https://www.zhipin.com/**", (route) => route.fulfill({
    contentType: "text/html", body: readFileSync(path.join(root, "tests/fixtures/candidates.html"), "utf8")
  }));
  await page.goto("https://www.zhipin.com/__local_synthetic_replay");
  const scripts = ["candidateIdentity", "domSelectors", "auditLogger", "safetyGuards", "financeRules", "profileExtractor", "candidateScanner"];
  for (const file of scripts) await page.addScriptTag({ path: path.join(root, `src/content/${file}.js`) });
  await page.evaluate(() => { window.BossGreetingSafety.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 3))); });
  return { page, context };
}

async function start(page, config = {}) {
  const reply = await page.evaluate((config) => window.BossGreetingAssistantHandleMessage({
    type: "BGA_START", config: { maxGreetings: 1, dryRun: true, ...config }
  }), config);
  assert.equal(reply.ok, true);
  await page.waitForFunction(() => !window.testBridge.data.bossGreetingState?.running, { timeout: 10000 });
  return page.evaluate(() => window.testBridge.data.bossGreetingState);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  let server;
  try {
    console.log("Checking local candidate replay...");
    for (const dryRun of [true, false]) {
      const { page, context } = await replay(browser);
      await page.evaluate(() => {
        const original = document.querySelector("[data-candidate-id='synthetic-review']").cloneNode(true);
        document.querySelectorAll("article").forEach((card) => card.remove());
        for (let index = 0; index < 137; index += 1) {
          const card = original.cloneNode(true);
          card.dataset.candidateId = "review-" + index;
          document.body.append(card);
        }
      });
      const state = await start(page, { dryRun, maxCandidates: 100, maxGreetings: 60 });
      assert.equal(state.processedCount, 100);
      assert.equal(state.rejectedCount, 100);
      assert.equal(state.eligibleCount, 0);
      assert.equal(state.status, "scan_limit_reached");
      assert.equal(await page.evaluate(() => testBridge.clicks + testBridge.prepared), 0);
      results.push(`100-person scan cap: 137 rejected cards, dryRun=${dryRun}, zero sends`);
      await context.close();
    }
    {
      const { page, context } = await replay(browser);
      const state = await start(page);
      assert.equal(state.eligibleCount, 1);
      assert.equal(state.rejectedCount, 2);
      assert.equal(state.greetedCount, 0);
      assert.equal(await page.evaluate(() => testBridge.clicks), 0);
      await page.evaluate(() => { window.originalRunnerHandler = BossGreetingAssistantHandleMessage; });
      await page.addScriptTag({ path: path.join(root, "src/content/candidateScanner.js") });
      assert.equal(await page.evaluate(() => BossGreetingAssistantHandleMessage === originalRunnerHandler), true);
      results.push("scan-only: match/reject and zero sends; reinjection guard");
      await context.close();
    }
    {
      const { page, context } = await replay(browser);
      const state = await start(page, { dryRun: false });
      assert.equal(state.clickAttemptCount, 1);
      assert.equal(state.greetedCount, 1);
      assert.equal(await page.evaluate(() => testBridge.clicks), 1);
      results.push("send replay: only fully matched candidate, same-button confirmation");
      await context.close();
    }
    {
      const { page, context } = await replay(browser, { unconfirmed: true });
      await page.evaluate(() => {
        window.identityCard = document.querySelector("[data-candidate-id='synthetic-match']");
        identityCard.removeAttribute("data-candidate-id");
        identityCard.insertAdjacentHTML("beforeend", '<a href="/geek/stable-profile.html?source=one">简历</a>');
      });
      const state = await start(page, { dryRun: false });
      assert.equal(state.unconfirmedCount, 1);
      assert.equal(state.greetedCount, 0);
      await page.evaluate(() => {
        identityCard.setAttribute("data-candidate-id", "stable-profile");
        identityCard.querySelector("a").href = "/geek/stable-profile.html?source=two";
      });
      await start(page, { dryRun: false });
      assert.equal(await page.evaluate(() => testBridge.clicks), 1);
      results.push("uncertain result: no success count or retry after URL identity gains a data id");
      await context.close();
    }
    {
      const { page, context } = await replay(browser, { removeMajorAfterEvaluation: true });
      const state = await start(page, { dryRun: false });
      assert.equal(state.greetedCount, 0);
      assert.equal(state.eligibleCount, 0);
      assert.equal(await page.evaluate(() => testBridge.clicks), 0);
      results.push("changed qualification after audit: re-evaluated before any send");
      await context.close();
    }
    {
      const { page, context } = await replay(browser);
      const outcome = await page.evaluate(() => {
        const card = document.querySelector("[data-candidate-id='synthetic-match']");
        const complete = BossFinanceRules.evaluate(BossFinanceProfile.extract(card));
        card.insertAdjacentHTML("beforeend", '<div data-work-entry>另一家测试公司\n财务会计\n日期未展示\n负责跨境平台核算</div>');
        const incomplete = BossFinanceRules.evaluate(BossFinanceProfile.extract(card));
        return { major: complete.checks.find((item) => item.key === "major").status,
          keyword: complete.checks.find((item) => item.key === "keyword").status,
          before: complete.matchedKeywords, after: incomplete.matchedKeywords };
      });
      assert.equal(outcome.major, "pass");
      assert.equal(outcome.keyword, "pass");
      assert.deepEqual(outcome.after.slice().sort(), outcome.before.slice().sort());
      results.push("extraction: an extra undated job never changes the keyword result");
      await context.close();
    }
    {
      const { page, context } = await replay(browser, { stopBeforeClick: true });
      await start(page, { dryRun: false });
      assert.equal(await page.evaluate(() => testBridge.clicks), 0);
      results.push("stop between preparation and click: zero sends");
      await context.close();
    }
    {
      const { page, context } = await replay(browser);
      await page.evaluate(() => { const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog"); dialog.textContent = "请完成安全验证"; document.body.append(dialog); });
      const state = await start(page, { dryRun: false });
      assert.equal(state.status, "human_required");
      assert.equal(await page.evaluate(() => testBridge.clicks), 0);
      results.push("visible security challenge: immediate stop and zero sends");
      await context.close();
    }

    const { PROFILE, evaluate } = require("../src/content/financeRules.js");
    const base = { educationText: "本科 已毕业 会计学专业",
      workEntries: [{ company: "演示跨境电商公司", title: "财务会计", description: "负责亚马逊平台财务核算", start: "2025-05", end: "2026-11", kind: "formal" }] };
    const matched = evaluate(base);
    const rejectedMajor = evaluate({ ...base, educationText: "中专 已毕业 会计学专业" });
    const rejectedKeyword = evaluate({ ...base, text: "", workEntries: [{ ...base.workEntries[0], company: "某国内贸易公司", description: "负责日常报销" }] });
    const panelState = { runnerVersion: "0.5.6", profileId: "cross_border_finance", rulesVersion: PROFILE.version,
      running: false, status: "limit_reached", phase: "stopped", frameReady: true,
      runId: "synthetic-panel-run", currentJobText: PROFILE.title, lastMessage: "本地合成验证：扫描完成",
      updatedAt: new Date().toISOString(), processedCount: 3, eligibleCount: 1, rejectedCount: 2, greetedCount: 0, dryRunMatches: 1, clickAttemptCount: 0,
      recentCandidates: [matched, rejectedMajor, rejectedKeyword].map((item, index) => ({ ...item,
        candidateKey: `synthetic-${index}`, name: ["演示候选甲", "演示候选乙", "演示候选丙"][index], sendStatus: index === 0 ? "dry_run" : "not_sent" })) };

    server = http.createServer((request, response) => {
      try {
        const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
        const file = path.resolve(root, "." + pathname);
        if (!file.startsWith(root + path.sep)) throw new Error("Invalid path");
        response.setHeader("Content-Type", file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8");
        response.end(readFileSync(file));
      } catch (_) { response.statusCode = 404; response.end(); }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    console.log("Checking panel layout...");
    {
      const privateName = "PRIVATE_CANDIDATE_ZHANG";
      const privateQuery = "private-query-token";
      const privateUrl = `https://www.zhipin.com/web/chat/recommend?candidate=${privateName}&token=${privateQuery}#resume`;
      const maliciousError = `receiver_not_found: ${privateName} ${privateUrl}`;
      const mixedFrames = [
        { frameId: 0, url: "https://www.zhipin.com/web/chat/recommend", receiver: "connected" },
        { frameId: 2, url: "https://sub.zhipin.com/web/chat/recommend", receiver: "missing" },
        { frameId: 3, url: "http://www.zhipin.com/web/chat/recommend", receiver: "missing" },
        { frameId: 4, url: "https://other.example/web/chat/recommend", receiver: "missing" },
        { frameId: 5, url: "about:blank", receiver: "missing" },
        { frameId: 6, url: "https://zhipin.com.other.example/", receiver: "missing" },
        { frameId: 7, url: "https://www.zhipin.com/invalid", receiver: "invalid" },
        { frameId: 8, url: "https://www.zhipin.com/empty", receiver: "empty" },
        { frameId: 9, url: "https://www.zhipin.com/closed", error: "The message port closed before a response was received." },
        { frameId: -1, url: "https://www.zhipin.com/invalid-id", receiver: "missing" }
      ];
      const assertReadOnly = async (page) => {
        const activity = await page.evaluate(() => ({ requests: testBridge.requests, probes: testBridge.frameRequests, clicks: testBridge.clicks }));
        assert.equal(activity.clicks, 0);
        assert.ok(activity.requests.every((request) => request.type === "BGA_STATE"));
        assert.ok(activity.probes.every((request) => request.tabId === 7 && request.payload.type === "BGA_STATE"));
        assert.ok(activity.probes.every((request) => Number.isSafeInteger(request.target.frameId) && !request.target.allFrames));
      };
      const exportReport = async (page, name) => {
        const downloaded = page.waitForEvent("download");
        await page.locator("#exportDiagnostics").click();
        const destination = path.join(output, name + ".json");
        await (await downloaded).saveAs(destination);
        return JSON.parse(readFileSync(destination, "utf8"));
      };
      const privateDiagnostics = (error) => ({ ownerStale: true, missingFrameIds: [], candidateName: privateName,
        frames: [{ frameId: 2, url: privateUrl, connected: false, frameReady: false, runnerVersion: "0.5.6",
          error: `${error}: ${privateName} ${privateQuery}`, candidateName: privateName,
          nested: { url: privateUrl, resume: privateQuery } }] });
      const cases = [
        ["partial online handler failure: claimed missing frame cannot trigger injection", { panelState: {
          ...panelState, frameReady: false,
          connectionDiagnostics: { ownerStale: false, missingFrameIds: [2], frames: [
            { frameId: 0, url: privateUrl, connected: true, frameReady: false, runnerVersion: "0.5.6", error: "" },
            { frameId: 2, url: privateUrl, connected: false, frameReady: false,
              error: `page_script_error: ${maliciousError}` }
          ] }
        } }, async (page) => {
          await page.waitForFunction(() => document.querySelector("#connection").dataset.kind === "waiting");
          assert.equal(await page.evaluate(() => testBridge.injections.length), 0);
          const report = await exportReport(page, "partial-online-handler-error");
          assert.equal(report.connectionDiagnostics.frames[1].error, "page_script_error");
          assert.deepEqual(report.connectionDiagnostics.missingFrameIds, [2]);
          assert.equal(JSON.stringify(report).includes(privateName), false);
          assert.equal(JSON.stringify(report).includes(privateQuery), false);
          await assertReadOnly(page);
        }],
        ["failed injection: offline exports retain port_closed across backoff", {
          panelState, missingAll: true,
          injectionError: `The message port closed before a response was received. ${privateName} ${privateUrl}`
        }, async (page) => {
          await page.waitForFunction(() => document.querySelector("#connection").dataset.kind === "offline");
          const report = await exportReport(page, "injection-port-closed");
          assert.equal(report.connectionError, "port_closed");
          assert.equal(report.connectionDiagnostics.injectionError, "port_closed");
          assert.equal(report.recoveryStage, "injection_failed");
          assert.equal(JSON.stringify(report).includes(privateName), false);
          assert.equal(JSON.stringify(report).includes(privateQuery), false);
          await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
          await page.waitForFunction(() => !document.querySelector("#reconnect").disabled);
          const backoff = await exportReport(page, "injection-port-closed-backoff");
          assert.equal(backoff.connectionDiagnostics.injectionError, "port_closed");
          assert.equal(backoff.recoveryStage, "backoff");
          assert.equal(await page.evaluate(() => testBridge.injections.length), 1);
          await assertReadOnly(page);
        }],
        ...[
          ["handler failure", { ok: true, response: { ok: false, error: maliciousError } }],
          ["invalid state", { ok: true, response: { ok: true, state: null } }]
        ].map(([name, envelope]) => [
          `route ${name}: error retains frame health and cannot trigger reinjection`,
          { routeFailure: { ...envelope, connectionDiagnostics: privateDiagnostics("page_script_error") } }, async (page) => {
            await page.waitForFunction(() => document.querySelector("#connection").dataset.kind === "offline");
            const report = await exportReport(page, `route-${name.replaceAll(" ", "-")}`);
            assert.equal(report.connectionError, "page_script_error");
            assert.equal(report.connectionDiagnostics.frames[0].error, "page_script_error");
            assert.equal(report.recoveryStage, "route_failed");
            assert.equal(await page.evaluate(() => testBridge.injections.length), 0);
            assert.equal(JSON.stringify(report).includes(privateName), false);
            assert.equal(JSON.stringify(report).includes(privateQuery), false);
            await assertReadOnly(page);
          }
        ]),
        ["targeted scripting permission error: offline export preserves safe failure stage", {
          panelState, missingAll: true, injectionError: `Cannot access contents of url ${privateUrl}: ${privateName}`
        }, async (page) => {
          await page.waitForFunction(() => document.querySelector("#connection").dataset.kind === "offline");
          const report = await exportReport(page, "scripting-permission-error");
          assert.equal(report.connectionError, "permission_denied");
          assert.equal(report.connectionDiagnostics.injectionError, "permission_denied");
          assert.equal(report.connectionDiagnostics.frames[0].error, "receiver_not_found");
          assert.equal(report.recoveryStage, "injection_failed");
          assert.equal(JSON.stringify(report).includes(privateName), false);
          assert.equal(JSON.stringify(report).includes(privateQuery), false);
          assert.match(await page.locator("#connectionMessage").textContent(), /权限/);
          await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
          await page.waitForFunction(() => !document.querySelector("#reconnect").disabled);
          assert.equal(await page.evaluate(() => testBridge.injections.length), 1);
          const backoff = await exportReport(page, "scripting-permission-backoff");
          assert.equal(backoff.recoveryStage, "backoff");
          assert.equal(backoff.connectionDiagnostics.injectionError, "permission_denied");
          await assertReadOnly(page);
        }],
        ...[
          ["frame_state_timeout", "timeout", /超时/],
          ["page_script_error", "page_script_error", /脚本.*异常/],
          ["runner_dependencies_missing", "runner_dependencies_missing", /依赖.*缺失/],
          ["boss_frame_not_found", "boss_frame_not_found", /未找到.*页面/],
          ["The message port closed before a response was received.", "port_closed", /消息通道/],
          ["port_closed", "port_closed", /消息通道/],
          ["Cannot access contents of url", "permission_denied", /权限/],
          ["missing host permission", "permission_denied", /权限/],
          ["缺少脚本执行权限", "permission_denied", /权限/]
        ].map(([error, safeCode, label]) => [
          `offline envelope: ${error} retains private-safe frame health without repair`,
          { tabUrl: privateUrl, routeFailure: { ok: false, error: `${error}: ${privateName} ${privateUrl}`,
            connectionDiagnostics: privateDiagnostics(error) } }, async (page) => {
            await page.waitForFunction(() => document.querySelector("#connection").dataset.kind === "offline");
            const report = await exportReport(page, `offline-${error}`);
            assert.ok(report.connectionDiagnostics, "failed route must retain connectionDiagnostics");
            assert.equal(report.connectionError, safeCode);
            assert.equal(report.connectionDiagnostics.frames[0].error, safeCode);
            assert.equal(report.connectionDiagnostics.frames[0].frameId, 2);
            assert.equal(report.connectionDiagnostics.frames[0].url, "https://www.zhipin.com/web/chat/recommend");
            assert.equal(report.connectionDiagnostics.frames[0].connected, false);
            assert.equal(report.connectionDiagnostics.frames[0].runnerVersion, "0.5.6");
            assert.equal(report.connectionDiagnostics.ownerStale, true);
            assert.equal(report.recoveryStage, "route_failed");
            assert.equal(report.tabId, 7);
            assert.ok(Number.isFinite(Date.parse(report.attemptedAt)));
            assert.equal(JSON.stringify(report).includes(privateName), false);
            assert.equal(JSON.stringify(report).includes(privateQuery), false);
            assert.match(await page.locator("#connectionMessage").textContent(), label);
            assert.equal(await page.evaluate(() => testBridge.injections.length), 0);
            assert.equal(await page.locator("#start").isDisabled(), true);
            assert.equal(await page.locator("#stop").isDisabled(), true);
            assert.equal(await page.locator("#dryRun").isChecked(), true);
            await assertReadOnly(page);
          }
        ]),
        ...["tab", "url"].map((change) => [
          `offline diagnostics: ${change} changes discard stale frame health even before refresh`,
          { tabUrl: privateUrl, routeFailure: { ok: false, error: "page_script_error",
            connectionDiagnostics: privateDiagnostics("page_script_error") } }, async (page) => {
            await page.waitForFunction(() => document.querySelector("#connection").dataset.kind === "offline");
            const before = await exportReport(page, `before-${change}-change`);
            assert.ok(before.connectionDiagnostics, "fixture must start with failed frame health");
            await page.evaluate((change) => {
              if (change === "tab") testBridge.tab.id = 8;
              else testBridge.tab.url = "https://www.zhipin.com/web/geek/list?new=private";
              testBridge.routeFailure = { ok: false, error: "boss_frame_not_found" };
            }, change);
            const after = await exportReport(page, `after-${change}-change`);
            assert.equal(after.connectionDiagnostics, null);
            assert.equal(after.pageDiagnostics, null);
            assert.equal(after.recoveryStage, "");
            assert.equal(after.connectionError, "");
            assert.equal(after.tabId, null);
            assert.equal(after.attemptedAt, "");
            await page.evaluate((change) => {
              if (change === "tab") testBridge.tabEvents.activated.forEach((listener) => listener({ tabId: testBridge.tab.id }));
              else testBridge.tabEvents.updated.forEach((listener) => listener(testBridge.tab.id, { url: testBridge.tab.url }));
            }, change);
            await page.waitForFunction(() => !document.querySelector("#reconnect").disabled);
            const fresh = await exportReport(page, `fresh-${change}-change`);
            assert.equal(fresh.connectionError, "boss_frame_not_found");
            assert.equal(fresh.connectionDiagnostics, null);
            assert.equal(fresh.recoveryStage, "route_failed");
            await assertReadOnly(page);
          }
        ]),
        ...[false, true].map((partialFrames) => [
          `unconfirmed ${partialFrames ? "partial" : "offline"} injection: backoff, bounded retry, manual recovery`,
          { panelState, missingAll: !partialFrames, partialFrames, unconfirmedInjections: 2, fixedTime: true }, async (page) => {
            await page.waitForFunction(() => !document.querySelector("#reconnect").disabled);
            assert.equal(await page.evaluate(() => testBridge.injections.length), 1);
            const first = await exportReport(page, `unconfirmed-${partialFrames}-first`);
            await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
            await page.waitForFunction(() => !document.querySelector("#reconnect").disabled);
            assert.equal(await page.evaluate(() => testBridge.injections.length), 1, "unconfirmed injection must honor backoff");
            const backedOff = await exportReport(page, `unconfirmed-${partialFrames}-backoff`);
            await page.clock.setFixedTime(new Date("2026-11-07T00:00:11Z"));
            await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
            await page.waitForFunction(() => !document.querySelector("#reconnect").disabled);
            assert.equal(await page.evaluate(() => testBridge.injections.length), 2, "unverified executeScript must not be cached as healthy");
            assert.equal(first.recoveryStage, "verification_failed");
            assert.ok(first.connectionDiagnostics.frames.some((frame) => !frame.connected));
            assert.equal(backedOff.recoveryStage, "backoff");
            await page.clock.setFixedTime(new Date("2026-11-07T00:05:00Z"));
            await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
            await page.waitForFunction(() => !document.querySelector("#reconnect").disabled);
            assert.equal(await page.evaluate(() => testBridge.injections.length), 2, "automatic repairs must stop at their bound");
            const exhausted = await exportReport(page, `unconfirmed-${partialFrames}-exhausted`);
            assert.equal(exhausted.recoveryStage, "repair_exhausted");
            await page.locator("#reconnect").click();
            await page.waitForFunction(() => !document.querySelector("#start").disabled);
            assert.equal(await page.evaluate(() => testBridge.injections.length), 3);
            const stateReads = await page.evaluate(() => testBridge.requests.length);
            await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
            await page.waitForFunction((reads) => testBridge.requests.length > reads && !document.querySelector("#reconnect").disabled, stateReads);
            assert.equal(await page.evaluate(() => testBridge.injections.length), 3);
            await assertReadOnly(page);
          }
        ]),
        ["all-offline recovery: only definitely missing allowed HTTPS frame is injected", { panelState, missingAll: true, frames: mixedFrames }, async (page) => {
          await page.waitForFunction(() => !document.querySelector("#start").disabled);
          const activity = await page.evaluate(() => ({ injections: testBridge.injections, probes: testBridge.frameRequests }));
          assert.deepEqual(activity.injections.map((request) => request.target), [{ tabId: 7, frameIds: [2] }]);
          assert.deepEqual(activity.probes.map((request) => request.target.frameId).sort((a, b) => a - b), [0, 2, 7, 8, 9]);
          await assertReadOnly(page);
          await page.evaluate(() => { testBridge.injected = false; document.dispatchEvent(new Event("visibilitychange")); });
          await page.waitForFunction(() => document.querySelector("#connection").dataset.kind === "offline");
          assert.equal(await page.evaluate(() => testBridge.injections.length), 1, "successful repair stays cached until manual reconnect");
          await assertReadOnly(page);
        }],
        ["all-offline recovery: no injection for connected, ambiguous or disallowed frames", { panelState, missingAll: true, frames: mixedFrames.filter((frame) => frame.frameId !== 2) }, async (page) => {
          await page.waitForFunction(() => document.querySelector("#connection").dataset.kind !== "connecting");
          assert.equal(await page.locator("#connection").getAttribute("data-kind"), "offline");
          assert.equal(await page.evaluate(() => testBridge.injections.length), 0);
          assert.match(await page.locator("#connectionMessage").textContent(), /接收器未连接/);
          const report = await exportReport(page, "offline-confirmed-probes");
          assert.equal(report.connectionError, "receiver_not_found");
          assert.equal(report.recoveryStage, "no_missing_frames");
          assert.ok(report.connectionDiagnostics.frames.some((frame) => frame.frameId === 7 && frame.error === "page_script_error"));
          await assertReadOnly(page);
        }],
        ["all-offline recovery: frame enumeration failure fails closed", { panelState, missingAll: true, frameEnumerationError: "frame inventory unavailable" }, async (page) => {
          await page.waitForFunction(() => document.querySelector("#connection").dataset.kind !== "connecting");
          assert.equal(await page.locator("#connection").getAttribute("data-kind"), "offline");
          assert.equal(await page.evaluate(() => testBridge.injections.length), 0);
          await assertReadOnly(page);
        }],
        ["failed targeted injection: automatic backoff and explicit reconnect", { panelState, missingAll: true, failFirstInjection: true, frames: mixedFrames }, async (page) => {
          await page.waitForFunction(() => document.querySelector("#connection").dataset.kind === "offline");
          await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
          await page.waitForFunction(() => !document.querySelector("#reconnect").disabled);
          assert.equal(await page.evaluate(() => testBridge.frameEnumerations), 2, "automatic refresh must rediscover frames");
          assert.equal(await page.evaluate(() => testBridge.injections.length), 1, "automatic refresh must honor injection backoff");
          await page.locator("#reconnect").click();
          await page.waitForFunction(() => !document.querySelector("#start").disabled);
          assert.deepEqual(await page.evaluate(() => testBridge.injections.map((request) => request.target)), [
            { tabId: 7, frameIds: [2] }, { tabId: 7, frameIds: [2] }
          ]);
          await assertReadOnly(page);
        }],
        ["offline diagnostic export: raw connection error is replaced with a safe code", { offline: true, connectionError: maliciousError, tabUrl: privateUrl }, async (page) => {
          await page.waitForFunction(() => document.querySelector("#connection").dataset.kind === "offline");
          const report = await exportReport(page, "offline-safe-diagnostics");
          assert.equal(report.connectionError, "receiver_not_found");
          assert.equal(report.pageUrl, "https://www.zhipin.com/web/chat/recommend");
          assert.equal(JSON.stringify(report).includes(privateName), false);
          assert.equal(JSON.stringify(report).includes(privateQuery), false);
          await assertReadOnly(page);
        }],
        ["live diagnostic export: nested errors and extra text never escape structural allowlists", { panelState: {
          ...panelState, frameReady: false,
          pageDiagnostics: { version: 1, pageUrl: privateUrl, candidateCount: 0, greetControlCount: 2, greetedControlCount: 1,
            rawCardElementCount: 3, candidateName: privateName, error: maliciousError,
            actionSamples: [{ action: privateName, resume: privateQuery, ancestors: [
              { tag: "BUTTON", classes: ["greet", "btn-primary", privateUrl, privateName, privateQuery], text: privateName, title: privateQuery }
            ] }] },
          connectionDiagnostics: { ownerStale: true, missingFrameIds: [], error: maliciousError, injectionError: maliciousError,
            candidateName: privateName, frames: [{ frameId: 0, url: privateUrl, connected: true, frameReady: false,
              runnerVersion: "0.5.6", error: maliciousError, candidateName: privateName, nested: { error: maliciousError } },
              { frameId: 1, url: `https://${privateName}.zhipin.com/web/chat/${privateName}?token=${privateQuery}`,
                runnerVersion: maliciousError, error: `${privateName} ${privateQuery}` },
              { frameId: 2, url: `https://other.example/${privateName}`, error: "frame_state_timeout" },
              { frameId: 3, url: "about:blank", error: "The message port closed before a response was received." }] }
        } }, async (page) => {
          await page.waitForFunction(() => document.querySelector("#connection").dataset.kind === "waiting");
          const report = await exportReport(page, "live-safe-diagnostics");
          const serialized = JSON.stringify(report);
          assert.equal(serialized.includes(privateName), false);
          assert.equal(serialized.includes(privateQuery), false);
          assert.equal(serialized.includes("?candidate="), false);
          assert.equal(report.pageDiagnostics.greetControlCount, 2);
          assert.equal(report.pageDiagnostics.actionSamples[0].action, undefined);
          assert.deepEqual(report.pageDiagnostics.actionSamples[0].ancestors[0], { tag: "button", classes: ["greet", "btn-primary"] });
          assert.equal(report.connectionDiagnostics.injectionError, "receiver_not_found");
          assert.equal(report.connectionDiagnostics.frames[0].error, "receiver_not_found");
          assert.equal(report.connectionDiagnostics.frames[0].url, "https://www.zhipin.com/web/chat/recommend");
          assert.equal(report.connectionDiagnostics.frames[0].runnerVersion, "0.5.6");
          assert.equal(report.connectionDiagnostics.frames[1].runnerVersion, "");
          assert.equal(report.connectionDiagnostics.frames[1].url, "https://subdomain.zhipin.com/web/chat/:redacted");
          assert.equal(report.connectionDiagnostics.frames[1].error, "connection_failed");
          assert.equal(report.connectionDiagnostics.frames[2].url, "");
          assert.equal(report.connectionDiagnostics.frames[2].error, "timeout");
          assert.equal(report.connectionDiagnostics.frames[3].url, "");
          assert.equal(report.connectionDiagnostics.frames[3].error, "port_closed");
          assert.equal(report.connectionDiagnostics.ownerStale, true);
          await assertReadOnly(page);
        }]
      ];
      const failures = [];
      for (const [name, options, verify] of cases) {
        const context = await browser.newContext({ viewport: { width: 380, height: 600 } });
        try {
          const page = await context.newPage();
          if (options.fixedTime) await page.clock.setFixedTime(new Date("2026-11-07T00:00:00Z"));
          await installChrome(page, options);
          await page.goto(`http://127.0.0.1:${port}/src/popup/popup.html`);
          await verify(page);
          results.push(name);
        } catch (error) { failures.push(name + ": " + error.message); }
        finally { await context.close(); }
      }
      assert.deepEqual(failures, [], "popup recovery/export regressions");
    }
    {
      const context = await browser.newContext({ viewport: { width: 380, height: 600 } });
      const page = await context.newPage();
      const waiting = { ...panelState, frameReady: false,
        pageDiagnostics: { pageUrl: "https://www.zhipin.com/web/chat/recommend", candidateCount: 0, greetControlCount: 2 },
        connectionDiagnostics: { frames: [{ frameId: 0, connected: true, frameReady: false }], missingFrameIds: [] }
      };
      await installChrome(page, { panelState: waiting });
      await page.goto(`http://127.0.0.1:${port}/src/popup/popup.html`);
      await page.waitForFunction(() => document.querySelector("#connection").dataset.kind === "waiting");
      assert.equal(await page.locator("#connectionLabel").textContent(), "页面已连接");
      assert.equal(await page.locator("#start").isDisabled(), true);
      assert.match(await page.locator("#connectionMessage").textContent(), /卡片结构/);
      const exported = page.waitForEvent("download");
      await page.locator("#exportDiagnostics").click();
      const download = await exported;
      assert.match(download.suggestedFilename(), /^boss-page-diagnostics-/);
      const destination = path.join(output, "page-diagnostics-export.json");
      await download.saveAs(destination);
      const report = JSON.parse(readFileSync(destination, "utf8"));
      assert.equal(report.pageDiagnostics.greetControlCount, 2);
      assert.equal(JSON.stringify(report).includes("演示候选甲"), false);
      assert.equal(await page.evaluate(() => testBridge.requests.some((item) => item.type === "BGA_START")), false);
      await page.screenshot({ path: path.join(output, "panel-waiting-diagnostics.png"), fullPage: true });
      results.push("connected empty list: distinct waiting state, safe controls, diagnostics without resume text");
      await context.close();
    }
    {
      const context = await browser.newContext({ viewport: { width: 380, height: 600 } });
      const page = await context.newPage();
      await installChrome(page, { panelState, partialFrames: true });
      await page.goto(`http://127.0.0.1:${port}/src/popup/popup.html`);
      await page.waitForFunction(() => !document.querySelector("#start").disabled, null, { timeout: 3000 });
      const injections = await page.evaluate(() => testBridge.injections);
      assert.equal(injections.length, 1);
      assert.deepEqual(injections[0].target, { tabId: 7, frameIds: [2] });
      assert.equal(await page.evaluate(() => testBridge.requests.some((item) => item.type === "BGA_START")), false);
      results.push("partial iframe connection: missing frame repaired once without starting a run");
      await context.close();
    }
    {
      const context = await browser.newContext({ viewport: { width: 380, height: 600 } });
      const page = await context.newPage();
      await installChrome(page, { panelState, missingAll: true, failFirstInjection: true });
      await page.goto(`http://127.0.0.1:${port}/src/popup/popup.html`);
      await page.waitForFunction(() => document.querySelector("#connection").dataset.kind === "offline");
      await page.locator("#reconnect").click();
      await page.waitForFunction(() => !document.querySelector("#start").disabled, null, { timeout: 3000 });
      assert.equal(await page.evaluate(() => testBridge.injections.length), 2);
      results.push("failed injection: explicit reconnect can retry and restore the page connection");
      await context.close();
    }
    {
      const context = await browser.newContext({ viewport: { width: 140, height: 600 } });
      const page = await context.newPage();
      await installChrome(page, { panelState, popup: true });
      await page.goto(`http://127.0.0.1:${port}/src/popup/popup.html`);
      await page.waitForFunction(() => document.querySelectorAll("#requirements li").length === 2);
      const width = await page.evaluate(() => document.documentElement.getBoundingClientRect().width);
      assert.equal(width, 380, "popup must expose its own width while Chrome sizes the initial narrow viewport");
      await page.setViewportSize({ width: 380, height: 600 });
      for (const selector of ["#profileTitle", ".mode-selector span", "#startLabel"]) {
        const rows = await page.locator(selector).evaluateAll((nodes) => nodes.map((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          return new Set(Array.from(range.getClientRects()).filter((rect) => rect.width && rect.height).map((rect) => Math.round(rect.top))).size;
        }));
        assert.ok(rows.every((count) => count === 1), `${selector} must remain horizontal`);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(output, "popup-layout-380.png"), fullPage: true });
      results.push("popup intrinsic width: initial 140px viewport cannot collapse the 380px workbench");
      await context.close();
    }
    for (const width of [320, 380, 480]) {
      const context = await browser.newContext({ viewport: { width, height: 600 } });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => { errors.push(error.message); console.error("Panel error:", error.message); });
      await installChrome(page, { panelState });
      await page.goto(`http://127.0.0.1:${port}/src/popup/popup.html`);
      assert.deepEqual(errors, []);
      await page.waitForFunction(() => document.querySelectorAll(".candidate-row").length === 3, null, { timeout: 10000 });
      assert.deepEqual(errors, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.locator("#filterReject").check();
      assert.equal(await page.locator(".candidate-row").count(), 2);
      await page.locator("#filterAll").check();
      await page.locator(".candidate-evidence").first().evaluate((node) => { node.open = true; });
      await page.evaluate(() => window.scrollTo(0, 0));
      const toolbar = await page.locator(".run-actions").boundingBox();
      assert.ok(toolbar && toolbar.y >= 0 && toolbar.y + toolbar.height <= 600, "run controls must be in the first viewport");
      await page.screenshot({ path: path.join(output, `panel-${width}.png`), fullPage: true });
      await page.screenshot({ path: path.join(output, `viewport-${width}.png`) });
      results.push(`panel ${width}px: no horizontal overflow, filters and expanded evidence`);
      await context.close();
    }
    {
      const context = await browser.newContext({ viewport: { width: 380, height: 600 } });
      const page = await context.newPage();
      await installChrome(page, { panelState });
      await page.goto(`http://127.0.0.1:${port}/src/popup/popup.html`);
      await page.waitForFunction(() => !document.querySelector("#start").disabled);
      assert.equal(await page.locator("#dryRun").isChecked(), true);
      assert.equal(await page.evaluate(() => testBridge.requests.some((item) => item.type === "BGA_START")), false);
      await page.locator("#greetMode").check();
      await page.locator(".settings").evaluate((element) => { element.open = true; });
      await page.locator("#maxCandidates").fill("13");
      await page.locator("#maxCandidates").dispatchEvent("change");
      await page.locator("#maxGreetings").fill("3");
      await page.locator("#maxGreetings").dispatchEvent("change");
      await page.locator("#start").evaluate((element) => { element.click(); element.click(); });
      await page.waitForFunction(() => testBridge.requests.some((item) => item.type === "BGA_START"));
      const starts = await page.evaluate(() => testBridge.requests.filter((item) => item.type === "BGA_START"));
      assert.equal(starts.length, 1);
      assert.equal(starts[0].config.dryRun, false);
      assert.equal(starts[0].config.maxCandidates, 13);
      assert.equal(starts[0].config.maxGreetings, 3);
      assert.equal(starts[0].config.profileId, "cross_border_finance");
      results.push("panel controls: scan default, saved limits, explicit mode, double-start prevention");
      await context.close();
    }
    {
      const context = await browser.newContext({ viewport: { width: 380, height: 600 } });
      const page = await context.newPage();
      await installChrome(page, { offline: true, cachedState: { ...panelState, running: true, status: "running" } });
      await page.goto(`http://127.0.0.1:${port}/src/popup/popup.html`);
      await page.waitForFunction(() => document.querySelector("#connection").dataset.kind === "offline");
      assert.equal(await page.locator("#start").isDisabled(), true);
      assert.equal(await page.locator("#stop").isDisabled(), true);
      await page.screenshot({ path: path.join(output, "panel-offline.png"), fullPage: true });
      results.push("offline cached running state: clearly labelled and no live controls");
      await context.close();
    }
    {
      const extension = await chromium.launchPersistentContext(path.join(output, "extension-profile-" + Date.now()), {
        channel: "chromium", headless: true, viewport: { width: 400, height: 700 },
        args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
      });
      try {
        const worker = extension.serviceWorkers()[0] || await extension.waitForEvent("serviceworker", { timeout: 10000 });
        const id = new URL(worker.url()).host;
        assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().version), releaseVersion);
        const page = await extension.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`chrome-extension://${id}/src/popup/popup.html`);
        await page.waitForFunction(() => document.querySelector("#connection").dataset.kind === "offline", null, { timeout: 10000 });
        assert.deepEqual(errors, []);
        assert.equal(await page.locator("#requirements li").count(), 2);
        assert.equal(await page.locator("#start").isDisabled(), true);
        await page.screenshot({ path: path.join(output, "actual-extension-loaded.png"), fullPage: true });
        results.push("actual MV3 extension: service worker loaded, two requirements, no page errors");
      } finally { await extension.close(); }
    }
    writeFileSync(path.join(output, "browser-verification.json"), JSON.stringify({ generatedAt: new Date().toISOString(), browser: browser.version(), checks: results }, null, 2));
    for (const result of results) console.log("PASS", result);
  } finally {
    await browser.close();
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
