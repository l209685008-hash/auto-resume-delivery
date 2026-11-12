importScripts("../content/candidateIdentity.js");

(function () {
  "use strict";

  const DEBUGGER_VERSION = "1.3";
  const attachedTabs = new Set();
  const OWNER_KEY = "bossFinanceRunOwner";
  const ATTEMPTS_KEY = "bossFinanceGreetingAttempts";
  const FRAME_PROBE_TIMEOUT_MS = 1500;
  let mutationQueue = Promise.resolve();
  let ownershipQueue = Promise.resolve();
  const cancelledRuns = new Set();

  function runToken(message, sender) {
    return `${sender.tab.id}:${sender.frameId || 0}:${message.runId}`;
  }

  function assertNotCancelled(message, sender) {
    if (cancelledRuns.has(runToken(message, sender))) throw new Error("任务已停止，已取消点击");
  }

  function identityAliases(record) {
    return BossCandidateIdentity.aliases([record.candidateKey, ...(record.candidateAliases || [])]);
  }

  function isBossUrl(value) {
    try { const url = new URL(value); return url.protocol === "https:" && /(^|\.)zhipin\.com$/.test(url.hostname); }
    catch (_) { return false; }
  }

  async function owner() {
    return (await chrome.storage.session.get(OWNER_KEY))[OWNER_KEY] || null;
  }

  function updateOwner(update) {
    const operation = ownershipQueue.catch(() => {}).then(update);
    ownershipQueue = operation;
    return operation;
  }

  async function invalidateOwner(current) {
    // Block suspended clicks before awaiting storage or releasing ownership.
    cancelledRuns.add(`${current.tabId}:${current.frameId || 0}:${current.runId}`);
    await updateOwner(async () => {
      const latest = await owner();
      if (latest && latest.tabId === current.tabId && latest.frameId === current.frameId && latest.runId === current.runId) {
        await chrome.storage.session.remove(OWNER_KEY);
      }
    });
  }

  async function requireOwner(message, sender) {
    const current = await owner();
    if (!current || current.runId !== message.runId || current.tabId !== sender.tab.id ||
        current.frameId !== (sender.frameId || 0)) throw new Error("运行归属已改变，请重新开始");
    if (message.type !== "BGA_RELEASE_RUN") assertNotCancelled(message, sender);
    return current;
  }

  async function jobContext(tabId, candidateFrameId, selectedFrameIds = []) {
    const frameIds = Array.from(new Set([0, candidateFrameId || 0]));
    const contexts = await Promise.all(frameIds.map(async (frameId) => {
      let timer;
      try {
        const response = await Promise.race([
          sendToFrame(tabId, frameId, { type: "BGA_PAGE_CONTEXT" }),
          new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("frame_context_timeout")), FRAME_PROBE_TIMEOUT_MS); })
        ]);
        return response && response.ok === true && response.context?.jobStatus !== "ambiguous" &&
          typeof response.context?.currentJobText === "string" ?
          { frameId, valid: true, title: response.context.currentJobText.trim() } : { frameId, valid: false };
      } catch (error) {
        // The recommendation iframe may own the selector while the host has no receiver.
        return { frameId, valid: frameId === 0 && candidateFrameId !== 0 &&
          /receiving end does not exist|no receiving end|receiver_not_found/i.test(error.message), title: "" };
      } finally { clearTimeout(timer); }
    }));
    const missing = { jobText: "", selectedFrameIds: [] };
    if (contexts.some((context) => !context.valid) || selectedFrameIds.some((frameId) =>
      !contexts.some((context) => context.frameId === frameId && context.title))) return missing;
    const titles = Array.from(new Set(contexts.map((context) => context.title).filter(Boolean)));
    return titles.length === 1 ? { jobText: titles[0],
      selectedFrameIds: contexts.filter((context) => context.title).map((context) => context.frameId) } : missing;
  }

  async function controlRun(message, sender) {
    if (!sender.tab || !isBossUrl(sender.tab.url) || !isBossUrl(sender.url)) throw new Error("消息来源不是 BOSS 页面");
    const tabId = sender.tab.id;
    if (message.type === "BGA_CLAIM_RUN") {
      return updateOwner(async () => {
        assertNotCancelled(message, sender);
        if (await owner()) throw new Error("已有招聘任务正在运行，请先停止原任务");
        const context = await jobContext(tabId, sender.frameId || 0);
        const jobText = context.jobText;
        if (!message.dryRun && !/财务|会计|财经|审计|税务|金融/.test(jobText)) {
          throw new Error("发送前须在页面明确选中财务/财经类岗位；目前可使用只扫描模式");
        }
        assertNotCancelled(message, sender);
        await chrome.storage.session.set({ [OWNER_KEY]: {
          tabId, frameId: sender.frameId || 0, runId: message.runId,
          jobText, selectedJobFrames: context.selectedFrameIds, dryRun: message.dryRun !== false
        } });
        return { ok: true, jobText };
      });
    }
    if (message.type === "BGA_FINISH_ATTEMPT") {
      const data = await chrome.storage.local.get({ [ATTEMPTS_KEY]: [] });
      const attempts = data[ATTEMPTS_KEY];
      const row = attempts.find((item) => item.candidateKey === message.candidateKey &&
        item.runId === message.runId && item.tabId === tabId && item.frameId === (sender.frameId || 0));
      if (!row || !["confirmed", "unconfirmed"].includes(message.outcome)) throw new Error("无对应的发送记录");
      row.status = message.outcome;
      row.finishedAt = new Date().toISOString();
      await chrome.storage.local.set({ [ATTEMPTS_KEY]: attempts });
      return { ok: true };
    }
    if (message.type === "BGA_RELEASE_RUN") {
      return updateOwner(async () => {
        const latest = await owner();
        if (latest && (latest.runId !== message.runId || latest.tabId !== tabId || latest.frameId !== (sender.frameId || 0))) {
          throw new Error("运行归属已改变，请重新开始");
        }
        if (latest) await chrome.storage.session.remove(OWNER_KEY);
        return { ok: true };
      });
    }
    const current = await requireOwner(message, sender);
    const context = await jobContext(tabId, current.frameId, current.selectedJobFrames || []);
    const jobText = context.jobText;
    if (!current.dryRun && (!jobText || jobText !== current.jobText)) throw new Error("页面岗位已改变或无法确认，已禁止继续发送");
    if (message.type === "BGA_VALIDATE_RUN") return { ok: true, jobText };
    if (current.dryRun) throw new Error("只扫描模式禁止发送");
    const data = await chrome.storage.local.get({ [ATTEMPTS_KEY]: [] });
    const attempts = data[ATTEMPTS_KEY];
    if (message.type === "BGA_PREPARE_ATTEMPT") {
      const aliases = identityAliases(message);
      if (!aliases.length) return { ok: true, allowed: false };
      const previous = attempts.filter((row) => identityAliases(row).some((key) => aliases.includes(key)));
      if (previous.length) {
        const combined = Array.from(new Set([...aliases, ...previous.flatMap(identityAliases)]));
        for (const row of previous) row.candidateAliases = combined;
        await chrome.storage.local.set({ [ATTEMPTS_KEY]: attempts });
        return { ok: true, allowed: false };
      }
      if (attempts.filter((row) => row.runId === current.runId).length >= 60 || attempts.length >= 5000) {
        throw new Error("达到发送记录上限，已停止");
      }
      attempts.push({ candidateKey: message.candidateKey, candidateAliases: aliases, runId: current.runId, tabId,
        frameId: current.frameId, status: "prepared", createdAt: new Date().toISOString() });
      await chrome.storage.local.set({ [ATTEMPTS_KEY]: attempts });
      return { ok: true, allowed: true };
    }
    if (message.type === "BGA_TRUSTED_CLICK") {
      const row = attempts.find((item) => item.candidateKey === message.candidateKey && item.runId === current.runId);
      if (!row || row.status !== "prepared") throw new Error("该次发送已执行或缺少持久记录，禁止重试");
      row.status = "clicked_unknown";
      await chrome.storage.local.set({ [ATTEMPTS_KEY]: attempts });
      return null;
    }
    throw new Error("未知运行控制请求");
  }

  function lastErrorMessage() {
    return chrome.runtime.lastError ? chrome.runtime.lastError.message : "";
  }

  function sendCommand(tabId, method, params) {
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
        const error = lastErrorMessage();
        if (error) reject(new Error(error));
        else resolve(result);
      });
    });
  }

  function attachDebugger(tabId) {
    if (attachedTabs.has(tabId)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, DEBUGGER_VERSION, () => {
        const error = lastErrorMessage();
        if (error) {
          reject(new Error(error));
          return;
        }
        attachedTabs.add(tabId);
        resolve();
      });
    });
  }

  function detachDebugger(tabId) {
    if (!attachedTabs.has(tabId)) return;
    chrome.debugger.detach({ tabId }, () => {
      attachedTabs.delete(tabId);
    });
  }

  function sendToTopFrame(tabId, message) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, (response) => {
        const error = lastErrorMessage();
        if (error) reject(new Error(error));
        else resolve(response);
      });
    });
  }

  function sendToFrame(tabId, frameId, message) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, { frameId }, (response) => {
        const error = lastErrorMessage();
        if (error) reject(new Error(error));
        else resolve(response);
      });
    });
  }

  async function getFrames(tabId) {
    return new Promise((resolve, reject) => {
      chrome.webNavigation.getAllFrames({ tabId }, (frames) => {
        const error = lastErrorMessage();
        if (error) reject(new Error(error));
        else resolve(Array.isArray(frames) ? frames : []);
      });
    });
  }

  function getTab(tabId) {
    return new Promise((resolve, reject) => {
      chrome.tabs.get(tabId, (tab) => {
        const error = lastErrorMessage();
        if (error) reject(new Error(error));
        else resolve(tab);
      });
    });
  }

  async function probeCandidateFrames(tabId, ownerOnly) {
    const current = await owner();
    const frames = await getFrames(tabId);
    const currentOwner = current && current.tabId === tabId ? current : null;
    let ownerStale = false;

    if (currentOwner && !frames.some((frame) => frame.frameId === currentOwner.frameId)) {
      ownerStale = true;
      await invalidateOwner(currentOwner);
    }

    const targets = ownerOnly && currentOwner ? frames.filter((frame) => frame.frameId === currentOwner.frameId) : frames;
    const probes = await Promise.all(targets.map(async (frame) => {
      let response;
      let error = "";
      let timer;
      try {
        response = await Promise.race([
          sendToFrame(tabId, frame.frameId, { type: "BGA_STATE" }),
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("frame_state_timeout")), FRAME_PROBE_TIMEOUT_MS);
          })
        ]);
        if (response && !response.ok) error = "page_script_error: " + (response.error || "state_not_available");
      } catch (failure) {
        error = failure.message;
      } finally { clearTimeout(timer); }
      const connected = Boolean(response && response.ok && response.state);
      let url = "";
      try { const parsed = new URL(frame.url); url = parsed.origin + parsed.pathname; }
      catch (_) { /* Invalid frame URLs cannot be injection or control targets. */ }
      const probe = { frame, response, diagnostics: {
        frameId: frame.frameId, url, connected,
        frameReady: connected && response.state.frameReady === true,
        runnerVersion: connected && response.state.runnerVersion || "", error
      } };

      if (currentOwner && frame.frameId === currentOwner.frameId &&
          (!isBossUrl(frame.url) || !connected || response.state.runId !== currentOwner.runId ||
           response.state.running !== true || cancelledRuns.has(`${tabId}:${frame.frameId}:${currentOwner.runId}`))) {
        ownerStale = true;
        await invalidateOwner(currentOwner);
      }
      return probe;
    }));

    if (currentOwner && !ownerStale) {
      const latest = await owner();
      if (!latest || latest.tabId !== currentOwner.tabId || latest.frameId !== currentOwner.frameId ||
          latest.runId !== currentOwner.runId || cancelledRuns.has(`${tabId}:${currentOwner.frameId}:${currentOwner.runId}`)) {
        ownerStale = true;
        await invalidateOwner(currentOwner);
      }
    }

    return { probes, currentOwner: ownerStale ? null : currentOwner, diagnostics: {
      frames: probes.map((probe) => probe.diagnostics),
      missingFrameIds: probes.filter((probe) => !probe.response && isBossUrl(probe.frame.url) &&
        /receiver_not_found|receiving end does not exist/i.test(probe.diagnostics.error))
        .map((probe) => probe.frame.frameId),
      ownerStale
    } };
  }

  async function routeToCandidateFrame(tabId, message) {
    const tab = await getTab(tabId);
    if (!isBossUrl(tab.url)) throw new Error("请先打开 BOSS 直聘页面");
    const { probes, currentOwner, diagnostics } = await probeCandidateFrames(tabId, message.type === "BGA_STOP");
    const readOnly = message.type === "BGA_STATE";
    if (!readOnly && diagnostics.ownerStale) throw new Error("原任务连接已失效并已停止，请显式重新开始");
    const online = probes.filter((probe) => isBossUrl(probe.frame.url) && probe.diagnostics.connected);
    const ready = online.filter((probe) => probe.diagnostics.frameReady);
    const owned = currentOwner && online.find((probe) => probe.frame.frameId === currentOwner.frameId);
    if (!online.length) {
      const allowed = probes.filter((probe) => isBossUrl(probe.frame.url));
      const error = new Error(!allowed.length ? "boss_frame_not_found: 当前页面中没有可连接的 BOSS 框架" :
        allowed.some((probe) => probe.response) ? "page_script_error: 页面脚本响应异常，请导出页面诊断" :
        allowed.some((probe) => probe.diagnostics.error === "frame_state_timeout") ? "frame_state_timeout: 页面状态响应超时，请稍后重新连接" :
        allowed.every((probe) => /receiver_not_found|receiving end does not exist/i.test(probe.diagnostics.error)) ?
          "receiver_not_found: 页面脚本尚未连接" : "page_script_error: 页面脚本响应异常，请导出页面诊断");
      error.connectionDiagnostics = diagnostics;
      throw error;
    }

    if (readOnly) {
      if (!owned && ready.length > 1) throw new Error("发现多个候选列表，请只保留一个列表");
      const selected = owned || ready[0] || online[0];
      return { ...selected.response, frameId: selected.frame.frameId, state: {
        ...selected.response.state, frameReady: selected.diagnostics.frameReady, connectionDiagnostics: diagnostics
      } };
    }

    // Only read-only probes fan out. A control message is dispatched exactly once.
    const selected = message.type !== "BGA_START" && owned ? owned : ready.length === 1 ? ready[0] : null;
    if (!selected) throw new Error(ready.length ? "发现多个候选列表，请只保留一个列表" : "未找到候选列表，请打开推荐牛人页");
    const response = await sendToFrame(tabId, selected.frame.frameId, message);
    return { ...(response || {}), frameId: selected.frame.frameId };
  }

  async function getFrameOffset(tabId, frameId, frameUrl) {
    if (!frameId) return { left: 0, top: 0 };
    // 候选框架自己换算偏移最可靠：iframe 的 src 属性可能和当前地址不一致
    // （SPA 改写、相对路径、嵌套 iframe），按 URL 在顶层查找会找不到或找到多个。
    try {
      const local = await sendToFrame(tabId, frameId, { type: "BGA_FRAME_OFFSET" });
      if (local && local.ok && local.rect) {
        return { left: Number(local.rect.left) || 0, top: Number(local.rect.top) || 0 };
      }
      if (local && local.error) throw new Error(local.error);
    } catch (error) {
      if (!/receiving end does not exist|no receiving end|receiver_not_found/i.test(error.message)) throw error;
    }
    const response = await sendToTopFrame(tabId, {
      type: "BGA_GET_FRAME_RECT",
      frameUrl
    });
    if (!response || !response.ok || !response.rect) {
      throw new Error(response && response.error ? response.error : "frame rect not found");
    }
    return {
      left: Number(response.rect.left) || 0,
      top: Number(response.rect.top) || 0
    };
  }

  // 点击未发出时（坐标换算/校验阶段失败），把 prepared→clicked_unknown 的记录撤回，
  // 否则这个候选人会被永久判为“已发送过”而再也发不出去。
  async function discardUnsentAttempt(message) {
    const data = await chrome.storage.local.get({ [ATTEMPTS_KEY]: [] });
    const attempts = data[ATTEMPTS_KEY];
    const next = attempts.filter((row) => !(row.candidateKey === message.candidateKey &&
      row.runId === message.runId && row.status === "clicked_unknown"));
    if (next.length !== attempts.length) await chrome.storage.local.set({ [ATTEMPTS_KEY]: next });
  }

  async function trustedClick(tabId, x, y, validate, assertActive) {
    await attachDebugger(tabId);
    try {
      const metrics = await sendCommand(tabId, "Page.getLayoutMetrics", {});
      const viewport = metrics && (metrics.cssVisualViewport || metrics.cssLayoutViewport || metrics.visualViewport || metrics.layoutViewport);
      const width = Number(viewport && viewport.clientWidth) || 0;
      const height = Number(viewport && viewport.clientHeight) || 0;
      if (width && height && (x < 0 || y < 0 || x > width || y > height)) {
        throw new Error("click coordinates outside viewport");
      }
      await validate();
      await sendCommand(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        button: "none"
      });
      await validate();
      // No await between the cancellation check and dispatching the press.
      assertActive();
      try {
        await sendCommand(tabId, "Input.dispatchMouseEvent", {
          type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1
        });
      } finally {
        await sendCommand(tabId, "Input.dispatchMouseEvent", {
          type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1
        });
      }
    } finally {
      detachDebugger(tabId);
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return false;
    if (message.type === "BGA_RELEASE_RUN" && sender.tab && isBossUrl(sender.tab.url) && isBossUrl(sender.url)) {
      // Cancel synchronously; storage and other in-flight validations may still be awaiting callbacks.
      cancelledRuns.add(runToken(message, sender));
    }

    const execute = async () => {
      const tabId = message.tabId || (sender.tab && sender.tab.id);
      if (!tabId) throw new Error("missing tab id");

      if (message.type === "BGA_ROUTE_TO_CANDIDATE") {
        const response = await routeToCandidateFrame(tabId, message.payload || {});
        sendResponse({ ok: true, response });
        return;
      }

      if (/^BGA_(?:CLAIM_RUN|VALIDATE_RUN|RELEASE_RUN|PREPARE_ATTEMPT|FINISH_ATTEMPT|TRUSTED_CLICK)$/.test(message.type)) {
        const control = await controlRun(message, sender);
        if (control) { sendResponse(control); return; }
      }

      if (message.type !== "BGA_TRUSTED_CLICK") {
        sendResponse({ ok: false, error: "unknown background message type" });
        return;
      }

      // 只要鼠标还没真正按下，失败就不该把这个候选人记成“已发送过”，
      // 否则坐标换算或校验阶段的临时错误会永久封掉这个人。
      let dispatched = false;
      try {
        const tab = await getTab(tabId);
        if (!isBossUrl(tab && tab.url) || !isBossUrl(sender.url)) {
          throw new Error("trusted click only allowed on zhipin.com");
        }

        const rect = message.rect || {};
        if (!(rect.width > 0 && rect.height > 0)) throw new Error("无效按钮区域");
        if (!tab.active) throw new Error("BOSS 标签页已不在前台，已停止点击");
        const target = await sendToFrame(tabId, sender.frameId || 0, {
          type: "BGA_VALIDATE_TARGET", runId: message.runId, candidateKey: message.candidateKey, rect
        });
        if (!target || !target.ok) throw new Error(target && target.error || "无法确认按钮身份");
        const frameOffset = await getFrameOffset(tabId, sender.frameId || 0, message.frameUrl || sender.url || "");
        const x = Math.round(frameOffset.left + Number(rect.left) + Number(rect.width) / 2);
        const y = Math.round(frameOffset.top + Number(rect.top) + Number(rect.height) / 2);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("invalid click coordinates");

        await trustedClick(tabId, x, y, async () => {
          await controlRun({ type: "BGA_VALIDATE_RUN", runId: message.runId }, sender);
          const currentTab = await getTab(tabId);
          if (!currentTab.active) throw new Error("BOSS 标签页已不在前台");
          const latest = await sendToFrame(tabId, sender.frameId || 0, {
            type: "BGA_VALIDATE_TARGET", runId: message.runId, candidateKey: message.candidateKey, rect
          });
          if (!latest || !latest.ok) throw new Error("调试连接后按钮位置或状态变化，已取消点击");
          const latestOffset = await getFrameOffset(tabId, sender.frameId || 0, message.frameUrl || sender.url);
          if (Math.abs(latestOffset.left - frameOffset.left) > 2 || Math.abs(latestOffset.top - frameOffset.top) > 2) {
            throw new Error("候选列表的框架位置已变化，已取消点击");
          }
        }, () => {
          dispatched = true;
          assertNotCancelled(message, sender);
        });
        sendResponse({ ok: true, x, y, method: "chrome.debugger" });
      } catch (error) {
        if (!dispatched) await discardUnsentAttempt(message).catch(() => {});
        throw error;
      }
    };
    const mutates = /^BGA_(?:CLAIM_RUN|PREPARE_ATTEMPT|FINISH_ATTEMPT|TRUSTED_CLICK)$/.test(message.type);
    const execution = mutates ? (mutationQueue = mutationQueue.catch(() => {}).then(execute)) : execute();
    execution.catch((error) => {
      sendResponse({ ok: false, error: error.message,
        ...(error.connectionDiagnostics ? { connectionDiagnostics: error.connectionDiagnostics } : {}) });
    });

    return true;
  });

  async function clearOwner(tabId) {
    const current = await owner();
    if (current && current.tabId === tabId) await invalidateOwner(current);
    detachDebugger(tabId);
  }
  chrome.tabs.onRemoved.addListener((tabId) => { clearOwner(tabId); });
  chrome.webNavigation.onCommitted.addListener((details) => {
    owner().then((current) => {
      if (current && current.tabId === details.tabId && (details.frameId === 0 || details.frameId === current.frameId)) {
        clearOwner(details.tabId);
        chrome.storage.local.get("bossGreetingState").then((data) => {
          if (data.bossGreetingState && data.bossGreetingState.runId === current.runId) {
            chrome.storage.local.set({ bossGreetingState: { ...data.bossGreetingState, running: false,
              status: "page_changed", phase: "stopped", lastMessage: "页面已跳转，本次任务已停止" } });
          }
        });
      }
    });
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source && source.tabId) attachedTabs.delete(source.tabId);
  });
})();
