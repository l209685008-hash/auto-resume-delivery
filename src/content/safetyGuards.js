(function () {
  "use strict";

  const MAX_LIMIT = 60;
  const DEFAULT_MIN_DELAY_MS = 500;
  const DEFAULT_MAX_DELAY_MS = 900;
  const MAX_RUNTIME_MS = 30 * 60 * 1000;
  const MAX_EMPTY_LOADS = 8;

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
  }

  function normalizeConfig(config) {
    const normalized = config || {};
    const minDelayMs = clampNumber(normalized.minDelayMs, 500, 60000, DEFAULT_MIN_DELAY_MS);
    const maxDelayMs = clampNumber(normalized.maxDelayMs, minDelayMs, 90000, DEFAULT_MAX_DELAY_MS);
    return {
      dryRun: normalized.dryRun === true,
      maxGreetings: clampNumber(normalized.maxGreetings, 1, MAX_LIMIT, MAX_LIMIT),
      minExperienceMonths: 0,
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
    const text = window.BossGreetingSelectors.getPageText();
    const hardBlock = ["验证码", "安全验证", "账号异常", "访问过于频繁", "请完成验证"].find((word) =>
      text.includes(word)
    );
    if (hardBlock) return hardBlock;

    const hasCandidateSurface =
      window.BossGreetingSelectors.getCandidateCards().length > 0 ||
      (text.includes("推荐牛人") && text.includes("打招呼"));
    if (hasCandidateSurface) return "";

    return ["扫码登录", "请登录", "立即登录", "登录后", "手机号码登录", "密码登录", "登录BOSS直聘"].find((word) =>
      text.includes(word)
    ) || "";
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
