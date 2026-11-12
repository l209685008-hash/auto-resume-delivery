"use strict";

const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "test-results", "edge-verification");
const profileRoot = path.resolve(os.tmpdir(), "bga-edge-verification");
const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const targetUrl = "https://www.zhipin.com/web/chat/recommend";
const frameUrl = "https://www.zhipin.com/__edge_verification/candidates";
const emptyUrl = "https://www.zhipin.com/web/chat/recommend?edgeVerification=empty";
const denseUrl = "https://www.zhipin.com/web/chat/recommend?edgeVerification=dense";
const headless = !process.argv.includes("--headed");
const startedAt = new Date().toISOString();
const report = {
  startedAt, channel: "msedge", executable: edgePath, headless, targetUrl,
  networkPolicy: "All HTTP(S) routes are fulfilled locally or aborted; browser egress uses a rejecting loopback proxy.",
  profilePolicy: "Fresh mkdtemp only; no existing profile or cookies copied.",
  status: "running", checks: [], requests: [], proxyConnections: 0, errors: [],
  cleanup: { contextClosed: false, profileRemoved: false }
};
let context;
let worker;
let profile;
let createdProfile;
let proxy;
let closing;
let shutdownRequested = false;
let deadline;

function assertActive() {
  if (shutdownRequested) throw new Error("Verification was interrupted; no further actions permitted");
}

function errorRecord(error) {
  return { name: error.name, message: error.message, stack: error.stack };
}

function save() {
  fs.writeFileSync(path.join(output, "verification.json"), JSON.stringify(report, null, 2) + "\n");
}

async function check(name, action) {
  const result = { name, startedAt: new Date().toISOString() };
  try { result.evidence = await action(); result.passed = true; }
  catch (error) { result.passed = false; result.error = errorRecord(error); }
  report.checks.push(result);
  console.log(result.passed ? "PASS" : "FAIL", name, result.error?.message || "");
  save();
}

function assertProfilePath() {
  assert.ok(createdProfile && profile === createdProfile, "Cleanup requires the exact freshly created mkdtemp path");
  const relative = path.relative(profileRoot, path.resolve(profile));
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Profile must be inside the declared temporary root");
  assert.equal(path.dirname(profile), profileRoot);
  assert.ok(path.basename(profile).startsWith("run-"));
  assert.equal(fs.realpathSync(profile), profile);
  assert.equal(fs.lstatSync(profile).isSymbolicLink(), false);
}

async function cleanup() {
  if (closing) return closing;
  closing = (async () => {
    clearTimeout(deadline);
    let closeFailed = false;
    try { if (context) await context.close(); report.cleanup.contextClosed = true; }
    catch (error) { closeFailed = true; report.errors.push({ phase: "context.close", ...errorRecord(error) }); }
    try {
      if (profile && fs.existsSync(profile) && !closeFailed) {
        assertProfilePath();
        report.cleanup.validatedProfile = profile;
        report.cleanup.declaredRoot = profileRoot;
        fs.rmSync(profile, { recursive: true, force: false, maxRetries: 5, retryDelay: 150 });
        report.cleanup.profileRemoved = !fs.existsSync(profile);
      }
    } catch (error) { report.errors.push({ phase: "profile.cleanup", ...errorRecord(error) }); }
    if (proxy?.listening) await new Promise((resolve) => proxy.close(resolve));
    report.finishedAt = new Date().toISOString();
    save();
  })();
  return closing;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    shutdownRequested = true;
    report.status = "interrupted";
    report.errors.push({ phase: "signal", message: signal });
    // Let main reach its finally block, including a launch still in flight.
    if (context) context.close().catch((error) => report.errors.push({ phase: "signal.close", ...errorRecord(error) }));
  });
}

// The real content-script context relays into the real background listener:
// runtime.sendMessage excludes its own sending service-worker context.
async function route(tabId, payload) {
  assertActive();
  assert.ok(["BGA_STATE", "BGA_START"].includes(payload.type), "Only state and explicit dry-run start are permitted");
  if (payload.type === "BGA_START") assert.equal(payload.config?.dryRun, true);
  return worker.evaluate(async ({ tabId, payload }) => {
    const replies = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] }, world: "ISOLATED",
      func: async (message) => chrome.runtime.sendMessage(message),
      args: [{ type: "BGA_ROUTE_TO_CANDIDATE", tabId, payload }]
    });
    return replies[0].result;
  }, { tabId, payload });
}

async function frameStates(tabId) {
  return worker.evaluate(async (tabId) => {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    return Promise.all(frames.map(async (frame) => {
      try {
        const response = await chrome.tabs.sendMessage(tabId, { type: "BGA_STATE" }, { frameId: frame.frameId });
        return { ...frame, response };
      } catch (error) { return { ...frame, error: error.message }; }
    }));
  }, tabId);
}

async function waitForFrames(tabId, count, readyCount) {
  const deadline = Date.now() + 15000;
  let frames;
  do {
    frames = await frameStates(tabId);
    if (frames.length === count && frames.every((frame) => frame.response?.ok) &&
        frames.filter((frame) => frame.response?.state?.frameReady).length === readyCount) return frames;
    await new Promise((resolve) => setTimeout(resolve, 150));
  } while (Date.now() < deadline && !shutdownRequested);
  report.lastFrames = frames;
  throw new Error("Content-script frame readiness timed out: " + JSON.stringify(frames));
}

function verifyDiagnostics(envelope, frames) {
  const diagnostics = envelope.response?.state?.connectionDiagnostics;
  assert.ok(diagnostics && Array.isArray(diagnostics.frames), "connectionDiagnostics.frames is required");
  assert.deepEqual(diagnostics.missingFrameIds, []);
  assert.equal(diagnostics.ownerStale, false);
  assert.deepEqual(diagnostics.frames.map((frame) => frame.frameId).sort(), frames.map((frame) => frame.frameId).sort());
  for (const frame of frames) {
    const diagnostic = diagnostics.frames.find((item) => item.frameId === frame.frameId);
    assert.equal(diagnostic.connected, true);
    assert.equal(diagnostic.frameReady, frame.response.state.frameReady);
  }
  return diagnostics;
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const fixture = fs.readFileSync(path.join(root, "tests", "fixtures", "candidates.html"), "utf8");
  report.manifest = manifest;
  report.sourceHashes = Object.fromEntries(["manifest.json", "src/background/serviceWorker.js", ...manifest.content_scripts.flatMap((entry) => entry.js), "tests/fixtures/candidates.html"]
    .map((file) => [file, createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex")]));
  report.installedEdgeVersion = execFileSync("powershell.exe", ["-NoProfile", "-Command",
    `(Get-Item -LiteralPath '${edgePath}').VersionInfo.ProductVersion`], { encoding: "utf8" }).trim();
  fs.mkdirSync(profileRoot, { recursive: true });
  createdProfile = fs.realpathSync(fs.mkdtempSync(path.join(profileRoot, "run-")));
  profile = createdProfile;
  report.profile = { declaredRoot: profileRoot, createdProfile };
  assertProfilePath();
  save();
  proxy = net.createServer((socket) => { report.proxyConnections += 1; socket.destroy(); });
  await new Promise((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
  assertActive();
  deadline = setTimeout(() => {
    shutdownRequested = true;
    report.errors.push({ phase: "deadline", message: "Verification exceeded the 120-second runtime limit" });
    if (context) context.close().catch((error) => report.errors.push({ phase: "deadline.close", ...errorRecord(error) }));
  }, 120000);
  console.log("Launching fresh Edge", report.installedEdgeVersion, headless ? "headless" : "headed");
  context = await chromium.launchPersistentContext(profile, {
    channel: "msedge", headless, timeout: 30000, viewport: { width: 1280, height: 1000 },
    serviceWorkers: "allow", acceptDownloads: false,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`,
      `--proxy-server=http://127.0.0.1:${proxy.address().port}`, "--proxy-bypass-list=<-loopback>",
      "--enable-automation", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run", "--no-default-browser-check"]
  });
  assertActive();
  const browserSession = await context.browser().newBrowserCDPSession();
  report.browserVersion = await browserSession.send("Browser.getVersion");
  report.commandLine = await browserSession.send("Browser.getBrowserCommandLine").catch((error) => ({ error: error.message }));
  await browserSession.detach();
  assert.equal(report.browserVersion.product, "Edg/" + report.installedEdgeVersion, "Running Edge must match the inspected installed executable");
  assert.ok(report.commandLine.arguments?.some((argument) => path.normalize(argument).toLowerCase() === path.normalize(edgePath).toLowerCase()), "Playwright msedge channel must launch the expected executable");
  await context.route("**/*", async (requestRoute) => {
    const request = requestRoute.request();
    const url = request.url();
    const record = { url, method: request.method(), resourceType: request.resourceType(), action: "abort" };
    report.requests.push(record);
    if (request.method() !== "GET") return requestRoute.abort("blockedbyclient");
    let body;
    if (url === targetUrl) body = '<!doctype html><meta charset="utf-8"><title>Local Edge verification</title><iframe title="Synthetic candidates" src="' + frameUrl + '" style="width:100%;height:920px;border:0"></iframe>';
    if (url === frameUrl) body = fixture.replace('<div data-current-job>跨境电商财务</div>', '<div class="job-select"><input readonly value="跨境电商会计-双休朝九晚六_宁波 6-7K"></div>');
    if (url === emptyUrl) body = '<!doctype html><meta charset="utf-8"><title>Local zero-candidate verification</title><div data-current-job>跨境电商财务</div><p>Local empty recommendation fixture</p>';
    if (url === denseUrl) body = '<!doctype html><meta charset="utf-8"><div data-current-job>跨境电商财务</div><main class="recommend-list">' +
      Array.from({ length: 150 }, (_, index) => '<article class="candidate-card" data-candidate-id="dense-' + index + '"><h3>合成候选</h3><p>本科已毕业，跨境电商财务工作经历，期望薪资6500元每月</p><div class="btns"><button class="btn">打招呼</button></div></article>').join("") + '</main>';
    if (body !== undefined) {
      record.action = "fulfill-local";
      return requestRoute.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body,
        headers: { "Content-Security-Policy": "default-src 'none'; frame-src https://www.zhipin.com; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'" } });
    }
    return requestRoute.abort("blockedbyclient");
  });
  await context.routeWebSocket(/.*/, (socket) => { report.requests.push({ url: socket.url(), action: "websocket-close" }); socket.close(); });
  await context.addInitScript(() => {
    window.__edgeVerificationClicks = [];
    document.addEventListener("click", (event) => {
      window.__edgeVerificationClicks.push({ trusted: event.isTrusted, tag: event.target.tagName, text: event.target.textContent?.slice(0, 80) });
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    document.addEventListener("submit", (event) => { event.preventDefault(); event.stopImmediatePropagation(); }, true);
  });
  try {
    worker = context.serviceWorkers().find((candidate) => candidate.url().startsWith("chrome-extension://")) ||
      await context.waitForEvent("serviceworker", { predicate: (candidate) => candidate.url().startsWith("chrome-extension://"), timeout: 15000 });
  } catch (error) {
    report.extensionLoad = { loaded: false, workers: context.serviceWorkers().map((candidate) => candidate.url()), error: errorRecord(error) };
    const page = context.pages()[0] || await context.newPage();
    await page.goto("edge://version", { timeout: 10000 }).catch(() => {});
    report.edgeVersionPage = await page.locator("body").innerText().catch(() => "unavailable");
    await page.screenshot({ path: path.join(output, "extension-not-loaded.png"), fullPage: true }).catch(() => {});
    throw new Error("Real Edge did not expose the unpacked MV3 service worker; --load-extension may be ignored or blocked. Compatibility is NOT verified.");
  }
  report.extensionLoad = { loaded: true, workerUrl: worker.url(), manifest: await worker.evaluate(() => chrome.runtime.getManifest()) };
  assert.equal(report.extensionLoad.manifest.version, manifest.version);
  assert.equal(report.extensionLoad.manifest.manifest_version, 3);
  const page = context.pages()[0] || await context.newPage();
  page.on("pageerror", (error) => report.errors.push({ phase: "page", ...errorRecord(error) }));
  await page.goto(targetUrl, { waitUntil: "load", timeout: 15000 });
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id, targetUrl);
  assert.ok(tabId, "Synthetic BOSS tab must be visible to the real extension");
  report.tabId = tabId;
  const initialFrames = await waitForFrames(tabId, 2, 1);
  report.candidateFrames = initialFrames;
  report.selfSendProbe = await worker.evaluate(async (tabId) => {
    try { return { response: await chrome.runtime.sendMessage({ type: "BGA_ROUTE_TO_CANDIDATE", tabId, payload: { type: "BGA_STATE" } }) }; }
    catch (error) { return { error: error.message }; }
  }, tabId);
  report.messageTransport = "service-worker chrome.scripting.executeScript -> real isolated-world chrome.runtime.sendMessage -> real background listener";
  await check("BGA_STATE selects the candidate iframe", async () => {
    const envelope = await route(tabId, { type: "BGA_STATE" });
    report.candidateState = envelope;
    assert.equal(envelope.ok, true);
    assert.equal(envelope.response.ok, true);
    assert.equal(envelope.response.state.frameReady, true);
    const candidate = initialFrames.find((frame) => frame.url === frameUrl);
    assert.ok(candidate && candidate.frameId !== 0);
    assert.equal(envelope.response.frameId, candidate.frameId);
    return envelope;
  });
  await check("Candidate connection diagnostics cover every frame", async () => verifyDiagnostics(report.candidateState, initialFrames));
  await check("Selected job is read from the candidate iframe rather than an empty host", async () => {
    const candidate = initialFrames.find((frame) => frame.url === frameUrl);
    const contexts = await worker.evaluate(async ({ tabId, frameId }) => Promise.all([0, frameId].map(async (id) => ({
      frameId: id, response: await chrome.tabs.sendMessage(tabId, { type: "BGA_PAGE_CONTEXT" }, { frameId: id })
    }))), { tabId, frameId: candidate.frameId });
    assert.equal(contexts[0].response.context.currentJobText, "");
    assert.equal(contexts[1].response.context.currentJobText, "跨境电商会计-双休朝九晚六_宁波 6-7K");
    assert.equal(contexts[1].response.context.jobStatus, "selected");
    return contexts;
  });
  await check("The real background job gate accepts the selected iframe job without preparing or clicking", async () => {
    const candidate = initialFrames.find((frame) => frame.url === frameUrl);
    const result = await worker.evaluate(async ({ tabId, frameId }) => {
      const replies = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, world: "ISOLATED",
        func: async () => {
          const runId = "local-job-context-only";
          const claim = await chrome.runtime.sendMessage({ type: "BGA_CLAIM_RUN", runId, dryRun: false });
          const release = claim.ok ? await chrome.runtime.sendMessage({ type: "BGA_RELEASE_RUN", runId }) : null;
          return { claim, release };
        }
      });
      return { ...replies[0].result, storage: await chrome.storage.local.get(null),
        owner: await chrome.storage.session.get("bossFinanceRunOwner") };
    }, { tabId, frameId: candidate.frameId });
    assert.equal(result.claim.ok, true, result.claim.error);
    assert.equal(result.claim.jobText, "跨境电商会计-双休朝九晚六_宁波 6-7K");
    assert.equal(result.release.ok, true);
    assert.equal(result.owner.bossFinanceRunOwner, undefined);
    assert.deepEqual(result.storage.bossFinanceGreetingAttempts || [], []);
    return result;
  });
  await check("One explicit dry-run scan classifies all three candidates with zero clicks", async () => {
    const payload = { type: "BGA_START", config: { dryRun: true, maxGreetings: 1, minDelayMs: 500, maxDelayMs: 500 } };
    report.startRequest = payload;
    report.startResponse = await route(tabId, payload);
    assert.equal(report.startResponse.ok, true);
    assert.equal(report.startResponse.response?.ok, true);
    assert.equal(report.startResponse.response.state.currentJobText, "跨境电商会计-双休朝九晚六_宁波 6-7K");
    const deadline = Date.now() + 15000;
    do {
      report.finalState = await route(tabId, { type: "BGA_STATE" });
      if (report.finalState.response?.state?.running === false) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    } while (Date.now() < deadline && !shutdownRequested);
    const state = report.finalState.response?.state;
    assert.equal(state?.running, false);
    assert.equal(state.processedCount, 3);
    assert.equal(state.eligibleCount, 1);
    assert.equal(state.rejectedCount, 2);
    assert.equal(state.dryRunMatches, 1);
    assert.equal(state.greetedCount, 0);
    assert.equal(state.clickAttemptCount, 0);
    assert.equal(state.unconfirmedCount, 0);
    assert.deepEqual(state.recentCandidates.map((candidate) => candidate.outcome).sort(), ["match", "reject", "reject"]);
    const storage = await worker.evaluate(() => chrome.storage.local.get(null));
    report.storageAfterScan = storage;
    const starts = (storage.bossGreetingAuditLog || []).filter((entry) => entry.type === "RUN_STARTED");
    assert.equal(starts.length, 1);
    assert.equal(starts[0].payload.dryRun, true);
    assert.deepEqual(storage.bossFinanceGreetingAttempts || [], []);
    report.frameClicks = await Promise.all(page.frames().map(async (frame) => ({ url: frame.url(), clicks: await frame.evaluate(() => window.__edgeVerificationClicks) })));
    assert.ok(report.frameClicks.every((frame) => Array.isArray(frame.clicks) && frame.clicks.length === 0));
    report.finalFrames = await frameStates(tabId);
    return { state, frameClicks: report.frameClicks, attempts: storage.bossFinanceGreetingAttempts || [], auditStartCount: starts.length };
  });
  await page.screenshot({ path: path.join(output, "candidate-iframe.png"), fullPage: true });
  await check("Extension reload reconnects existing documents without page refresh", async () => {
    const before = await page.evaluate(() => ({ timeOrigin: performance.timeOrigin, url: location.href }));
    const restarted = context.waitForEvent("serviceworker", {
      predicate: (candidate) => candidate.url().startsWith("chrome-extension://"), timeout: 15000
    });
    await worker.evaluate(() => { setTimeout(() => chrome.runtime.reload(), 0); });
    worker = await restarted;
    const frames = await worker.evaluate((tabId) => chrome.webNavigation.getAllFrames({ tabId }), tabId);
    report.framesAfterReload = await frameStates(tabId);
    report.reinjectionAfterReload = await worker.evaluate(async ({ tabId, frameIds, files }) =>
      chrome.scripting.executeScript({ target: { tabId, frameIds }, files }), {
      tabId, frameIds: frames.map((frame) => frame.frameId), files: manifest.content_scripts[0].js
    });
    report.reconnectedFrames = await frameStates(tabId);
    const envelope = await route(tabId, { type: "BGA_STATE" });
    assert.equal(envelope.ok, true, JSON.stringify(envelope));
    assert.equal(envelope.response?.state?.frameReady, true);
    assert.ok(report.reconnectedFrames.every((frame) => frame.response?.ok));
    assert.deepEqual(await page.evaluate(() => ({ timeOrigin: performance.timeOrigin, url: location.href })), before);
    return { frames: report.reconnectedFrames, state: envelope.response.state, documentUnchanged: true };
  });
  await page.goto(emptyUrl, { waitUntil: "load", timeout: 15000 });
  report.emptyFrames = await waitForFrames(tabId, 1, 0);
  await check("Zero candidates stay connected with frameReady false", async () => {
    report.emptyState = await route(tabId, { type: "BGA_STATE" });
    assert.equal(report.emptyState.ok, true, JSON.stringify(report.emptyState));
    assert.equal(report.emptyState.response?.ok, true);
    assert.equal(report.emptyState.response.state.frameReady, false);
    return report.emptyState;
  });
  await check("Empty-page connection diagnostics cover every frame", async () => verifyDiagnostics(report.emptyState, report.emptyFrames));
  await page.screenshot({ path: path.join(output, "zero-candidates.png"), fullPage: true });
  await check("Dense candidate lists stay connected instead of reporting a missing receiver", async () => {
    await page.goto(denseUrl, { waitUntil: "load", timeout: 15000 });
    await waitForFrames(tabId, 1, 1);
    const started = Date.now();
    const envelope = await route(tabId, { type: "BGA_STATE" });
    const elapsedMs = Date.now() - started;
    assert.equal(envelope.ok, true, JSON.stringify(envelope));
    assert.equal(envelope.response?.state?.frameReady, true);
    assert.equal(envelope.response.state.pageDiagnostics.candidateCount, 150);
    assert.equal(envelope.response.state.connectionDiagnostics.frames[0].connected, true);
    return { elapsedMs, state: envelope.response.state };
  });
  await check("A real Edge scan stops at 100 rejected people out of 150 cards", async () => {
    const start = await route(tabId, { type: "BGA_START", config: { dryRun: true, maxCandidates: 100, maxGreetings: 60 } });
    assert.equal(start.response?.ok, true, JSON.stringify(start));
    let state;
    const until = Date.now() + 15000;
    do {
      state = (await route(tabId, { type: "BGA_STATE" })).response?.state;
      if (state && !state.running) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    } while (Date.now() < until && !shutdownRequested);
    assert.equal(state?.running, false);
    assert.equal(state.processedCount, 100);
    assert.equal(state.rejectedCount, 100);
    assert.equal(state.status, "scan_limit_reached");
    assert.equal(state.clickAttemptCount, 0);
    assert.equal(state.greetedCount, 0);
    const clicks = await page.evaluate(() => window.__edgeVerificationClicks);
    assert.deepEqual(clicks, []);
    return { state, clicks };
  });
  await check("No request was forwarded to real BOSS", async () => {
    assert.ok(report.requests.some((request) => request.url === targetUrl && request.action === "fulfill-local"));
    assert.ok(report.requests.some((request) => request.url === frameUrl && request.action === "fulfill-local"));
    assert.ok(report.requests.every((request) => ["fulfill-local", "abort", "websocket-close"].includes(request.action)));
    return report.requests;
  });
  await check("Extension sources stayed stable throughout verification", async () => {
    report.finalSourceHashes = Object.fromEntries(Object.keys(report.sourceHashes).map((file) =>
      [file, createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex")]));
    assert.deepEqual(report.finalSourceHashes, report.sourceHashes);
    return report.finalSourceHashes;
  });
  report.status = report.checks.every((result) => result.passed) ? "passed" : "failed";
}

(async () => {
  try { await main(); }
  catch (error) { report.status = "failed"; report.errors.push({ phase: "main", ...errorRecord(error) }); console.error(error.message); }
  finally { await cleanup(); }
  if (!report.cleanup.contextClosed || !report.cleanup.profileRemoved || report.errors.length) report.status = "failed";
  save();
  console.log(JSON.stringify({ status: report.status, edgeVersion: report.installedEdgeVersion, checks: report.checks.map(({ name, passed }) => ({ name, passed })), cleanup: report.cleanup, report: path.join(output, "verification.json") }, null, 2));
  process.exitCode = report.status === "passed" ? 0 : 1;
})();
