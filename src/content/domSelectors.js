(function () {
  "use strict";

  const TEXT = {
    greet: ["打招呼", "立即沟通"],
    greeted: ["继续沟通", "已打招呼", "沟通中", "继续聊"],
    stopBlocks: ["验证码", "安全验证", "登录", "扫码登录", "账号异常", "访问过于频繁", "请完成验证"]
  };

  const CANDIDATE_CARD_SELECTORS = [
    ".recommend-card-wrap",
    ".candidate-card",
    ".card-list .card-item",
    ".geek-card",
    "[class*='recommend'] [class*='card']",
    "[class*='candidate'] [class*='card']"
  ];

  const GREET_BUTTON_SELECTORS = [
    "button",
    ".btn",
    "[class*='btn']",
    "[role='button']",
    "a"
  ];

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function visible(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
    const style = window.getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function inViewport(element) {
    if (!visible(element)) return false;
    const rect = element.getBoundingClientRect();
    return (
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < (window.innerHeight || document.documentElement.clientHeight) &&
      rect.left < (window.innerWidth || document.documentElement.clientWidth)
    );
  }

  function topClickable(element) {
    if (!inViewport(element)) return false;
    const rect = element.getBoundingClientRect();
    const points = [
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.left + Math.min(rect.width - 1, 8), rect.top + rect.height / 2],
      [rect.right - Math.min(rect.width - 1, 8), rect.top + rect.height / 2]
    ];
    return points.some(([x, y]) => {
      const target = document.elementFromPoint(x, y);
      return target === element || Boolean(target && element.contains(target));
    });
  }

  function uniqueElements(elements) {
    return Array.from(new Set(elements)).filter(visible);
  }

  function greetButtonCount(element) {
    return Array.from(element.querySelectorAll(GREET_BUTTON_SELECTORS.join(","))).filter((button) =>
      isGreetText(button.textContent)
    ).length;
  }

  function looksLikeCandidateCard(element) {
    const text = normalizeText(element && element.textContent);
    return (
      text.length > 30 &&
      isGreetText(text) &&
      /(\d+\s*年|\d+\s*个?月|应届|应届生|经验不限|1年以内|一年以内|在校)/.test(text) &&
      /(离职|在职|期望|优势|最近关注|学历|大专|本科|高中|中专|初中|硕士|博士|打招呼)/.test(text)
    );
  }

  function expandCandidateCard(element) {
    let best = element;
    let bestLength = normalizeText(best && best.textContent).length;
    let current = element ? element.parentElement : null;

    for (let depth = 0; current && current !== document.body && depth < 7; depth += 1) {
      const text = normalizeText(current.textContent);
      const buttonCount = greetButtonCount(current);
      if (
        looksLikeCandidateCard(current) &&
        buttonCount === 1 &&
        text.length > bestLength &&
        text.length < 4200
      ) {
        best = current;
        bestLength = text.length;
      }
      current = current.parentElement;
    }

    return best;
  }

  function isGreetText(text) {
    const normalized = normalizeText(text);
    if (!normalized || TEXT.greeted.some((word) => normalized.includes(word))) return false;
    return TEXT.greet.some((word) => normalized === word || normalized.includes(word));
  }

  function isGreetedText(text) {
    const normalized = normalizeText(text);
    return TEXT.greeted.some((word) => normalized.includes(word));
  }

  function getCandidateCards() {
    const bySelector = CANDIDATE_CARD_SELECTORS.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector))
    );

    const byButton = Array.from(document.querySelectorAll(GREET_BUTTON_SELECTORS.join(",")))
      .filter((element) => isGreetText(element.textContent))
      .map((button) => {
        let current = button;
        for (let depth = 0; current && depth < 7; depth += 1) {
          const text = normalizeText(current.textContent);
          if (looksLikeCandidateCard(current)) {
            return current;
          }
          current = current.parentElement;
        }
        return null;
      })
      .filter(Boolean);

    return uniqueElements([...bySelector, ...byButton].map(expandCandidateCard)).filter(looksLikeCandidateCard);
  }

  function findGreetButton(card) {
    return Array.from(card.querySelectorAll(GREET_BUTTON_SELECTORS.join(","))).find((element) => {
      const text = normalizeText(element.textContent);
      const disabled = element.disabled || element.getAttribute("aria-disabled") === "true";
      return visible(element) && !disabled && isGreetText(text);
    });
  }

  function getPageText() {
    return normalizeText(document.body ? document.body.textContent : "");
  }

  function findProfileUrl(card) {
    const link = Array.from(card.querySelectorAll("a[href]")).find((anchor) => {
      const href = anchor.getAttribute("href") || "";
      return /geek|candidate|resume|chat/.test(href);
    });
    if (!link) return "";
    try {
      return new URL(link.getAttribute("href"), location.href).href;
    } catch (_error) {
      return link.getAttribute("href") || "";
    }
  }

  function getCurrentJobText() {
    const frameText = getPageText();
    const directMatch = frameText.match(/(运营助理|(?:电商)?打包员?|财务总监|财务主管|财务经理|财务分析|电商运营|运营专员)[^筛选推荐精选最新]{0,40}/);
    return directMatch ? directMatch[0] : frameText.slice(0, 260);
  }

  window.BossGreetingSelectors = {
    TEXT,
    getCandidateCards,
    findGreetButton,
    findProfileUrl,
    getCurrentJobText,
    getPageText,
    inViewport,
    isGreetedText,
    isGreetText,
    topClickable,
    normalizeText,
    visible
  };
})();
