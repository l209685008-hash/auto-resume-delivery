(function (root) {
  "use strict";

  const fields = ["encryptGeekId", "geekId", "geekIdStr", "resumeId", "encryptResumeId"];

  function token(value) {
    return /^[A-Za-z0-9_.~=-]{1,512}$/.test(value) ? `id:${value}` : "";
  }

  function normalize(value) {
    const text = String(value || "").trim();
    if (/^https?:\/\//i.test(text)) {
      try {
        const url = new URL(text);
        if (url.protocol !== "https:" || !/(^|\.)zhipin\.com$/.test(url.hostname)) return [];
        const keys = fields.map((field) => token(url.searchParams.get(field) || "")).filter(Boolean);
        const match = url.pathname.match(/^\/(?:web\/)?(?:geek|candidate|resume)\/(?:detail\/)?([^/]+?)(?:\.html)?\/?$/);
        if (match && !/^(?:index|detail|resume|chat|list)$/.test(match[1])) keys.push(token(decodeURIComponent(match[1])));
        return keys.filter(Boolean);
      } catch (_) { return []; }
    }
    const prefix = text.match(/^([^:]+):(.*)$/);
    if (prefix && !["id", "profile", ...fields].includes(prefix[1])) return [];
    const key = token(prefix ? prefix[2] : text);
    return key ? [key] : [];
  }

  function aliases(values) {
    return Array.from(new Set((Array.isArray(values) ? values : [values]).flatMap(normalize)));
  }

  const api = { aliases };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BossCandidateIdentity = api;
})(globalThis);
