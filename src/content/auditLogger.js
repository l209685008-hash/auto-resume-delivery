(function () {
  "use strict";

  const STORAGE_KEY = "bossGreetingAuditLog";
  const MAX_RECORDS = 3000;

  function uuid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function readAuditLog() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ [STORAGE_KEY]: [] }, (data) => {
        resolve(Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : []);
      });
    });
  }

  function writeAuditLog(records) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: records.slice(-MAX_RECORDS) }, resolve);
    });
  }

  async function audit(runId, type, payload) {
    const record = {
      id: uuid(),
      runId,
      timestamp: new Date().toISOString(),
      type,
      pageUrl: location.href,
      payload: payload || {}
    };
    const records = await readAuditLog();
    records.push(record);
    await writeAuditLog(records);
    return record;
  }

  async function clearAuditLog() {
    await writeAuditLog([]);
  }

  window.BossGreetingAudit = {
    STORAGE_KEY,
    audit,
    clearAuditLog,
    readAuditLog,
    uuid
  };
})();
