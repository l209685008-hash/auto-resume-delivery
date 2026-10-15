(function () {
  "use strict";

  const AUDIT_KEY = "bossGreetingAuditLog";
  const STATE_KEY = "bossGreetingState";
  const CONTENT_FILES = [
    "src/content/domSelectors.js",
    "src/content/auditLogger.js",
    "src/content/safetyGuards.js",
    "src/content/candidateScanner.js"
  ];

  const elements = {
    status: document.getElementById("status"),
    maxGreetings: document.getElementById("maxGreetings"),
    minDelay: document.getElementById("minDelay"),
    maxDelay: document.getElementById("maxDelay"),
    dryRun: document.getElementById("dryRun"),
    confirmEach: document.getElementById("confirmEach"),
    processed: document.getElementById("processed"),
    eligible: document.getElementById("eligible"),
    greeted: document.getElementById("greeted"),
    skipped: document.getElementById("skipped"),
    unconfirmed: document.getElementById("unconfirmed"),
    failure: document.getElementById("failure"),
    start: document.getElementById("start"),
    stop: document.getElementById("stop"),
    exportAudit: document.getElementById("exportAudit"),
    clearAudit: document.getElementById("clearAudit")
  };

  function clamp(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
  }

  function getConfig() {
    const minDelaySeconds = clamp(elements.minDelay.value, 0.5, 60, 0.5);
    const maxDelaySeconds = clamp(elements.maxDelay.value, minDelaySeconds, 90, 0.9);
    return {
      maxGreetings: clamp(elements.maxGreetings.value, 1, 60, 60),
      minDelayMs: minDelaySeconds * 1000,
      maxDelayMs: maxDelaySeconds * 1000,
      dryRun: elements.dryRun.checked,
      requirePerCandidateConfirm: elements.confirmEach.checked
    };
  }

  function setStatus(text) {
    elements.status.textContent = text;
  }

  function renderState(state) {
    const safe = state || {};
    elements.processed.textContent = String(safe.processedCount || 0);
    elements.eligible.textContent = String(safe.eligibleCount || 0);
    elements.greeted.textContent = String(safe.greetedCount || 0);
    elements.skipped.textContent = String(safe.skippedCount || 0);
    elements.unconfirmed.textContent = String(safe.unconfirmedCount || 0);
    if (safe.lastFailureReason) {
      elements.failure.hidden = false;
      elements.failure.textContent = `最近失败：${safe.lastFailureReason}`;
    } else {
      elements.failure.hidden = true;
      elements.failure.textContent = "";
    }
    setStatus(safe.lastMessage || "未开始");
    elements.start.disabled = Boolean(safe.running);
    elements.stop.disabled = !safe.running;
  }

  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
  }

  function isBossTab(tab) {
    return Boolean(tab && tab.id && /https:\/\/[^/]*zhipin\.com\//.test(tab.url || ""));
  }

  async function injectContentScripts(tabId) {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: CONTENT_FILES
    });
  }

  function hasUsableState(response) {
    return Boolean(response && response.ok && response.state && response.state.frameReady !== false);
  }

  async function sendMessage(tabId, message) {
    const routed = await chrome.runtime.sendMessage({
      type: "BGA_ROUTE_TO_CANDIDATE",
      tabId,
      payload: message
    });
    if (routed && routed.ok) return routed.response;

    const direct = await chrome.tabs.sendMessage(tabId, message);
    if (Array.isArray(direct)) {
      const usable = direct.find(hasUsableState);
      return usable || direct.find((response) => response && response.ok) || direct[0];
    }
    return direct;
  }

  async function sendToContent(message, options) {
    const tab = await getActiveTab();
    if (!isBossTab(tab)) throw new Error("请先打开 BOSS 直聘页面");

    try {
      return await sendMessage(tab.id, message);
    } catch (error) {
      const canInject = !options || options.injectOnFail !== false;
      if (!canInject) throw error;
      setStatus("正在连接页面，请稍等");
      await injectContentScripts(tab.id);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return sendMessage(tab.id, message);
    }
  }

  async function refreshState() {
    try {
      const response = await sendToContent({ type: "BGA_STATE" });
      if (response && response.ok) renderState(response.state);
    } catch (_error) {
      chrome.storage.local.get({ [STATE_KEY]: null }, (data) => renderState(data[STATE_KEY]));
    }
  }

  async function start() {
    try {
      const config = getConfig();
      await chrome.storage.local.set({ [STATE_KEY]: null });
      const response = await sendToContent({ type: "BGA_START", config });
      if (!response || !response.ok) throw new Error(response ? response.error : "启动失败");
      renderState(response.state);
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function stop() {
    try {
      const response = await sendToContent({ type: "BGA_STOP" });
      if (response && response.ok) renderState(response.state);
    } catch (error) {
      setStatus(error.message);
    }
  }

  function exportAudit() {
    chrome.storage.local.get({ [AUDIT_KEY]: [] }, (data) => {
      const records = Array.isArray(data[AUDIT_KEY]) ? data[AUDIT_KEY] : [];
      const blob = new Blob([JSON.stringify(records, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `boss-greeting-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      link.click();
      URL.revokeObjectURL(url);
    });
  }

  function clearAudit() {
    if (!window.confirm("确认清空本机审计记录？")) return;
    chrome.storage.local.set({ [AUDIT_KEY]: [] }, () => setStatus("审计记录已清空"));
  }

  elements.start.addEventListener("click", start);
  elements.stop.addEventListener("click", stop);
  elements.exportAudit.addEventListener("click", exportAudit);
  elements.clearAudit.addEventListener("click", clearAudit);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[STATE_KEY]) renderState(changes[STATE_KEY].newValue);
  });

  refreshState();
})();
