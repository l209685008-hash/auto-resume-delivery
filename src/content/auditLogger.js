(function () {
  "use strict";

  const STORAGE_KEY = "bossGreetingAuditLog";
  // 每条记录都含证据原文，整表在每次事件都要重写一遍，因此条数和单条长度都设上限。
  const MAX_RECORDS = 1500;
  const MAX_TEXT = 300;
  const MAX_ITEMS = 24;
  let writes = Promise.resolve();

  function uuid() {
    if (crypto && crypto.randomUUID) return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  // 只保留可审计的要点，长文本截断，避免单条记录随简历膨胀。
  function compact(value, depth = 0) {
    if (typeof value === "string") return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) + "…" : value;
    if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((item) => compact(item, depth + 1));
    if (value && typeof value === "object") {
      if (depth >= 4) return "[深层对象]";
      const result = {};
      for (const [key, item] of Object.entries(value)) result[key] = compact(item, depth + 1);
      return result;
    }
    return value;
  }

  function pagePath() {
    // 去掉查询串与 hash：路径足以定位页面，且不会把候选人标识写进日志。
    return location.origin + location.pathname;
  }

  function readAuditLog() {
    return chrome.storage.local.get({ [STORAGE_KEY]: [] }).then((data) =>
      Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : []);
  }

  function writeAuditLog(records) {
    return chrome.storage.local.set({ [STORAGE_KEY]: records.slice(-MAX_RECORDS) });
  }

  function audit(runId, type, payload) {
    const record = {
      id: uuid(),
      runId,
      timestamp: new Date().toISOString(),
      type,
      pageUrl: pagePath(),
      payload: compact(payload || {})
    };
    writes = writes.catch(() => {}).then(async () => {
      const records = await readAuditLog();
      records.push(record);
      await writeAuditLog(records);
      return record;
    });
    return writes;
  }

  async function clearAuditLog() {
    await writeAuditLog([]);
  }

  window.BossGreetingAudit = {
    MAX_RECORDS,
    MAX_TEXT,
    STORAGE_KEY,
    audit,
    clearAuditLog,
    compact,
    readAuditLog,
    uuid
  };
})();
