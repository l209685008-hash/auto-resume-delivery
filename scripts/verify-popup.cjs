// Real Chrome action popup: no tab navigation, viewport emulation, or account access.
const { chromium } = require("playwright");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

function argumentsForRun() {
  const options = { extensionRoot: path.resolve(__dirname, ".."), headless: false };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === "--headless") options.headless = true;
    else if (flag === "--headed") options.headless = false;
    else if (["--extension-root", "--baseline-css", "--output"].includes(flag)) {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Missing value for ${flag}`);
      options[{ "--extension-root": "extensionRoot", "--baseline-css": "baselineCss", "--output": "output" }[flag]] = path.resolve(args[++i]);
    } else if (flag === "--help") {
      console.log("node scripts/verify-popup.cjs [--headed|--headless] [--extension-root DIR] [--baseline-css FILE] [--output DIR]\nDefault: independent headed Playwright Chromium, evidence in the OS temp directory.\n--baseline-css overlays only a temporary extension copy; never edits the source extension.\nNo buttons are clicked. Exit 1 means a layout failure; exit 2 means acquisition/infrastructure failure.");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  return options;
}

function hash(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Action popups are not Playwright context.pages(); attach to their CDP target.
async function popupConnection(cdp, targetId) {
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: false });
  let sequence = 0;
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const finish = (error, result) => {
      clearTimeout(timer);
      cdp.off("Target.receivedMessageFromTarget", receive);
      error ? reject(error) : resolve(result);
    };
    const receive = (event) => {
      if (event.sessionId !== sessionId) return;
      const message = JSON.parse(event.message);
      if (message.id !== id) return;
      finish(message.error ? new Error(JSON.stringify(message.error)) : null, message.result);
    };
    const timer = setTimeout(() => finish(new Error(`CDP timeout: ${method}`)), 10000);
    cdp.on("Target.receivedMessageFromTarget", receive);
    cdp.send("Target.sendMessageToTarget", {
      sessionId, message: JSON.stringify({ id, method, params })
    }).catch((error) => finish(error));
  });
}

function measurePopup() {
  const rect = (element) => element ? element.getBoundingClientRect().toJSON() : null;
  const text = (element) => {
    if (!element) return null;
    const range = document.createRange();
    range.selectNodeContents(element);
    const fragments = [...range.getClientRects()].filter((item) => item.width && item.height).map((item) => item.toJSON());
    const lines = new Set(fragments.map((item) => Math.round(item.top)));
    const style = getComputedStyle(element);
    return { text: element.textContent.trim(), rect: rect(element), fragments, lines: lines.size,
      fontSize: parseFloat(style.fontSize), visible: style.display !== "none" && style.visibility === "visible" && Number(style.opacity) > 0 };
  };
  const dimensions = (element) => ({ rect: rect(element), clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth, cssWidth: getComputedStyle(element).width,
    cssMinWidth: getComputedStyle(element).minWidth, cssMaxWidth: getComputedStyle(element).maxWidth });
  return {
    url: location.href, version: chrome.runtime.getManifest().version,
    popupViews: chrome.extension.getViews({ type: "popup" }).map((view) => ({ url: view.location.href, isSelf: view === window })),
    sidePanelClass: document.documentElement.classList.contains("side-panel"),
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio, visualWidth: visualViewport.width },
    html: dimensions(document.documentElement), body: dimensions(document.body),
    title: text(document.querySelector("#profileTitle")),
    modeLabels: [...document.querySelectorAll(".mode-selector label span")].map(text),
    start: text(document.querySelector("#startLabel")),
    startButton: rect(document.querySelector("#start")),
    startDisabled: document.querySelector("#start")?.disabled,
    connection: document.querySelector("#connection")?.dataset.kind
  };
}

async function main() {
  const options = argumentsForRun();
  const output = options.output || fs.mkdtempSync(path.join(os.tmpdir(), "boss-action-popup-evidence-"));
  fs.mkdirSync(output, { recursive: true });
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const temporary = fs.mkdtempSync(path.join(temporaryRoot, "boss-action-popup-run-"));
  const report = { generatedAt: new Date().toISOString(), sourceRoot: options.extensionRoot,
    requestedMode: options.headless ? "headless" : "headed", output, attempts: [], checks: [] };
  let context;
  try {
    let extensionRoot = options.extensionRoot;
    if (options.baselineCss) {
      extensionRoot = path.join(temporary, "extension");
      const sourceManifest = JSON.parse(fs.readFileSync(path.join(options.extensionRoot, "manifest.json"), "utf8"));
      fs.mkdirSync(extensionRoot);
      fs.copyFileSync(path.join(options.extensionRoot, "manifest.json"), path.join(extensionRoot, "manifest.json"));
      fs.cpSync(path.join(options.extensionRoot, "src"), path.join(extensionRoot, "src"), { recursive: true });
      if (sourceManifest.icons) {
        for (const relative of new Set(Object.values(sourceManifest.icons))) {
          const destination = path.join(extensionRoot, relative);
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.copyFileSync(path.join(options.extensionRoot, relative), destination);
        }
      }
      fs.copyFileSync(options.baselineCss, path.join(extensionRoot, "src/popup/popup.css"));
      report.baselineCss = { path: options.baselineCss, sha256: hash(options.baselineCss) };
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "manifest.json"), "utf8"));
    if (!manifest.action?.default_popup) throw new Error("Manifest does not declare an action popup");
    report.manifestVersion = manifest.version;
    report.sourceHashes = Object.fromEntries(["manifest.json", "src/popup/popup.css", "src/popup/popup.html", "src/popup/popup.js"]
      .map((file) => [file, hash(path.join(extensionRoot, file))]));
    let call;
    for (const headless of options.headless ? [true, false] : [false]) {
      const attempt = { mode: headless ? "headless" : "headed" };
      report.attempts.push(attempt);
      try {
        context = await chromium.launchPersistentContext(path.join(temporary, `profile-${attempt.mode}`), {
          channel: "chromium", headless, viewport: null,
          args: [`--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`, "--disable-background-networking"]
        });
        // The isolated browser stays on about:blank; block all web traffic.
        await context.route(/^https?:\/\//, (route) => route.abort("blockedbyclient"));
        const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 10000 });
        const extensionId = new URL(worker.url()).host;
        const expectedUrl = `chrome-extension://${extensionId}/${manifest.action.default_popup}`;
        report.extensionId = extensionId;
        report.browserVersion = context.browser()?.version() || await worker.evaluate(() => navigator.userAgent);
        const anchor = context.pages()[0] || await context.newPage();
        const cdp = await context.newCDPSession(anchor);
        await worker.evaluate(() => chrome.action.openPopup());
        const deadline = Date.now() + 10000;
        let target;
        while (Date.now() < deadline) {
          target = (await cdp.send("Target.getTargets")).targetInfos.find((item) => item.url === expectedUrl);
          if (target) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!target) throw new Error("chrome.action.openPopup produced no attachable popup target");
        report.target = target;
        call = await popupConnection(cdp, target.targetId);
        const ready = await call("Runtime.evaluate", { expression: "new Promise(resolve => { const wait = () => document.readyState === 'complete' && document.querySelector('#connection')?.dataset.kind !== 'connecting' ? document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(resolve))) : setTimeout(wait, 50); wait(); })", awaitPromise: true, timeout: 10000 });
        if (ready.exceptionDetails) throw new Error(JSON.stringify(ready.exceptionDetails));
        attempt.acquired = true;
        report.actualMode = attempt.mode;
        break;
      } catch (error) {
        attempt.error = error.stack;
        if (context) await context.close();
        context = null;
        if (!headless) throw error;
        console.error("Headless popup unavailable; retrying in an independent headed Chromium:", error.message);
      }
    }
    const result = await call("Runtime.evaluate", { expression: `(${measurePopup.toString()})()`, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    report.measurements = result.result.value;
    report.popupContexts = await context.serviceWorkers()[0].evaluate(() => chrome.runtime.getContexts({ contextTypes: ["POPUP"] }));
    const screenshot = await call("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
    report.screenshot = path.join(output, "action-popup.png");
    fs.writeFileSync(report.screenshot, Buffer.from(screenshot.data, "base64"));
    const m = report.measurements;
    const check = (name, passed, actual) => report.checks.push({ name, passed: Boolean(passed), actual });
    const approximately380 = (width) => width >= 360 && width <= 400;
    const readable = (item) => item?.visible && item.text.length > 0 && item.lines === 1 && item.fontSize >= 12 &&
      item.rect.width > 0 && item.rect.height > 0 && item.fragments.length > 0 && item.fragments.every((fragment) =>
        fragment.left >= -1 && fragment.right <= m.html.clientWidth + 1 && fragment.top >= -1 && fragment.bottom <= m.viewport.height + 1 &&
        fragment.left >= item.rect.left - 1 && fragment.right <= item.rect.right + 1);
    check("real action popup identity", m.popupViews.some((view) => view.isSelf) && report.popupContexts.some((item) => item.documentUrl === m.url), m.popupViews);
    check("popup is not classified as side panel", !m.sidePanelClass, m.sidePanelClass);
    check("manifest version matches loaded extension", m.version === manifest.version, m.version);
    check("popup viewport is approximately 380px", approximately380(m.viewport.width), m.viewport.width);
    check("html and body are approximately 380px", approximately380(m.html.rect.width) && approximately380(m.body.rect.width), { html: m.html.rect.width, body: m.body.rect.width });
    check("no horizontal overflow", m.html.scrollWidth <= m.html.clientWidth + 1 && m.body.scrollWidth <= m.body.clientWidth + 1 && m.body.rect.right <= m.html.clientWidth + 1, { html: m.html, body: m.body });
    check("title is readable on one line", readable(m.title), m.title);
    check("two mode labels are readable on one line", m.modeLabels.length === 2 && m.modeLabels.every(readable), m.modeLabels);
    check("mode labels are arranged horizontally", m.modeLabels.length === 2 && Math.abs(m.modeLabels[0].rect.top - m.modeLabels[1].rect.top) <= 1 && m.modeLabels[0].rect.right <= m.modeLabels[1].rect.left + 1, m.modeLabels.map((item) => item.rect));
    check("start label is readable in the first viewport", readable(m.start) && m.startButton?.bottom <= m.viewport.height + 1, m.start);
    check("isolated about:blank keeps start disabled", m.startDisabled === true, m.startDisabled);
    check("tested source files did not change during verification", Object.entries(report.sourceHashes).every(([file, digest]) => hash(path.join(options.baselineCss ? path.join(temporary, "extension") : options.extensionRoot, file)) === digest));
    report.status = report.checks.every((item) => item.passed) ? "passed" : "failed";
    process.exitCode = report.status === "passed" ? 0 : 1;
    console.log(`Real action popup (${report.actualMode}, manifest ${m.version}): viewport ${m.viewport.width}x${m.viewport.height}, html ${m.html.rect.width}px, body ${m.body.rect.width}px`);
    for (const item of report.checks) console.log(`${item.passed ? "PASS" : "FAIL"} ${item.name}`);
  } catch (error) {
    report.status = "error";
    report.error = error.stack;
    process.exitCode = 2;
    console.error(error.stack);
  } finally {
    if (context) await context.close().catch((error) => { report.cleanupError = error.message; process.exitCode = 2; });
    const resolvedTemporary = fs.realpathSync(temporary);
    if (path.dirname(resolvedTemporary) !== temporaryRoot || !path.basename(resolvedTemporary).startsWith("boss-action-popup-run-")) {
      throw new Error("Unexpected temporary profile path; refusing recursive cleanup");
    }
    fs.rmSync(resolvedTemporary, { recursive: true, force: true });
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(output, "verification.json"), JSON.stringify(report, null, 2));
    console.log(`Evidence: ${path.join(output, "verification.json")}`);
    if (report.screenshot) console.log(`Screenshot: ${report.screenshot}`);
  }
}

main().catch((error) => { console.error(error.stack); process.exitCode = 2; });
