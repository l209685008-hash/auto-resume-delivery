(function () {
  "use strict";

  const MAX_LIMIT = 60;
  const MAX_CANDIDATES = 100;
  // 招聘端两个活跃项目分别用 2–5 秒与 25–70 秒；0.5–0.9 秒明显偏快，默认值对齐 2–5 秒。
  const DEFAULT_MIN_DELAY_MS = 2000;
  const DEFAULT_MAX_DELAY_MS = 5000;
  const MAX_RUNTIME_MS = 30 * 60 * 1000;
  const MAX_EMPTY_LOADS = 8;

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
  }

  function normalizeConfig(config) {
    const normalized = config || {};
    const maxCandidates = normalized.maxCandidates == null || normalized.maxCandidates === "" ? MAX_CANDIDATES : normalized.maxCandidates;
    const minDelayMs = clampNumber(normalized.minDelayMs, 500, 60000, DEFAULT_MIN_DELAY_MS);
    const maxDelayMs = clampNumber(normalized.maxDelayMs, minDelayMs, 90000, DEFAULT_MAX_DELAY_MS);
    return {
      profileId: "cross_border_finance",
      dryRun: normalized.dryRun !== false,
      maxCandidates: Math.floor(clampNumber(maxCandidates, 1, MAX_CANDIDATES, MAX_CANDIDATES)),
      maxGreetings: Math.floor(clampNumber(normalized.maxGreetings, 1, MAX_LIMIT, 30)),
      minDelayMs,
      maxDelayMs,
      requirePerCandidateConfirm: normalized.requirePerCandidateConfirm === true,
      maxRuntimeMs: clampNumber(normalized.maxRuntimeMs, 60000, MAX_RUNTIME_MS, MAX_RUNTIME_MS)
    };
  }

  function randomDelay(min, max) {
    return Math.floor(min + Math.random() * (max - min + 1));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function detectHumanRequiredBlocker() {
    const selectors = window.BossGreetingSelectors;
    const surfaces = Array.from(document.querySelectorAll(
      "[role='dialog'], [role='alert'], .toast, .notice, [class*='verify'], [class*='captcha'], [class*='security'], [class*='risk'], [class*='login']"
    )).filter(selectors.visible);
    const text = surfaces.map((element) => element.innerText || "").join(" ");
    const words = ["验证码", "安全验证", "账号异常", "访问过于频繁", "操作过于频繁", "操作频繁", "请完成验证", "今日打招呼次数已用完", "打招呼已达上限", "扫码登录", "请登录", "立即登录", "手机号码登录", "密码登录"];
    const explicit = words.find((word) => text.includes(word));
    if (explicit) return explicit;
    if (selectors.getCandidateCards().length) return "";
    return words.find((word) => selectors.getPageText().includes(word)) || "";
  }

  function isElementDisabled(element) {
    return (
      !element ||
      element.disabled ||
      element.getAttribute("aria-disabled") === "true" ||
      /\bdisabled\b/.test(element.className || "")
    );
  }

  window.BossGreetingSafety = {
    MAX_EMPTY_LOADS,
    MAX_LIMIT,
    MAX_RUNTIME_MS,
    detectHumanRequiredBlocker,
    isElementDisabled,
    normalizeConfig,
    randomDelay,
    sleep
  };
})();
