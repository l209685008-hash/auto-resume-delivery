(function () {
  "use strict";

  const AUDIT_KEY = "bossGreetingAuditLog";
  const STATE_KEY = "bossGreetingState";
  const SETTINGS_KEY = "bossFinanceSettings";
  const PROFILE_ID = "cross_border_finance";
  const CONTENT_FILES = [
    "src/content/candidateIdentity.js",
    "src/content/domSelectors.js",
    "src/content/auditLogger.js",
    "src/content/safetyGuards.js",
    "src/content/financeRules.js",
    "src/content/profileExtractor.js",
    "src/content/candidateScanner.js"
  ];
  const DEFAULTS = {
    profileId: PROFILE_ID,
    maxCandidates: 100,
    maxGreetings: 60,
    minDelayMs: 2000,
    maxDelayMs: 5000,
    dryRun: true,
    requirePerCandidateConfirm: false
  };
  const STATUS_LABELS = {
    idle: "未开始", running: "运行中", scanning: "正在扫描", greeting: "正在打招呼",
    stopping: "正在停止", stopped: "已停止", completed: "已完成", complete: "已完成",
    limit_reached: "已达人数上限", human_required: "需要人工处理", error: "运行异常",
    scan_limit_reached: "已达扫描人数上限",
    paused: "已暂停", no_candidates: "暂无候选人", no_more_progress: "已无更多候选",
    page_changed: "页面已变化", max_runtime: "已达运行时限", job_changed: "岗位已切换",
    confirmation_failed: "发送结果未确认"
  };
  const PHASE_LABELS = {
    idle: "待开始", scanning: "扫描候选", scan: "扫描候选", evaluating: "核验岗位要求",
    extracting: "提取经历", opening: "打开候选详情", reading: "读取候选资料",
    clicking: "点击打招呼", loading: "等待详情加载",
    greeting: "发送打招呼", sending: "发送中", confirming: "核实发送结果",
    waiting: "等待页面", waiting_confirmation: "等待逐人确认", cooldown: "等待间隔",
    stopped: "已停止", completed: "已完成", done: "已完成", error: "异常停止"
  };
  const OUTCOME_LABELS = { match: "符合", reject: "不符合" };
  const CHECK_LABELS = { pass: "符合", fail: "不符合" };
  const SEND_LABELS = {
    not_sent: "未发送", dry_run: "仅扫描", sending: "发送中", confirmed: "发送成功",
    unconfirmed: "发送未确认", skipped: "已跳过"
  };
  const ids = [
    "profileTitle", "profileVersion", "requirements", "requirementDescriptions", "ruleError",
    "connection", "connectionLabel", "sourceBadge", "connectionMessage", "reconnect", "openSidePanel", "exportDiagnostics",
    "status", "updatedAt", "message", "currentJob", "currentCandidateRow", "candidateLabel",
    "currentCandidate", "phase", "failureLabel", "failure", "eligible", "rejected",
    "greeted", "processed", "clickAttempts", "unconfirmed", "dryRunMatches", "dryRun", "greetMode",
    "maxCandidates", "maxGreetings", "minDelay", "maxDelay", "confirmEach", "settingsSummary", "start", "startLabel",
    "stop", "actionNote", "exportAudit", "clearAudit", "clearAttempts", "resultCount", "candidateList", "emptyState",
    "emptyTitle", "emptyMessage", "runId"
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
  const settingInputs = [elements.dryRun, elements.greetMode, elements.maxCandidates, elements.maxGreetings, elements.minDelay, elements.maxDelay, elements.confirmEach];
  const profile = window.BossFinanceRules && window.BossFinanceRules.PROFILE;
  const profileReady = Boolean(profile && profile.id === PROFILE_ID && profile.title && profile.version && Array.isArray(profile.requirements) && profile.requirements.length);
  const extensionReady = typeof chrome !== "undefined" && chrome.runtime && chrome.storage;
  const sidePanelAvailable = extensionReady && chrome.sidePanel && typeof chrome.sidePanel.open === "function";
  const popupView = extensionReady && chrome.extension && typeof chrome.extension.getViews === "function" && chrome.extension.getViews({ type: "popup" }).includes(window);
  document.documentElement.classList.toggle("side-panel", !popupView);
  const injectedDocuments = new Set();
  const injectionFailures = new Map();
  const REPAIR_BACKOFF_MS = 10000;
  const MAX_AUTOMATIC_REPAIRS = 2;
  let diagnosticAttempt = null;
  let currentState = null;
  let cachedState = null;
  let connectedTab = null;
  let lastTargetTab = null;
  let ownerTabId = null;
  let currentWindowId = null;
  let connection = "connecting";
  let connectionError = "";
  let settingsReady = false;
  let pendingAction = "";
  let uncertainCommand = false;
  let refreshing = false;
  let refreshAgain = false;
  let contextVersion = 0;
  let selectedFilter = "all";
  let resultSignature = "";

  function text(value) {
    if (value == null) return "";
    if (Array.isArray(value)) return value.map(text).filter(Boolean).join("\n");
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  function node(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = text(value);
    return element;
  }

  function clamp(value, min, max, fallback) {
    const number = value === "" || value == null ? NaN : Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  }

  function count(value) {
    return Math.floor(clamp(value, 0, Number.MAX_SAFE_INTEGER, 0));
  }

  function normalizeSettings(value) {
    const config = value && typeof value === "object" ? value : {};
    const minDelayMs = Math.round(clamp(config.minDelayMs, 500, 60000, DEFAULTS.minDelayMs));
    return {
      profileId: PROFILE_ID,
      maxCandidates: Math.floor(clamp(config.maxCandidates, 1, 100, DEFAULTS.maxCandidates)),
      maxGreetings: Math.floor(clamp(config.maxGreetings, 1, 60, DEFAULTS.maxGreetings)),
      minDelayMs,
      maxDelayMs: Math.round(clamp(config.maxDelayMs, minDelayMs, 90000, Math.max(minDelayMs, DEFAULTS.maxDelayMs))),
      dryRun: config.dryRun !== false,
      requirePerCandidateConfirm: config.requirePerCandidateConfirm === true
    };
  }

  function getConfig() {
    return normalizeSettings({
      maxCandidates: elements.maxCandidates.value,
      maxGreetings: elements.maxGreetings.value,
      minDelayMs: elements.minDelay.value === "" ? null : Number(elements.minDelay.value) * 1000,
      maxDelayMs: elements.maxDelay.value === "" ? null : Number(elements.maxDelay.value) * 1000,
      dryRun: elements.dryRun.checked,
      requirePerCandidateConfirm: elements.confirmEach.checked
    });
  }

  function applySettings(value) {
    const config = normalizeSettings(value);
    elements.maxCandidates.value = config.maxCandidates;
    elements.maxGreetings.value = config.maxGreetings;
    elements.minDelay.value = config.minDelayMs / 1000;
    elements.maxDelay.value = config.maxDelayMs / 1000;
    elements.dryRun.checked = config.dryRun;
    elements.greetMode.checked = !config.dryRun;
    elements.confirmEach.checked = config.requirePerCandidateConfirm;
    render();
  }

  function setNote(message, tone) {
    elements.actionNote.textContent = message;
    elements.actionNote.dataset.tone = tone || "normal";
    elements.actionNote.hidden = !message;
  }

  function renderProfile() {
    elements.ruleError.hidden = profileReady;
    if (!profileReady) return;
    elements.profileTitle.textContent = profile.title;
    document.title = profile.title + " · 招聘工作台";
    elements.profileVersion.textContent = "v" + profile.version;
    for (const requirement of profile.requirements) {
      const item = node("li");
      item.append(node("strong", "requirement-label", requirement.label));
      elements.requirements.append(item);
      const description = node("li");
      description.append(node("strong", "requirement-label", requirement.label), node("p", "requirement-description", requirement.description));
      elements.requirementDescriptions.append(description);
    }
  }

  function normalizeOutcome(value) {
    return Object.hasOwn(OUTCOME_LABELS, value) ? value : "reject";
  }

  function renderResults(state) {
    const candidates = Array.isArray(state.recentCandidates) ? state.recentCandidates.filter((candidate) => candidate && typeof candidate === "object") : [];
    const signature = JSON.stringify([selectedFilter, candidates]);
    if (signature === resultSignature) return;
    resultSignature = signature;
    const expanded = new Set(Array.from(elements.candidateList.querySelectorAll("details[open]")).map((detail) => detail.dataset.candidateKey));
    const fragment = document.createDocumentFragment();
    const filtered = candidates.filter((candidate) => selectedFilter === "all" || normalizeOutcome(candidate.outcome) === selectedFilter);
    for (const [index, candidate] of filtered.entries()) {
      const outcome = normalizeOutcome(candidate.outcome);
      const row = node("li", "candidate-row");
      const heading = node("div", "candidate-heading");
      heading.append(node("strong", "candidate-name", candidate.name || "未命名候选人"), node("span", "outcome outcome-" + outcome, OUTCOME_LABELS[outcome]));
      const sendStatus = Object.hasOwn(SEND_LABELS, candidate.sendStatus) ? candidate.sendStatus : "not_sent";
      const send = node("p", "send-status", SEND_LABELS[sendStatus]);
      send.dataset.status = sendStatus;
      row.append(heading, node("p", "candidate-summary", candidate.summary || "暂无判定说明"), send);
      const details = node("details", "candidate-evidence");
      details.dataset.candidateKey = text(candidate.candidateKey || "candidate-" + index);
      details.open = expanded.has(details.dataset.candidateKey);
      const checks = Array.isArray(candidate.checks) ? candidate.checks.filter((check) => check && typeof check === "object") : [];
      const summary = node("summary", "", "核验依据");
      summary.append(node("span", "evidence-count", checks.filter((check) => check.status === "pass").length + "/" + checks.length + " 项通过"));
      details.append(summary);
      const checkList = node("ul", "check-list");
      for (const check of checks) {
        const status = Object.hasOwn(CHECK_LABELS, check.status) ? check.status : "fail";
        const requirement = profileReady && profile.requirements.find((item) => item.key === check.key);
        const checkRow = node("li", "check-row");
        checkRow.dataset.status = status;
        const checkHeading = node("div", "check-heading");
        checkHeading.append(node("strong", "", (requirement && requirement.label) || check.label || check.key || "岗位要求"), node("span", "check-status", CHECK_LABELS[status]));
        checkRow.append(checkHeading, node("p", "check-evidence", text(check.evidence) || "未提供原文证据"));
        if (check.reason) checkRow.append(node("p", "check-reason", check.reason));
        checkList.append(checkRow);
      }
      if (checks.length) details.append(checkList);
      else details.append(node("p", "check-reason", "未提供逐项核验记录"));
      row.append(details);
      fragment.append(row);
    }
    elements.candidateList.replaceChildren(fragment);
    elements.resultCount.textContent = selectedFilter === "all" ? candidates.length + " 人" : filtered.length + " / " + candidates.length + " 人";
    elements.emptyState.hidden = filtered.length > 0;
    elements.emptyTitle.textContent = candidates.length ? "暂无“" + (OUTCOME_LABELS[selectedFilter] || "全部") + "”候选" : "暂无候选结果";
    elements.emptyMessage.textContent = candidates.length ? "可切换其他筛选条件查看。" : "扫描后的候选人将在此显示。";
  }

  function render() {
    const live = connection === "live";
    const state = (live ? currentState : cachedState || currentState) || {};
    const running = live && Boolean(state.running);
    const busy = Boolean(pendingAction);
    const ready = live && state.frameReady === true;
    const mayBeRunning = Boolean(state.running || ownerTabId != null || uncertainCommand);
    elements.connection.dataset.kind = live ? (ready ? "live" : "waiting") : connection;
    elements.connectionLabel.textContent = live ? (ready ? "已连接" : "页面已连接") : connection === "connecting" ? "正在连接" : "连接失败";
    elements.sourceBadge.textContent = live ? "实时状态" : cachedState ? "本机缓存" : "无实时状态";
    const diagnostics = state.connectionDiagnostics || {};
    const page = state.pageDiagnostics || {};
    const waitingMessage = diagnostics.injectionError ? "列表脚本连接未完成：" + connectionErrorLabel(diagnostics.injectionError) :
      diagnostics.missingFrameIds && diagnostics.missingFrameIds.length ? "页面已连接，正在等待候选列表脚本连接。" :
      page.greetControlCount > 0 ? "已发现打招呼按钮，但未识别候选卡片结构。可导出页面诊断继续排查。" :
      page.greetedControlCount > 0 ? "页面已连接，当前仅发现已沟通状态，暂无可扫描的新候选人。" :
      "页面已连接，当前未发现可扫描的候选卡片。";
    elements.connectionMessage.hidden = connection === "connecting" || ready;
    elements.connectionMessage.dataset.tone = live ? "waiting" : "error";
    elements.connectionMessage.textContent = live ? waitingMessage : "连接失败：" + connectionErrorLabel(connectionError) + "。" + (cachedState ? "以下为本机缓存，实时运行状态未确认。" : "尚未取得页面运行状态。");
    elements.status.closest("section").dataset.kind = live ? (ready && running ? "running" : "idle") : connection;
    elements.status.textContent = pendingAction === "start" ? "正在请求启动" : pendingAction === "stop" ? "正在请求停止" : !live ? (connection === "connecting" ? "正在连接" : "未连接") : !ready ? "等待列表加载" : STATUS_LABELS[state.status] || (running ? "运行中" : "未开始");
    const message = text(state.lastMessage);
    elements.message.textContent = !live ? "实时运行状态未确认" : !ready ? waitingMessage : message === "not-started" ? "尚未开始本轮筛选" : message || "候选列表已就绪";
    elements.currentJob.textContent = text(state.currentJobText) || "未识别";
    elements.currentCandidateRow.hidden = !state.currentCandidateName;
    elements.candidateLabel.textContent = live ? "当前候选" : "缓存候选";
    elements.currentCandidate.textContent = text(state.currentCandidateName);
    elements.phase.textContent = !live ? "未确认" : PHASE_LABELS[state.phase] || text(state.phase) || (running ? "处理中" : "待开始");
    elements.failureLabel.textContent = !live && cachedState ? "缓存停止原因" : running && state.lastFailureReason ? "最近异常" : "停止原因";
    elements.failure.textContent = text(state.lastFailureReason) || (state.running ? "—" : state.status && state.status !== "idle" ? (message && message !== "not-started" ? message : STATUS_LABELS[state.status] || text(state.status)) : "尚未运行");
    elements.failure.dataset.failure = Boolean(state.lastFailureReason).toString();
    elements.runId.textContent = text(state.runId) || "尚未开始";
    const date = state.updatedAt ? new Date(state.updatedAt) : null;
    const validDate = date && Number.isFinite(date.getTime());
    elements.updatedAt.textContent = validDate ? (live ? "更新于 " : "缓存于 ") + date.toLocaleTimeString("zh-CN", { hour12: false }) : live ? "实时读取" : "尚无更新时间";
    if (validDate) elements.updatedAt.dateTime = date.toISOString();
    else elements.updatedAt.removeAttribute("datetime");
    for (const [id, field] of Object.entries({ eligible: "eligibleCount", rejected: "rejectedCount", greeted: "greetedCount", processed: "processedCount", clickAttempts: "clickAttemptCount", unconfirmed: "unconfirmedCount", dryRunMatches: "dryRunMatches" })) {
      elements[id].textContent = String(count(state[field]));
    }
    const locked = !settingsReady || busy || running;
    for (const input of settingInputs) input.disabled = locked;
    elements.confirmEach.disabled = locked || elements.dryRun.checked;
    elements.start.disabled = !settingsReady || !profileReady || !ready || running || busy || uncertainCommand;
    elements.stop.disabled = !live || !running || busy;
    elements.clearAudit.disabled = !settingsReady || mayBeRunning || busy || connection === "connecting";
    elements.clearAttempts.disabled = elements.clearAudit.disabled;
    elements.exportAudit.disabled = !settingsReady;
    elements.reconnect.disabled = busy || refreshing;
    elements.exportDiagnostics.hidden = ready || connection === "connecting";
    elements.exportDiagnostics.disabled = !settingsReady || busy || refreshing;
    elements.openSidePanel.disabled = !sidePanelAvailable || currentWindowId == null;
    elements.startLabel.textContent = elements.dryRun.checked ? "开始扫描" : "开始筛选并打招呼";
    const config = getConfig();
    elements.settingsSummary.textContent = "扫描 " + config.maxCandidates + " 人 · 打招呼 " + config.maxGreetings + " 人 · " + config.minDelayMs / 1000 + "–" + config.maxDelayMs / 1000 + " 秒";
    renderResults(state);
  }

  function isBossUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && (url.hostname === "zhipin.com" || url.hostname.endsWith(".zhipin.com"));
    } catch (_error) {
      return false;
    }
  }

  function isBossTab(tab) {
    return Boolean(tab && Number.isInteger(tab.id) && isBossUrl(tab.url));
  }

  async function getTargetTab() {
    const tab = ownerTabId == null ? (await chrome.tabs.query({ active: true, currentWindow: true }))[0] : await chrome.tabs.get(ownerTabId);
    if (!matchesAttempt(diagnosticAttempt, tab)) {
      diagnosticAttempt = null;
      connectionError = "";
    }
    lastTargetTab = tab || null;
    if (tab && Number.isInteger(tab.windowId)) currentWindowId = tab.windowId;
    if (!isBossTab(tab)) throw new Error("请打开 BOSS 直聘候选人页面");
    return tab;
  }

  async function withTimeout(promise) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("页面连接超时")), 6000); })]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function route(tabId, payload) {
    // One route and one dispatch: uncertain commands are never broadcast or retried.
    const envelope = await withTimeout(chrome.runtime.sendMessage({ type: "BGA_ROUTE_TO_CANDIDATE", tabId, payload }));
    const failure = (message, source) => Object.assign(new Error(message), {
      connectionDiagnostics: (source && source.connectionDiagnostics) || (envelope && envelope.connectionDiagnostics),
      pageDiagnostics: (source && source.pageDiagnostics) || (envelope && envelope.pageDiagnostics)
    });
    if (!envelope || envelope.ok !== true) throw failure(text(envelope && envelope.error) || "后台路由连接失败");
    const response = envelope.response;
    if (!response || response.ok !== true) throw failure("page_script_error: " + (text(response && response.error) || "候选页面未返回有效响应"), response);
    if (!response.state || typeof response.state !== "object" || Array.isArray(response.state)) throw failure("page_script_error: 候选页面未返回有效状态", response);
    if (response.state.runnerVersion !== "0.5.6" || response.state.profileId !== PROFILE_ID || (profileReady && response.state.rulesVersion !== profile.version)) {
      throw failure("页面筛选引擎与当前岗位规则不匹配，请重新加载扩展后刷新 BOSS 页面", response.state);
    }
    return response.state;
  }

  function matchesAttempt(attempt, tab) {
    return Boolean(attempt && tab && attempt.tabId === tab.id && attempt.url === tab.url);
  }

  function beginDiagnosticAttempt(tab) {
    const previous = matchesAttempt(diagnosticAttempt, tab) ? diagnosticAttempt : null;
    diagnosticAttempt = { tabId: tab.id, url: tab.url, attemptedAt: new Date().toISOString(), recoveryStage: "read_state", connectionError: "",
      pageDiagnostics: previous && previous.pageDiagnostics, connectionDiagnostics: previous && previous.connectionDiagnostics };
    return diagnosticAttempt;
  }

  function retainDiagnostics(attempt, source) {
    if (source && source.pageDiagnostics) attempt.pageDiagnostics = diagnosticPage(source.pageDiagnostics);
    if (source && source.connectionDiagnostics) attempt.connectionDiagnostics = diagnosticConnection(source.connectionDiagnostics);
  }

  async function injectPageScripts(tab, frameIds, attempt) {
    if (diagnosticAttempt !== attempt) throw new Error("页面已变化，请重新连接");
    if (!Array.isArray(frameIds) || !frameIds.length || !frameIds.every((id) => Number.isSafeInteger(id) && id >= 0)) return null;
    const keyFor = (id) => tab.id + ":" + tab.url + ":frame:" + id;
    const uncached = frameIds.filter((id) => !injectedDocuments.has(keyFor(id)));
    const eligible = uncached.filter((id) => {
      const failure = injectionFailures.get(keyFor(id));
      return !failure || (failure.attempts < MAX_AUTOMATIC_REPAIRS && failure.retryAt <= Date.now());
    });
    if (!eligible.length) {
      attempt.recoveryStage = !uncached.length ? "repair_cached" :
        uncached.every((id) => injectionFailures.get(keyFor(id)).attempts >= MAX_AUTOMATIC_REPAIRS) ? "repair_exhausted" : "backoff";
      const errorCode = uncached.map((id) => injectionFailures.get(keyFor(id)).errorCode).find(Boolean);
      if (errorCode) attempt.connectionDiagnostics = { ...attempt.connectionDiagnostics, injectionError: errorCode };
      return null;
    }
    for (const id of eligible) {
      const key = keyFor(id);
      injectionFailures.set(key, { attempts: (injectionFailures.get(key)?.attempts || 0) + 1, retryAt: Date.now() + REPAIR_BACKOFF_MS });
    }
    attempt.recoveryStage = "inject_scripts";
    try {
      await withTimeout(chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: eligible }, files: CONTENT_FILES
      }));
      if (diagnosticAttempt !== attempt) throw new Error("页面已变化，请重新连接");
      attempt.recoveryStage = "verify_receiver";
      const state = await route(tab.id, { type: "BGA_STATE" });
      if (diagnosticAttempt !== attempt) throw new Error("页面已变化，请重新连接");
      retainDiagnostics(attempt, state);
      const frames = state.connectionDiagnostics && state.connectionDiagnostics.frames;
      if (!eligible.every((id) => Array.isArray(frames) && frames.some((frame) => frame.frameId === id &&
        frame.connected === true && isBossUrl(frame.url)))) throw new Error("receiver_unconfirmed");
      for (const id of eligible) {
        injectedDocuments.add(keyFor(id));
        injectionFailures.delete(keyFor(id));
      }
      attempt.recoveryStage = "recovered";
      return state;
    } catch (error) {
      if (diagnosticAttempt !== attempt) throw error;
      attempt.recoveryStage = attempt.recoveryStage === "verify_receiver" ? "verification_failed" : "injection_failed";
      retainDiagnostics(attempt, error);
      attempt.connectionDiagnostics = { ...attempt.connectionDiagnostics, injectionError: diagnosticErrorCode(error.message) };
      for (const id of eligible) {
        const key = keyFor(id);
        injectionFailures.set(key, { ...injectionFailures.get(key), errorCode: diagnosticErrorCode(error.message), retryAt: Date.now() + REPAIR_BACKOFF_MS });
      }
      throw error;
    }
  }

  function isMissingReceiver(error) {
    return diagnosticErrorCode(error && error.message) === "receiver_not_found";
  }

  async function findMissingFrames(tab, attempt) {
    attempt.recoveryStage = "discover_frames";
    const frames = await withTimeout(new Promise((resolve, reject) => {
      chrome.webNavigation.getAllFrames({ tabId: tab.id }, (value) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(Array.isArray(value) ? value : []);
      });
    }));
    const frameIds = Array.from(new Set(frames.filter((frame) => frame &&
      Number.isSafeInteger(frame.frameId) && frame.frameId >= 0 && isBossUrl(frame.url))
      .map((frame) => frame.frameId))).sort((a, b) => a - b);
    const health = await Promise.all(frameIds.map(async (frameId) => {
      const frame = frames.find((item) => item.frameId === frameId);
      let response;
      let failure = "";
      let missing = false;
      try {
        response = await withTimeout(new Promise((resolve, reject) => {
          chrome.tabs.sendMessage(tab.id, { type: "BGA_STATE" }, { frameId }, (response) => {
            const error = chrome.runtime.lastError;
            if (error) reject(new Error(error.message));
            else resolve(response);
          });
        }));
      } catch (error) {
        // Empty/invalid responses, closed ports and timeouts do not prove a missing receiver.
        missing = isMissingReceiver(error);
        failure = error.message;
      }
      const connected = Boolean(response && response.ok === true && response.state && typeof response.state === "object" && !Array.isArray(response.state));
      if (!failure && !connected) failure = response && response.ok === false ? "page_script_error: " + text(response.error) : "state_not_available";
      return { frameId, url: frame.url, connected, frameReady: connected && response.state.frameReady === true,
        runnerVersion: connected ? response.state.runnerVersion : "", error: failure, missing };
    }));
    const missing = health.filter((frame) => frame.missing).map((frame) => frame.frameId);
    retainDiagnostics(attempt, { connectionDiagnostics: {
      ...attempt.connectionDiagnostics, frames: health, missingFrameIds: missing
    } });
    return missing;
  }

  async function readPageState(tab) {
    const attempt = beginDiagnosticAttempt(tab);
    try {
      let state;
      try {
        state = await route(tab.id, { type: "BGA_STATE" });
      } catch (error) {
        retainDiagnostics(attempt, error);
        if (!isMissingReceiver(error)) throw error;
        const missing = await findMissingFrames(tab, attempt);
        if (!missing.length) attempt.recoveryStage = "no_missing_frames";
        const repaired = await injectPageScripts(tab, missing, attempt);
        if (!repaired) throw error;
        return repaired;
      }
      retainDiagnostics(attempt, state);
      const diagnostics = state.connectionDiagnostics || {};
      const missing = Array.from(new Set((Array.isArray(diagnostics.frames) ? diagnostics.frames : [])
        .filter((frame) => frame && Number.isSafeInteger(frame.frameId) && frame.frameId >= 0 &&
          frame.connected !== true && isBossUrl(frame.url) && isMissingReceiver({ message: frame.error }) &&
          Array.isArray(diagnostics.missingFrameIds) && diagnostics.missingFrameIds.includes(frame.frameId))
        .map((frame) => frame.frameId))).sort((a, b) => a - b);
      if (!state.running && missing.length) {
        try {
          const repaired = await injectPageScripts(tab, missing, attempt);
          if (repaired) return repaired;
        } catch (error) {
          retainDiagnostics(attempt, error);
          state = { ...state, connectionDiagnostics: { ...attempt.connectionDiagnostics, injectionError: diagnosticErrorCode(error.message) } };
        }
        if (attempt.connectionDiagnostics && attempt.connectionDiagnostics.injectionError) {
          state = { ...state, connectionDiagnostics: { ...state.connectionDiagnostics, injectionError: attempt.connectionDiagnostics.injectionError } };
        }
      }
      if (attempt.recoveryStage === "read_state") attempt.recoveryStage = "connected";
      return state;
    } catch (error) {
      attempt.connectionError = diagnosticErrorCode(error.message);
      if (attempt.recoveryStage === "read_state") attempt.recoveryStage = "route_failed";
      else if (attempt.recoveryStage === "discover_frames") attempt.recoveryStage = "frame_discovery_failed";
      throw error;
    }
  }

  function acceptState(state, tab) {
    currentState = state;
    cachedState = state;
    connectedTab = tab;
    ownerTabId = state.running ? tab.id : null;
    connection = "live";
    connectionError = "";
    uncertainCommand = false;
    render();
  }

  async function refreshState() {
    if (refreshing || pendingAction) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    const version = contextVersion;
    elements.reconnect.disabled = true;
    try {
      const tab = await getTargetTab();
      const state = await readPageState(tab);
      if (version === contextVersion) acceptState(state, tab);
    } catch (error) {
      if (version === contextVersion) {
        connection = "offline";
        connectionError = error.message;
      }
    } finally {
      refreshing = false;
      render();
      if (refreshAgain) {
        refreshAgain = false;
        void refreshState();
      }
    }
  }

  async function saveSettings() {
    const config = getConfig();
    applySettings(config);
    await chrome.storage.local.set({ [SETTINGS_KEY]: config });
    return config;
  }

  async function start() {
    if (elements.start.disabled || pendingAction) return;
    const commandVersion = ++contextVersion;
    pendingAction = "start";
    setNote("");
    render();
    let dispatched = false;
    try {
      const config = await saveSettings();
      const tab = await getTargetTab();
      if (!connectedTab || tab.id !== connectedTab.id || tab.url !== connectedTab.url) throw new Error("页面已切换，请等待当前候选列表连接后再开始");
      dispatched = true;
      ownerTabId = tab.id;
      const state = await route(tab.id, { type: "BGA_START", config });
      if (commandVersion !== contextVersion) throw new Error("启动期间页面已变化，运行状态需重新核实");
      if (state.frameReady !== true) throw new Error("候选列表尚未加载，请等待列表就绪");
      acceptState(state, tab);
    } catch (error) {
      uncertainCommand = dispatched;
      connection = "offline";
      connectionError = error.message;
      setNote(error.message.replace(/^page_script_error:\s*/, "") + (dispatched ? "。启动状态需重新核实，未重复启动。" : "。"), "error");
    } finally {
      pendingAction = "";
      render();
      await refreshState();
    }
  }

  async function stop() {
    if (elements.stop.disabled || pendingAction || !connectedTab) return;
    const commandVersion = ++contextVersion;
    pendingAction = "stop";
    setNote("");
    render();
    try {
      const tab = await chrome.tabs.get(ownerTabId == null ? connectedTab.id : ownerTabId);
      if (!isBossTab(tab)) throw new Error("运行页面已关闭或已离开 BOSS 直聘");
      const state = await route(tab.id, { type: "BGA_STOP" });
      if (commandVersion !== contextVersion) throw new Error("停止期间页面已变化，运行状态需重新核实");
      acceptState(state, tab);
    } catch (error) {
      uncertainCommand = true;
      connection = "offline";
      connectionError = error.message;
      setNote("停止结果未确认：" + error.message + "。", "error");
    } finally {
      pendingAction = "";
      render();
      await refreshState();
    }
  }

  function openSidePanel() {
    if (elements.openSidePanel.disabled) return;
    // Call synchronously in the click handler to preserve Chrome's user gesture.
    try {
      Promise.resolve(chrome.sidePanel.open({ windowId: currentWindowId }))
        .catch((error) => setNote("侧边栏打开失败：" + error.message, "error"));
    } catch (error) {
      setNote("侧边栏打开失败：" + error.message, "error");
    }
  }

  function downloadJson(report, prefix) {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = node("a");
    link.href = url;
    link.download = prefix + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function diagnosticErrorCode(value) {
    if (typeof value !== "string" || !value) return "";
    if (/permission_denied|cannot access contents of url|missing host permission|权限/i.test(value)) return "permission_denied";
    if (/runner_dependencies_missing/i.test(value)) return "runner_dependencies_missing";
    if (/boss_frame_not_found/i.test(value)) return "boss_frame_not_found";
    if (/page_script_error/i.test(value)) return "page_script_error";
    if (/timeout|超时/i.test(value)) return "timeout";
    if (/receiving end does not exist|no receiving end|receiver_not_found/i.test(value)) return "receiver_not_found";
    if (/receiver_unconfirmed/i.test(value)) return "receiver_unconfirmed";
    if (/port_closed|message port closed/i.test(value)) return "port_closed";
    if (/state_not_available/i.test(value)) return "state_not_available";
    if (/inject|executeScript|补注入/i.test(value)) return "injection_failed";
    return "connection_failed";
  }

  function connectionErrorLabel(value) {
    const labels = {
      timeout: "页面连接超时，脚本状态尚未确认",
      receiver_not_found: "页面脚本接收器未连接",
      page_script_error: "页面脚本响应异常",
      runner_dependencies_missing: "页面脚本依赖缺失",
      boss_frame_not_found: "未找到可连接的 BOSS 页面",
      permission_denied: "缺少页面脚本访问权限",
      receiver_unconfirmed: "补注入后尚未确认目标脚本连接",
      port_closed: "页面消息通道已关闭",
      state_not_available: "页面未返回有效状态",
      injection_failed: "页面脚本补注入失败"
    };
    return labels[diagnosticErrorCode(value)] || text(value) || "页面不可用";
  }

  function diagnosticPageUrl(value) {
    if (!isBossUrl(value)) return "";
    const url = new URL(value);
    const host = ["zhipin.com", "www.zhipin.com", "m.zhipin.com"].includes(url.hostname) ? url.hostname : "subdomain.zhipin.com";
    const segments = new Set(["web", "frame", "chat", "geek", "recommend", "index", "index.html", "recommend.html", "chat.html", "boss", "job", "list"]);
    const pathname = url.pathname.split("/").map((segment) => !segment || segments.has(segment) ? segment : ":redacted").join("/");
    return "https://" + host + (url.port ? ":" + url.port : "") + pathname;
  }

  function diagnosticPage(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    // Only known structural vocabulary is retained; arbitrary CSS tokens can contain names.
    const tags = new Set(["a", "article", "aside", "b", "body", "button", "dd", "div", "dl", "dt", "em", "footer", "form", "h1", "h2", "h3", "header", "html", "i", "label", "li", "main", "nav", "ol", "p", "section", "small", "span", "strong", "ul"]);
    const classes = new Set(["recommend-card-wrap", "candidate-card", "card-list", "card-item", "geek-card", "card", "btn", "btn-primary", "btn-greet", "greet", "greet-btn", "greet-button", "op-btn", "recommend-list", "candidate-list", "geek-list", "geek-info", "card-info", "card-content", "card-bottom", "card-footer", "button", "label", "disabled", "active"]);
    const samples = Array.isArray(value.actionSamples) ? value.actionSamples : [];
    return {
      version: count(value.version), pageUrl: diagnosticPageUrl(value.pageUrl),
      candidateCount: count(value.candidateCount), greetControlCount: count(value.greetControlCount),
      greetedControlCount: count(value.greetedControlCount), rawCardElementCount: count(value.rawCardElementCount),
      actionSamples: samples.slice(0, 3).map((sample) => ({
        ancestors: (Array.isArray(sample && sample.ancestors) ? sample.ancestors : []).slice(0, 6).map((ancestor) => {
          const tag = ancestor && typeof ancestor.tag === "string" ? ancestor.tag.toLowerCase() : "";
          return {
            tag: tags.has(tag) ? tag : "unknown",
            classes: Array.from(new Set((Array.isArray(ancestor && ancestor.classes) ? ancestor.classes : [])
              .filter((name) => classes.has(name)))).slice(0, 8)
          };
        })
      }))
    };
  }

  function diagnosticConnection(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const validFrameId = (id) => Number.isSafeInteger(id) && id >= 0;
    return {
      ownerStale: value.ownerStale === true,
      missingFrameIds: Array.from(new Set((Array.isArray(value.missingFrameIds) ? value.missingFrameIds : [])
        .filter(validFrameId))).sort((a, b) => a - b),
      injectionError: diagnosticErrorCode(value.injectionError),
      frames: (Array.isArray(value.frames) ? value.frames : []).filter((frame) => frame && validFrameId(frame.frameId)).map((frame) => ({
        frameId: frame.frameId, url: diagnosticPageUrl(frame.url), connected: frame.connected === true,
        frameReady: frame.frameReady === true,
        runnerVersion: typeof frame.runnerVersion === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(frame.runnerVersion) ? frame.runnerVersion : "",
        error: diagnosticErrorCode(frame.error)
      }))
    };
  }

  async function exportDiagnostics() {
    let tab = null;
    try { tab = await getTargetTab(); } catch (_) { /* An unavailable target has no matching diagnostics. */ }
    const attempt = matchesAttempt(diagnosticAttempt, tab) ? diagnosticAttempt : null;
    const state = connection === "live" && connectedTab && tab && connectedTab.id === tab.id && connectedTab.url === tab.url ? currentState : attempt;
    downloadJson({
      exportedAt: new Date().toISOString(), browser: navigator.userAgent,
      extensionVersion: chrome.runtime.getManifest().version,
      connection, connectionError: attempt ? diagnosticErrorCode(attempt.connectionError) : "", pageUrl: diagnosticPageUrl(tab && tab.url),
      tabId: attempt ? attempt.tabId : null, attemptedAt: attempt ? attempt.attemptedAt : "",
      recoveryStage: attempt ? attempt.recoveryStage : "",
      pageDiagnostics: diagnosticPage(state && state.pageDiagnostics),
      connectionDiagnostics: diagnosticConnection(state && state.connectionDiagnostics)
    }, "boss-page-diagnostics-");
    setNote("页面诊断已导出，不包含候选人姓名或简历正文。");
  }

  async function exportAudit() {
    try {
      const data = await chrome.storage.local.get({ [AUDIT_KEY]: [], [STATE_KEY]: null });
      const report = {
        exportedAt: new Date().toISOString(),
        profile: profileReady ? profile : { id: PROFILE_ID },
        settings: getConfig(),
        stateSource: connection === "live" ? "live" : "cache",
        state: connection === "live" ? currentState : cachedState || data[STATE_KEY],
        records: Array.isArray(data[AUDIT_KEY]) ? data[AUDIT_KEY] : []
      };
      downloadJson(report, "boss-finance-audit-");
      setNote("审计 JSON 已生成。");
    } catch (error) {
      setNote("导出失败：" + error.message, "error");
    }
  }

  async function clearAudit() {
    if (elements.clearAudit.disabled || pendingAction || (currentState && currentState.running) || (cachedState && cachedState.running)) return;
    if (!window.confirm("确认清空本机审计记录？")) return;
    try {
      await chrome.storage.local.set({ [AUDIT_KEY]: [] });
      setNote("审计记录已清空。");
    } catch (error) {
      setNote("清空失败：" + error.message, "error");
    }
  }

  // 上一次点击若停在坐标换算/校验阶段，后台会把记录撤回；这里再提供一个人工兜底：
  // 确认“上次确实没发出去”后清空发送记录，否则该候选人会被永久判为已发送。
  async function clearAttempts() {
    if (elements.clearAttempts.disabled || pendingAction || (currentState && currentState.running) || (cachedState && cachedState.running)) return;
    if (!window.confirm("清空本地发送记录？清空后，已经沟通过的人不会再被自动拦截，可能重复发送。")) return;
    try {
      await chrome.storage.local.remove("bossFinanceGreetingAttempts");
      setNote("发送记录已清空，可以重新发送。");
    } catch (error) {
      setNote("清空失败：" + error.message, "error");
    }
  }

  function invalidateConnection() {
    contextVersion += 1;
    connection = "connecting";
    connectedTab = null;
    diagnosticAttempt = null;
    connectionError = "";
    render();
    void refreshState();
  }

  async function initialize() {
    renderProfile();
    render();
    if (!extensionReady) {
      connection = "offline";
      connectionError = "扩展连接不可用，请从已加载的扩展打开工作台";
      render();
      return;
    }
    try {
      const data = await chrome.storage.local.get({ [STATE_KEY]: null, [SETTINGS_KEY]: DEFAULTS });
      cachedState = data[STATE_KEY] && typeof data[STATE_KEY] === "object" ? data[STATE_KEY] : null;
      applySettings(data[SETTINGS_KEY]);
    } catch (error) {
      applySettings(DEFAULTS);
      setNote("本机设置读取失败：" + error.message, "error");
    }
    settingsReady = true;
    render();
    await refreshState();
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (changes[SETTINGS_KEY] && !pendingAction && !(currentState && currentState.running)) applySettings(changes[SETTINGS_KEY].newValue);
      if (changes[STATE_KEY]) {
        // Shared storage is a cache; a routed page response establishes the live run.
        if (connection !== "live") {
          cachedState = changes[STATE_KEY].newValue || cachedState;
          render();
        }
        void refreshState();
      }
    });
    if (chrome.tabs.onActivated) chrome.tabs.onActivated.addListener(() => { if (ownerTabId == null) invalidateConnection(); });
    if (chrome.tabs.onUpdated) chrome.tabs.onUpdated.addListener((tabId, change) => {
      if (change.status !== "loading" && !change.url) return;
      for (const key of injectedDocuments) if (key.startsWith(tabId + ":")) injectedDocuments.delete(key);
      for (const key of injectionFailures.keys()) if (key.startsWith(tabId + ":")) injectionFailures.delete(key);
      if ((lastTargetTab && lastTargetTab.id === tabId) || ownerTabId === tabId) invalidateConnection();
    });
    if (chrome.tabs.onRemoved) chrome.tabs.onRemoved.addListener((tabId) => {
      if ((lastTargetTab && lastTargetTab.id === tabId) || ownerTabId === tabId) {
        ownerTabId = null;
        invalidateConnection();
      }
    });
    const interval = setInterval(() => { if (!document.hidden) void refreshState(); }, 2500);
    window.addEventListener("pagehide", () => clearInterval(interval), { once: true });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) void refreshState(); });
  }

  elements.start.addEventListener("click", start);
  elements.stop.addEventListener("click", stop);
  elements.openSidePanel.addEventListener("click", openSidePanel);
  elements.reconnect.addEventListener("click", () => {
    injectedDocuments.clear();
    injectionFailures.clear();
    void refreshState();
  });
  elements.exportDiagnostics.addEventListener("click", () => { void exportDiagnostics().catch((error) => setNote("导出失败：" + error.message, "error")); });
  elements.exportAudit.addEventListener("click", exportAudit);
  elements.clearAudit.addEventListener("click", clearAudit);
  elements.clearAttempts.addEventListener("click", clearAttempts);
  for (const input of settingInputs) input.addEventListener("change", () => {
    if (!settingsReady || pendingAction || (currentState && currentState.running)) return;
    void saveSettings().catch((error) => setNote("设置保存失败：" + error.message, "error"));
  });
  for (const input of document.querySelectorAll('input[name="resultFilter"]')) input.addEventListener("change", () => {
    if (!input.checked) return;
    selectedFilter = Object.hasOwn(OUTCOME_LABELS, input.value) ? input.value : "all";
    render();
  });
  void initialize();
})();
