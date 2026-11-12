/*
 * 真实点击验证：启动真实 Chromium + 加载本扩展，把 www.zhipin.com 解析到本地
 * HTTPS 服务，然后走“内容脚本 → 后台 → chrome.debugger 真实鼠标事件”的完整链路。
 *
 * 覆盖两件其它脚本覆盖不到的事：
 *   1. 非只扫描模式下，问候按钮确实被真实鼠标事件点中（页面收到 click）。
 *   2. 重复运行不会给同一个人再发一次（发送记录拦截）。
 */
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const https = require("node:https");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "test-results", "click-verification");
const WORK = path.join(os.tmpdir(), "boss-click-" + Date.now());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>推荐牛人</title>
<style>
 body{margin:0;font:14px/1.5 sans-serif;background:#fff;color:#222}
 .job-select{padding:10px 16px;border-bottom:1px solid #eee}
 .job-select .label{font-weight:600}
 .card-list{list-style:none;margin:0;padding:12px}
 .card-item{margin:0 0 12px;padding:12px;border:1px solid #ddd;width:520px}
 .card-item h3{margin:0 0 6px;font-size:15px}
 .card-item p{margin:2px 0;color:#555}
 button{margin-top:8px;padding:8px 18px;font-size:14px;cursor:pointer}
</style></head>
<body>
<div class="job-select"><span class="label">跨境电商财务专员</span></div>
<ul class="card-list">
  <li class="card-item"><div class="card-inner" data-geekid="geek-click-a">
    <h3 class="name">候选甲</h3>
    <p>离职 · 本科 · 会计学 · 已毕业</p>
    <p>2023.01-2025.06 深圳某跨境电商公司 财务会计</p>
    <p>负责亚马逊平台账务核算与出口退税申报</p>
    <p>期望：宁波 · 财务/会计 · 6500元/月</p>
    <button class="btn btn-greet">打招呼</button>
  </div></li>
  <li class="card-item"><div class="card-inner" data-geekid="geek-click-b">
    <h3 class="name">候选乙</h3>
    <p>在职 · 中专 · 会计</p>
    <p>负责亚马逊平台账务核算</p>
    <button class="btn btn-greet">打招呼</button>
  </div></li>
  <li class="card-item"><div class="card-inner" data-geekid="geek-click-c">
    <h3 class="name">候选丙</h3>
    <p>在职 · 本科 · 会计学</p>
    <p>负责亚马逊平台账务核算</p>
    <button class="btn btn-chat">继续沟通</button>
  </div></li>
</ul>
<script>
document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || button.textContent.trim() !== "打招呼") return;
  const card = button.closest(".card-inner");
  button.textContent = "继续沟通";
  button.className = "btn btn-chat";
  fetch("/report?clicked=" + encodeURIComponent(card ? card.dataset.geekid : "unknown"));
});
</script>
</body></html>`;

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function certificate() {
  const key = path.join(WORK, "key.pem");
  const cert = path.join(WORK, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
    "-out", cert, "-days", "1", "-subj", "/CN=www.zhipin.com"], { stdio: "ignore" });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

async function waitFor(check, timeoutMs, message) {
  const startedAt = Date.now();
  let last;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
      last = value;
    } catch (error) { last = error.message; }
    await sleep(200);
  }
  throw new Error(`${message} (last=${JSON.stringify(last)})`);
}

async function waitForDebugger(port) {
  return waitFor(async () => {
    try {
      const body = await new Promise((resolve, reject) => {
        const request = http.get(`http://127.0.0.1:${port}/json/version`, (response) => {
          let data = "";
          response.on("data", (chunk) => { data += chunk; });
          response.on("end", () => resolve(data));
        });
        request.on("error", reject);
        request.setTimeout(1000, () => request.destroy(new Error("timeout")));
      });
      return JSON.parse(body).webSocketDebuggerUrl;
    } catch (_) { return null; }
  }, 20000, "Chromium 调试端口未就绪");
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  fs.mkdirSync(WORK, { recursive: true });
  const port = await freePort();
  const debugPort = await freePort();
  const clicks = [];
  const requests = [];
  const server = https.createServer(certificate(), (request, response) => {
    const url = new URL(request.url, "https://www.zhipin.com");
    requests.push(url.pathname);
    if (url.pathname === "/web/geek/recommend") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return response.end(PAGE);
    }
    if (url.pathname === "/report") clicks.push(url.searchParams.get("clicked"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

  const chrome = spawn(chromium.executablePath(), [
    `--user-data-dir=${path.join(WORK, "profile")}`,
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
    `--host-resolver-rules=MAP www.zhipin.com 127.0.0.1:${port}`,
    "--ignore-certificate-errors",
    "--no-proxy-server",
    "--disable-features=DnsOverHttps,AsyncDns,UseDnsHttpsSvcbAlpn",
    `--remote-debugging-port=${debugPort}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--headless=new",
    "--window-size=1280,900",
    "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let chromeLog = "";
  chrome.stderr.on("data", (chunk) => { chromeLog += chunk.toString(); });

  const socket = new WebSocket(await waitForDebugger(debugPort));
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const pending = new Map();
  let sequence = 0;
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
  };
  const send = (method, params = {}, sessionId, timeoutMs = 30000) => {
    const id = ++sequence;
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`cdp timeout: ${method}`)); }
      }, timeoutMs);
    });
  };
  const evaluateWith = (sessionId, timeoutMs) => async (body) => {
    const response = await send("Runtime.evaluate",
      { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true }, sessionId, timeoutMs);
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
    return response.result.value;
  };

  try {
    const worker = await waitFor(async () => {
      const { targetInfos } = await send("Target.getTargets");
      return targetInfos.find((target) => target.type === "service_worker" &&
        /\/src\/background\/serviceWorker\.js$/.test(target.url)) || null;
    }, 15000, "扩展 service worker 未启动");
    // MV3 的 service worker 可能刚创建、也可能被回收重建：attach 后用一次求值确认会话可用，
    // 失败就重新取 target，避免偶发的 cdp 超时把整轮验证判成失败。
    let workerSession;
    let workerEval;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const session = (await send("Target.attachToTarget", { targetId: worker.targetId, flatten: true })).sessionId;
      const evaluate = evaluateWith(session, 10000);
      try {
        await evaluate(`return chrome.runtime.getManifest().version;`);
        workerSession = session;
        workerEval = evaluate;
        break;
      } catch (error) {
        if (attempt === 3) throw error;
        await sleep(500);
      }
    }
    const extensionId = new URL(worker.url).host;

    const { targetId: pageTarget } = await send("Target.createTarget", { url: "https://www.zhipin.com/web/geek/recommend" });
    const ready = await waitFor(async () => {
      const state = await workerEval(`
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((item) => item.url && item.url.includes("www.zhipin.com"));
        if (!tab) return { step: "no-tab" };
        try {
          const response = await chrome.tabs.sendMessage(tab.id, { type: "BGA_STATE" }, { frameId: 0 });
          return { step: "ok", tabId: tab.id, version: response?.state?.runnerVersion,
            candidates: response?.state?.pageDiagnostics?.candidateCount || 0 };
        } catch (error) { return { step: "throw", error: error.message }; }
      `);
      return state.step === "ok" && state.candidates >= 2 ? state : null;
    }, 20000, "内容脚本未就绪");
    console.log("step: content script ready", ready.candidates);
    assert.ok(requests.includes("/web/geek/recommend"), "页面必须来自本地服务，不能访问真实站点");
    assert.equal(ready.version, require(path.join(ROOT, "manifest.json")).version,
      "内容脚本上报的引擎版本必须与清单版本一致");

    const pageEval = async (body) => {
      const { sessionId } = await send("Target.attachToTarget", { targetId: pageTarget, flatten: true });
      try { return await evaluateWith(sessionId, 15000)(body); } finally {
        await send("Target.detachFromTarget", { sessionId });
      }
    };

    const runOnce = async (maxCandidates) => {
      await workerEval(`await chrome.tabs.update(${ready.tabId}, { active: true }); return true;`);
      const started = await workerEval(`
        try {
          const response = await chrome.tabs.sendMessage(${ready.tabId}, { type: "BGA_START", config: {
            dryRun: false, maxCandidates: ${maxCandidates}, maxGreetings: 10, minDelayMs: 500, maxDelayMs: 500
          } }, { frameId: 0 });
          return { ok: response?.ok === true, error: response?.error };
        } catch (error) { return { ok: false, error: error.message }; }
      `);
      assert.equal(started.ok, true, `启动失败：${started.error}`);
      return waitFor(async () => {
        const state = await workerEval(`const data = await chrome.storage.local.get("bossGreetingState");
          return data.bossGreetingState || null;`);
        return state && state.running === false && state.processedCount > 0 ? state : null;
      }, 40000, "任务没有在 40 秒内结束");
    };

    console.log("step: run1");
    const first = await runOnce(10);
    console.log("step: run1 done", first.status, first.greetedCount);
    assert.deepEqual(clicks, ["geek-click-a"], "只有符合条件且未沟通的候选人应收到一次真实点击");
    assert.equal(first.eligibleCount, 1);
    assert.equal(first.rejectedCount, 1);
    assert.equal(first.greetedCount, 1);
    assert.equal(first.clickAttemptCount, 1);
    assert.equal(first.unconfirmedCount, 0);
    results.push("real click: one qualified card greeted via chrome.debugger, page received the click");

    const firstSend = first.recentCandidates.find((candidate) => candidate.candidateKey === "id:geek-click-a");
    assert.equal(firstSend.sendStatus, "confirmed", "点击后必须由页面文案确认");
    assert.equal(firstSend.checks.find((check) => check.key === "major").status, "pass");
    assert.equal(firstSend.checks.find((check) => check.key === "keyword").status, "pass");
    results.push("confirmation: greeted control re-read from the card after the label was rewritten");

    const rejected = first.recentCandidates.find((candidate) => candidate.candidateKey === "id:geek-click-b");
    assert.equal(rejected.outcome, "reject");
    assert.equal(rejected.sendStatus, "not_sent");
    results.push("gate: a below-associate card is evaluated and never clicked");

    const contacted = first.recentCandidates.find((candidate) => candidate.candidateKey === "id:geek-click-c");
    assert.equal(contacted, undefined, "已沟通的卡片不应进入候选列表");
    results.push("already-contacted card is not treated as a candidate at all");

    // 模拟页面状态回滚：按钮文案被恢复成“打招呼”，但本地发送记录仍在。
    await pageEval(`
      const button = document.querySelector('[data-geekid="geek-click-a"] button');
      button.textContent = "打招呼";
      button.className = "btn btn-greet";
      return true;
    `);

    console.log("step: run2");
    const second = await runOnce(10);
    console.log("step: run2 done", second.status);
    assert.deepEqual(clicks, ["geek-click-a"], "第二次运行不得重复点击同一候选人");
    assert.equal(second.greetedCount, 0, "第二次运行不应产生新的发送");
    assert.equal(second.clickAttemptCount, 0, "第二次运行不应产生新的点击尝试");
    const repeat = second.recentCandidates.find((candidate) => candidate.candidateKey === "id:geek-click-a");
    assert.equal(repeat.sendStatus, "skipped");
    assert.match(repeat.summary, /已有发送记录/);
    results.push("dedupe: a stale page state cannot re-send to the same candidate");

    const attempts = await workerEval(`const data = await chrome.storage.local.get("bossFinanceGreetingAttempts");
      return data.bossFinanceGreetingAttempts || [];`);
    assert.equal(attempts.length, 1, "发送记录只应有一条");
    assert.equal(attempts[0].status, "confirmed");
    results.push("attempt store: exactly one confirmed record after two runs");

    fs.writeFileSync(path.join(OUTPUT, "click-verification.json"), JSON.stringify({
      generatedAt: new Date().toISOString(),
      extensionId,
      requests: requests.filter((item) => item === "/web/geek/recommend").length,
      clicks,
      first: { eligible: first.eligibleCount, rejected: first.rejectedCount, greeted: first.greetedCount },
      second: { greeted: second.greetedCount, clickAttempts: second.clickAttemptCount },
      attempts: attempts.map((attempt) => attempt.status),
      checks: results
    }, null, 2));
    for (const result of results) console.log("PASS", result);
  } finally {
    try { socket.close(); } catch (_) { /* ignore */ }
    chrome.kill();
    server.close();
    await sleep(200);
    if (chrome.exitCode !== 0 && chrome.exitCode != null && !results.length) {
      console.error(chromeLog.slice(-2000));
    }
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error("FAILED:", error.message);
  process.exit(1);
});
