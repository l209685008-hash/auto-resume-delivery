(function () {
  "use strict";

  const DEBUGGER_VERSION = "1.3";
  const attachedTabs = new Set();

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

  async function findCandidateFrame(tabId) {
    const frames = await getFrames(tabId);
    const preferred = frames.find((frame) => /\/web\/frame\/recommend/.test(frame.url || ""));
    if (preferred) return preferred.frameId;

    for (const frame of frames) {
      try {
        const response = await sendToFrame(tabId, frame.frameId, { type: "BGA_STATE" });
        if (response && response.ok && response.state && response.state.frameReady) {
          return frame.frameId;
        }
      } catch (_error) {
        // Some frames are not extension-scriptable; keep scanning.
      }
    }

    throw new Error("candidate frame not ready");
  }

  async function routeToCandidateFrame(tabId, message) {
    const frameId = await findCandidateFrame(tabId);
    let routedMessage = message;
    if (message && message.type === "BGA_START") {
      try {
        const pageContext = await sendToTopFrame(tabId, { type: "BGA_PAGE_CONTEXT" });
        routedMessage = {
          ...message,
          config: {
            ...(message.config || {}),
            jobText: pageContext && pageContext.context ? pageContext.context.currentJobText : ""
          }
        };
      } catch (_error) {
        routedMessage = message;
      }
    }
    const response = await sendToFrame(tabId, frameId, routedMessage);
    return { ...(response || {}), frameId };
  }

  async function getFrameOffset(tabId, frameId, frameUrl) {
    if (!frameId) return { left: 0, top: 0 };
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

  async function trustedClick(tabId, x, y) {
    await attachDebugger(tabId);
    try {
      const metrics = await sendCommand(tabId, "Page.getLayoutMetrics", {});
      const viewport = metrics && (metrics.visualViewport || metrics.layoutViewport);
      const width = Number(viewport && viewport.clientWidth) || 0;
      const height = Number(viewport && viewport.clientHeight) || 0;
      if (width && height && (x < 0 || y < 0 || x > width || y > height)) {
        throw new Error("click coordinates outside viewport");
      }
      await sendCommand(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        button: "none"
      });
      await sendCommand(tabId, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        buttons: 1,
        clickCount: 1
      });
      await sendCommand(tabId, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        buttons: 0,
        clickCount: 1
      });
    } finally {
      detachDebugger(tabId);
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return false;

    (async () => {
      const tabId = message.tabId || (sender.tab && sender.tab.id);
      if (!tabId) throw new Error("missing tab id");

      if (message.type === "BGA_ROUTE_TO_CANDIDATE") {
        const response = await routeToCandidateFrame(tabId, message.payload || {});
        sendResponse({ ok: true, response });
        return;
      }

      if (message.type !== "BGA_TRUSTED_CLICK") {
        sendResponse({ ok: false, error: "unknown background message type" });
        return;
      }

      const tab = sender.tab || (await getTab(tabId));
      if (!/https:\/\/[^/]*zhipin\.com\//.test((tab && tab.url) || "") || !/https:\/\/[^/]*zhipin\.com\//.test(sender.url || message.frameUrl || "")) {
        throw new Error("trusted click only allowed on zhipin.com");
      }

      const rect = message.rect || {};
      const frameOffset = await getFrameOffset(tabId, sender.frameId || 0, message.frameUrl || sender.url || "");
      const x = Math.round(frameOffset.left + Number(rect.left) + Number(rect.width) / 2);
      const y = Math.round(frameOffset.top + Number(rect.top) + Number(rect.height) / 2);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("invalid click coordinates");

      await trustedClick(tabId, x, y);
      sendResponse({ ok: true, x, y, method: "chrome.debugger" });
    })().catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });

    return true;
  });

  chrome.tabs.onRemoved.addListener((tabId) => detachDebugger(tabId));
  chrome.debugger.onDetach.addListener((source) => {
    if (source && source.tabId) attachedTabs.delete(source.tabId);
  });
})();
