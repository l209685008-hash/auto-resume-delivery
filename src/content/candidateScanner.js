(function () {
  "use strict";

  if (window.BossFinanceRunnerInstalled) return;
  const STATE_KEY = "bossGreetingState";
  const selectors = window.BossGreetingSelectors;
  const safety = window.BossGreetingSafety;
  const rules = window.BossFinanceRules;
  if (!selectors || typeof selectors.getPageDiagnostics !== "function" ||
      typeof selectors.getCurrentJobText !== "function" || !safety ||
      typeof safety.normalizeConfig !== "function" || !rules || !rules.PROFILE ||
      typeof rules.evaluate !== "function" || !window.BossGreetingAudit ||
      !window.BossFinanceProfile || !window.BossCandidateIdentity) {
    throw new Error("runner_dependencies_missing: 页面筛选脚本依赖不完整");
  }
  let runState = idleState();
  let task = null;
  let starting = false;
  let overlay = null;

  function idleState() {
    return {
      running: false, status: "idle", runId: "", startedAt: "", updatedAt: "",
      processedCount: 0, eligibleCount: 0, rejectedCount: 0,
      greetedCount: 0, skippedCount: 0, dryRunMatches: 0, clickAttemptCount: 0,
      unconfirmedCount: 0, lastFailureReason: "", lastMessage: "等待开始扫描",
      currentJobText: "", currentJobRule: "cross_border_finance", phase: "idle",
      currentCandidateName: "", recentCandidates: [], seen: new Set()
    };
  }

  function publicState() {
    const { seen, ...state } = runState;
    const pageDiagnostics = selectors.getPageDiagnostics();
    return { ...state, runnerVersion: "0.5.6", profileId: rules.PROFILE.id,
      currentJobText: runState.running ? state.currentJobText : selectors.getCurrentJobText(),
      rulesVersion: rules.PROFILE.version, frameReady: pageDiagnostics.candidateCount > 0, pageDiagnostics };
  }

  function saveState() {
    runState.updatedAt = new Date().toISOString();
    chrome.storage.local.set({ [STATE_KEY]: publicState() });
    renderOverlay();
  }

  function message(text, phase) {
    if (!runState.running) return;
    runState.lastMessage = text;
    if (phase) runState.phase = phase;
    saveState();
  }

  function background(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!response || !response.ok) return reject(new Error(response && response.error || "后台连接失败"));
        resolve(response);
      });
    });
  }

  async function audit(type, payload) {
    return window.BossGreetingAudit.audit(runState.runId, type, payload);
  }

  // 审计只是留痕：写入失败要显示出来，但不能因此中断筛选，更不能因此影响发送判断。
  async function auditSafe(type, payload) {
    try {
      await audit(type, payload);
    } catch (error) {
      runState.lastFailureReason = `审计写入失败，已继续运行：${error.message}`;
    }
  }

  function hash(value) {
    let result = 2166136261;
    for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
    return `candidate-${(result >>> 0).toString(16)}`;
  }

  function parseCandidate(card) {
    const profile = window.BossFinanceProfile.extract(card);
    const nameElement = card.querySelector("[data-candidate-name], .geek-name, .candidate-name, .name");
    const name = nameElement ? selectors.normalizeText(nameElement.textContent).slice(0, 30) : "姓名未显示";
    const identity = selectors.candidateIdentity(card);
    const candidateKey = identity || hash(JSON.stringify([name, profile.educationText, profile.workEntries]));
    return { name, candidateKey, candidateAliases: selectors.candidateAliases(card), identityVerified: Boolean(identity), profile };
  }

  function renderOverlay() {
    if (!runState.running) {
      if (overlay) overlay.remove();
      overlay = null;
      return;
    }
    if (!overlay) {
      overlay = document.createElement("aside");
      overlay.id = "boss-greeting-assistant-overlay";
      overlay.setAttribute("aria-label", "招聘助手运行状态");
      Object.assign(overlay.style, {
        position: "fixed", right: "16px", bottom: "16px", zIndex: "2147483647",
        width: "230px", padding: "12px", background: "#fff", color: "#27343b",
        border: "1px solid #cbd5d8", borderRadius: "6px",
        boxShadow: "0 3px 14px #0002", font: "13px/1.5 sans-serif"
      });
      const title = document.createElement("strong");
      title.textContent = "财务专业 · 招聘助手";
      const status = document.createElement("p");
      status.dataset.field = "message";
      status.style.overflowWrap = "anywhere";
      const count = document.createElement("p");
      count.dataset.field = "counts";
      const stop = document.createElement("button");
      stop.textContent = "停止运行";
      Object.assign(stop.style, { width: "100%", padding: "6px", cursor: "pointer" });
      stop.addEventListener("click", () => stopRun("您已停止本次运行", "stopped"));
      overlay.append(title, status, count, stop);
      document.documentElement.append(overlay);
    }
    overlay.querySelector("[data-field='message']").textContent = runState.lastMessage;
    overlay.querySelector("[data-field='counts']").textContent =
      `已扫描 ${runState.processedCount} · 符合 ${runState.eligibleCount} · 已发送 ${runState.greetedCount}`;
  }

  function blocker() { return safety.detectHumanRequiredBlocker(); }

  async function checkRun(config) {
    if (!runState.running) return false;
    const reason = blocker();
    if (reason) {
      await stopRun(`请人工处理：${reason}`, "human_required");
      return false;
    }
    if (Date.now() - Date.parse(runState.startedAt) > config.maxRuntimeMs) {
      await stopRun("达到本次运行时长上限", "max_runtime");
      return false;
    }
    const context = await background({ type: "BGA_VALIDATE_RUN", runId: runState.runId });
    if (context.jobText && config.jobText && context.jobText !== config.jobText) {
      await stopRun("当前岗位已切换，请核对后重新开始", "job_changed");
      return false;
    }
    return runState.running;
  }

  function limitReached(config) {
    return runState.processedCount >= config.maxCandidates ||
      (!config.dryRun && runState.clickAttemptCount >= config.maxGreetings);
  }

  function sameCandidate(card, key) {
    return card && card.isConnected && parseCandidate(card).candidateKey === key;
  }

  function recheckCandidate(card, candidate, result) {
    if (!sameCandidate(card, candidate.candidateKey)) return false;
    const latest = rules.evaluate(window.BossFinanceProfile.extract(card));
    if (latest.outcome !== result.outcome) {
      const counters = { match: "eligibleCount", reject: "rejectedCount" };
      runState[counters[result.outcome]] -= 1;
      runState[counters[latest.outcome]] += 1;
    }
    Object.assign(result, { outcome: latest.outcome, checks: latest.checks, summary: latest.summary });
    return latest.eligible;
  }

  async function greet(config, card, candidate, result) {
    if (config.dryRun) {
      runState.dryRunMatches += 1;
      result.sendStatus = "dry_run";
      return;
    }
    if (!candidate.identityVerified) {
      result.sendStatus = "skipped";
      result.summary = "缺少稳定的候选人身份，不能自动发送";
      return;
    }
    if (config.requirePerCandidateConfirm && !window.confirm(`给 ${candidate.name} 打招呼？\n${result.summary}`)) {
      result.sendStatus = "skipped";
      runState.skippedCount += 1;
      return;
    }
    if (!await checkRun(config)) return;
    if (!recheckCandidate(card, candidate, result)) { result.sendStatus = "skipped"; return; }
    const button = selectors.findGreetButton(card);
    if (!button || safety.isElementDisabled(button) || !sameCandidate(card, candidate.candidateKey)) {
      result.sendStatus = "skipped";
      runState.lastFailureReason = "候选卡片已变化或按钮不可用";
      return;
    }
    const originalLabel = selectors.normalizeText(button.textContent);
    // 显式 instant：页面若设置了 scroll-behavior: smooth，滚动会在动画中途被量到坐标。
    button.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    await safety.sleep(250);
    if (!runState.running || blocker() || !sameCandidate(card, candidate.candidateKey) ||
        !selectors.topClickable(button)) {
      result.sendStatus = "skipped";
      runState.lastFailureReason = "按钮被遮挡或页面状态已变化";
      return;
    }
    const prepared = await background({
      type: "BGA_PREPARE_ATTEMPT", runId: runState.runId, candidateKey: candidate.candidateKey,
      candidateAliases: selectors.candidateAliases(card)
    });
    if (!prepared.allowed) {
      result.sendStatus = "skipped";
      result.summary = "该候选人已有发送记录，不重复发送";
      return;
    }
    // Persist first; an uncertain send never falls back to another click.
    if (!await checkRun(config) || !recheckCandidate(card, candidate, result)) { result.sendStatus = "skipped"; return; }
    runState.clickAttemptCount += 1;
    result.sendStatus = "sending";
    message(`正在给 ${candidate.name} 打招呼`, "clicking");
    const rect = button.getBoundingClientRect();
    let clickError = "";
    try {
      await background({
        type: "BGA_TRUSTED_CLICK", runId: runState.runId, candidateKey: candidate.candidateKey,
        frameUrl: location.href,
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      });
    } catch (error) { clickError = error.message; }
    message("等待页面确认发送结果", "confirming");
    let confirmed = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      // 点完按钮的类名与 DOM 都可能被重建，按卡片重新查一次“已沟通”控件，不依赖原节点。
      if (sameCandidate(card, candidate.candidateKey) &&
          (selectors.findGreetedControl(card) || selectors.findConvertedControl(card, originalLabel))) { confirmed = true; break; }
      if (!runState.running || blocker()) break;
      await safety.sleep(250);
    }
    result.sendStatus = confirmed ? "confirmed" : "unconfirmed";
    if (confirmed) runState.greetedCount += 1;
    else {
      runState.unconfirmedCount += 1;
      runState.lastFailureReason = clickError || "页面未确认，已记录且不会重试";
    }
    saveState();
    await background({
      type: "BGA_FINISH_ATTEMPT", runId: runState.runId,
      candidateKey: candidate.candidateKey, outcome: result.sendStatus
    });
    await auditSafe(confirmed ? "GREETING_CONFIRMED" : "GREETING_UNCONFIRMED", {
      candidateKey: candidate.candidateKey, outcome: result.sendStatus, reason: clickError
    });
    if (clickError) await stopRun(`发送连接异常，停止以避免重复：${clickError}`, "error");
    if (runState.running) await safety.sleep(safety.randomDelay(config.minDelayMs, config.maxDelayMs));
  }

  // 候选人列表可能整块放在 iframe 里（推荐页就有这种布局）。点击坐标要换算到顶层视口，
  // 这里让框架自己逐层累加 frameElement 的位置：不依赖 iframe 的 src 属性是否等于当前
  // 地址（SPA 改写、相对路径、嵌套 iframe 都会让按 URL 查找失败），也不依赖框架是顶层子节点。
  function frameOffsetFromWindow() {
    let left = 0;
    let top = 0;
    let current = window;
    for (let depth = 0; current !== window.top; depth += 1) {
      if (depth >= 8) return { ok: false, error: "候选框架嵌套过深，无法可靠定位按钮" };
      let frame;
      try { frame = current.frameElement; }
      catch (_) { return { ok: false, error: "候选框架跨域，无法可靠定位按钮" }; }
      if (!frame) return { ok: false, error: "无法定位候选人所在的框架" };
      const rect = frame.getBoundingClientRect();
      if (Math.abs(rect.width - frame.offsetWidth) > 2 || Math.abs(rect.height - frame.offsetHeight) > 2) {
        return { ok: false, error: "候选框架存在缩放，无法可靠定位按钮" };
      }
      left += rect.left + frame.clientLeft;
      top += rect.top + frame.clientTop;
      current = current.parent;
    }
    return { ok: true, rect: { left, top } };
  }

  async function loadMore() {    message("正在滚动加载候选人", "loading");
    const card = selectors.getCandidateCards()[0];
    let container = card && card.parentElement;
    while (container && container !== document.body) {
      if (/auto|scroll/.test(getComputedStyle(container).overflowY) && container.scrollHeight > container.clientHeight + 40) break;
      container = container.parentElement;
    }
    (container && container !== document.body ? container : window).scrollBy({ top: Math.max(400, innerHeight * 0.7), behavior: "instant" });
    await safety.sleep(800);
  }

  async function scan(config) {
    let emptyLoads = 0;
    let consecutiveUnconfirmed = 0;
    while (await checkRun(config) && !limitReached(config)) {
      const cards = selectors.getCandidateCards();
      let progress = false;
      for (const card of cards) {
        if (!runState.running || limitReached(config)) break;
        if (!card.isConnected || !selectors.visible(card)) continue;
        const candidate = parseCandidate(card);
        if (runState.seen.has(candidate.candidateKey)) continue;
        runState.seen.add(candidate.candidateKey);
        progress = true;
        runState.processedCount += 1;
        runState.currentCandidateName = candidate.name;
        message(`核对 ${candidate.name} 的岗位证据`, "evaluating");
        const decision = rules.evaluate(candidate.profile);
        const result = {
          candidateKey: candidate.candidateKey, name: candidate.name, outcome: decision.outcome,
          summary: decision.summary, checks: decision.checks, sendStatus: "not_sent"
        };
        runState.recentCandidates = [result, ...runState.recentCandidates].slice(0, 100);
        if (decision.outcome === "match") runState.eligibleCount += 1;
        else runState.rejectedCount += 1;
        await auditSafe("CANDIDATE_EVALUATED", result);
        if (decision.eligible) {
          await greet(config, card, candidate, result);
          consecutiveUnconfirmed = result.sendStatus === "unconfirmed" ? consecutiveUnconfirmed + 1 : 0;
          if (consecutiveUnconfirmed >= 3) {
            await stopRun("连续三次未获页面确认，已停止且不会重复发送", "confirmation_failed");
          }
        } else runState.skippedCount += 1;
        saveState();
        if (!runState.running || blocker()) break;
      }
      if (!runState.running) return;
      if (limitReached(config)) break;
      emptyLoads = progress ? 0 : emptyLoads + 1;
      if (emptyLoads >= safety.MAX_EMPTY_LOADS) {
        await stopRun("没有发现新的候选人，本次扫描已结束", "no_more_progress");
        return;
      }
      await loadMore();
    }
    if (runState.running) {
      if (runState.processedCount >= config.maxCandidates) {
        await stopRun(`已达到本次扫描人数上限（${config.maxCandidates} 人）`, "scan_limit_reached");
      } else {
        await stopRun("已达到本次发送尝试上限", "limit_reached");
      }
    }
  }

  async function startRun(rawConfig) {
    if (starting || task || runState.running) throw new Error("已有任务正在运行或结束中，请稍候");
    if (!/(^|\.)zhipin\.com$/.test(location.hostname)) throw new Error("仅能在 BOSS 直聘页面运行");
    if (!selectors.getCandidateCards().length) throw new Error("未找到候选人卡片，请打开推荐牛人列表");
    starting = true;
    try {
      const config = safety.normalizeConfig(rawConfig);
      const id = window.BossGreetingAudit.uuid();
      const claim = await background({ type: "BGA_CLAIM_RUN", runId: id, dryRun: config.dryRun });
      runState = idleState();
      runState.runId = id;
      runState.running = true;
      runState.status = "running";
      runState.startedAt = new Date().toISOString();
      runState.currentJobText = claim.jobText || rules.PROFILE.title;
      config.jobText = claim.jobText;
      message(config.dryRun ? "开始扫描财务专业候选人" : "开始筛选并打招呼", "scanning");
      try { await audit("RUN_STARTED", { ...config, rulesVersion: rules.PROFILE.version }); }
      catch (error) { await stopRun(`无法保存运行记录：${error.message}`, "error"); throw error; }
      task = scan(config).catch(async (error) => {
        await stopRun(`运行异常：${error.message}`, "error");
      }).finally(() => { task = null; });
      return publicState();
    } finally { starting = false; }
  }

  async function stopRun(text, status) {
    if (!runState.running) return publicState();
    runState.running = false;
    runState.status = status || "stopped";
    runState.phase = "stopped";
    runState.lastMessage = text;
    saveState();
    try {
      await audit("RUN_STOPPED", { status: runState.status, reason: text });
    } catch (error) {
      runState.lastFailureReason = error.message;
      saveState();
    } finally {
      try { await background({ type: "BGA_RELEASE_RUN", runId: runState.runId }); }
      catch (error) { runState.lastFailureReason = error.message; saveState(); }
    }
    return publicState();
  }

  async function handleMessage(payload) {
    if (!payload) return { ok: false, error: "缺少消息" };
    if (payload.type === "BGA_START") return { ok: true, state: await startRun(payload.config) };
    if (payload.type === "BGA_STOP") return { ok: true, state: await stopRun("您已停止本次运行", "stopped") };
    if (payload.type === "BGA_STATE") return { ok: true, state: publicState() };
    if (payload.type === "BGA_PAGE_CONTEXT") return { ok: true, context: selectors.getCurrentJobContext ?
      selectors.getCurrentJobContext() : { currentJobText: selectors.getCurrentJobText() } };
    if (payload.type === "BGA_VALIDATE_TARGET") {
      const card = selectors.getCandidateCards().find((item) => parseCandidate(item).candidateKey === payload.candidateKey);
      const button = card && selectors.findGreetButton(card);
      const result = runState.recentCandidates.find((item) => item.candidateKey === payload.candidateKey);
      if (!runState.running || runState.runId !== payload.runId || blocker() || !button || !selectors.topClickable(button) ||
          !result || !recheckCandidate(card, parseCandidate(card), result)) {
        return { ok: false, error: "候选人或按钮状态已变化，禁止点击" };
      }
      const rect = button.getBoundingClientRect();
      if (["left", "top", "width", "height"].some((key) => Math.abs(rect[key] - Number(payload.rect[key])) > 2)) {
        return { ok: false, error: "按钮位置已变化，禁止点击" };
      }
      return { ok: true };
    }
    if (payload.type === "BGA_FRAME_OFFSET") return frameOffsetFromWindow();
    if (payload.type === "BGA_GET_FRAME_RECT") {
      const frames = Array.from(document.querySelectorAll("iframe")).filter((frame) => {
        try { return new URL(frame.src, location.href).href === payload.frameUrl; } catch (_) { return false; }
      });
      if (frames.length !== 1) return { ok: false, error: "无法唯一定位候选人所在的 iframe" };
      const frame = frames[0];
      const rect = frame.getBoundingClientRect();
      if (Math.abs(rect.width - frame.offsetWidth) > 2 || Math.abs(rect.height - frame.offsetHeight) > 2) {
        return { ok: false, error: "候选框架存在缩放，无法可靠定位按钮" };
      }
      return { ok: true, rect: { left: rect.left + frame.clientLeft, top: rect.top + frame.clientTop,
        width: frame.clientWidth, height: frame.clientHeight } };
    }
    return { ok: false, error: "未知消息" };
  }

  chrome.runtime.onMessage.addListener((payload, _sender, respond) => {
    handleMessage(payload).then(respond).catch((error) => respond({ ok: false, error: error.message }));
    return true;
  });
  window.BossGreetingAssistantHandleMessage = handleMessage;
  window.BossFinanceRunnerInstalled = true;
})();
