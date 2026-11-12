(function () {
  "use strict";

  const TEXT = {
    greet: ["打招呼", "立即沟通"],
    // 真实页面点完后按钮文案会变（继续沟通/已联系/沟通过），类名也会变，只能按文本判断。
    greeted: ["继续沟通", "已打招呼", "沟通中", "继续聊", "已联系", "沟通过", "已沟通"],
    stopBlocks: ["验证码", "安全验证", "登录", "扫码登录", "账号异常", "访问过于频繁", "请完成验证"]
  };

  // 前四个来自招聘端实测结构（li.card-item / .candidate-card-wrap / .card-inner），
  // 其余为兼容旧版与模糊匹配。
  const CANDIDATE_CARD_SELECTORS = [
    "li.card-item",
    ".candidate-card-wrap",
    ".card-inner",
    ".recommend-card-wrap",
    ".candidate-card",
    ".card-list .card-item",
    ".geek-card",
    "[class*='recommend'] [class*='card']",
    "[class*='candidate'] [class*='card']"
  ];

  const CANDIDATE_ROOT_SELECTOR = "[data-candidate-id], [data-geek-id], [data-geekid], [data-geek], .candidate-card, .candidate-card-wrap, .geek-card, .recommend-card-wrap, li.card-item, .card-list .card-item, .card-inner";

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
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (Number(window.getComputedStyle(ancestor).opacity) === 0) return false;
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

  function createDiscovery() {
    // These caches live only for one synchronous public call; DOM changes need no invalidation.
    return { texts: new WeakMap(), visibility: new WeakMap(), buttons: new WeakMap(), controls: new WeakMap() };
  }

  function discoveryText(element, discovery) {
    if (!element) return "";
    if (!discovery.texts.has(element)) discovery.texts.set(element, normalizeText(element.textContent));
    return discovery.texts.get(element);
  }

  function discoveryVisible(element, discovery) {
    if (!discovery.visibility.has(element)) discovery.visibility.set(element, visible(element));
    return discovery.visibility.get(element);
  }

  function buttonElements(element, discovery) {
    if (!discovery.buttons.has(element)) {
      discovery.buttons.set(element, Array.from(element.querySelectorAll(GREET_BUTTON_SELECTORS.join(","))));
    }
    return discovery.buttons.get(element);
  }

  function candidateElements(discovery) {
    if (!discovery.cards) {
      discovery.cards = Array.from(new Set(CANDIDATE_CARD_SELECTORS.flatMap((selector) =>
        Array.from(document.querySelectorAll(selector))
      )));
    }
    return discovery.cards;
  }

  function spansMultipleCandidates(element, discovery) {
    if (!discovery.candidateGroups) {
      const roots = new Set(document.querySelectorAll(CANDIDATE_ROOT_SELECTOR));
      const withNestedRoot = new Set();
      for (const root of roots) {
        for (let ancestor = root.parentElement; ancestor; ancestor = ancestor.parentElement) {
          if (roots.has(ancestor)) withNestedRoot.add(ancestor);
        }
      }
      const groups = new WeakMap();
      for (const root of roots) {
        // Nested markers on one ancestry chain represent one candidate, regardless of action state.
        if (withNestedRoot.has(root)) continue;
        for (let node = root; node; node = node.parentElement) {
          const count = groups.get(node) || 0;
          if (count === 2) break;
          groups.set(node, count + 1);
        }
      }
      discovery.candidateGroups = groups;
    }
    return discovery.candidateGroups.get(element) === 2;
  }

  function uniqueElements(elements, discovery) {
    return Array.from(new Set(elements)).filter((element) => discoveryVisible(element, discovery));
  }

  function greetingControls(element, discovery, matchesText = isGreetText) {
    let cached = discovery.controls.get(element);
    if (!cached) {
      cached = new Map();
      discovery.controls.set(element, cached);
    }
    if (cached.has(matchesText)) return cached.get(matchesText);
    const matches = buttonElements(element, discovery)
      .filter((button) => matchesText(discoveryText(button, discovery)) && discoveryVisible(button, discovery));
    const matchSet = new Set(matches);
    const semantic = new Set(matches.filter((button) => button.matches("button,a,[role='button']")));
    const withDescendant = new Set();
    const withSemanticDescendant = new Set();
    const withSemanticAncestor = new Set();
    for (const button of matches) {
      for (let ancestor = button.parentElement; ancestor && ancestor !== element; ancestor = ancestor.parentElement) {
        if (!matchSet.has(ancestor)) continue;
        withDescendant.add(ancestor);
        if (semantic.has(button)) withSemanticDescendant.add(ancestor);
        if (semantic.has(ancestor)) withSemanticAncestor.add(button);
      }
    }
    const controls = matches.filter((button) => {
      // Keep disabled matches in the deduplication set so their wrappers cannot become actions.
      if (matchesText === isGreetText && (button.disabled || button.closest("[disabled], [aria-disabled='true']"))) return false;
      if (!semantic.has(button) && withSemanticAncestor.has(button)) return false;
      return !withSemanticDescendant.has(button) && (semantic.has(button) || !withDescendant.has(button));
    });
    cached.set(matchesText, controls);
    return controls;
  }

  function greetButtonCount(element, discovery) {
    return greetingControls(element, discovery).length;
  }

  function looksLikeCandidateCard(element, discovery) {
    const text = discoveryText(element, discovery);
    return (
      text.length > 30 &&
      !spansMultipleCandidates(element, discovery) &&
      greetButtonCount(element, discovery) === 1 &&
      /(离职|在职|期望|优势|最近关注|学历|大专|专科|高职|本科|学士|研究生|高中|中专|中职|职高|初中|硕士|博士|打招呼)/.test(text)
    );
  }

  function expandCandidateCard(element, discovery) {
    let best = element;
    let bestLength = discoveryText(best, discovery).length;
    let current = element ? element.parentElement : null;

    for (let depth = 0; current && current !== document.body && depth < 7; depth += 1) {
      const text = discoveryText(current, discovery);
      if (
        looksLikeCandidateCard(current, discovery) &&
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
    return TEXT.greet.includes(normalized);
  }

  function isGreetedText(text) {
    const normalized = normalizeText(text);
    // 真实按钮可能带后缀（“沟通过 3 次”），包含即算已沟通，宁可漏发也不重复打扰。
    return Boolean(normalized) && TEXT.greeted.some((word) => normalized.includes(word));
  }

  function getCandidateCards() {
    return discoverCandidateCards(createDiscovery());
  }

  function discoverCandidateCards(discovery) {
    const bySelector = candidateElements(discovery);
    const byButton = buttonElements(document, discovery)
      .filter((element) => isGreetText(discoveryText(element, discovery)))
      .map((button) => {
        let current = button;
        for (let depth = 0; current && depth < 7; depth += 1) {
          if (looksLikeCandidateCard(current, discovery)) {
            return current;
          }
          current = current.parentElement;
        }
        return null;
      })
      .filter(Boolean);

    const seeds = Array.from(new Set([...bySelector, ...byButton]));
    const cards = uniqueElements(seeds.map((element) => expandCandidateCard(element, discovery)), discovery)
      .filter((element) => looksLikeCandidateCard(element, discovery));
    const cardSet = new Set(cards);
    return cards.filter((card) => {
      for (let ancestor = card.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (cardSet.has(ancestor)) return false;
      }
      return true;
    });
  }

  function findGreetButton(card) {
    if (!card) return undefined;
    return greetingControls(card, createDiscovery()).find((element) => {
      return !element.disabled && !element.closest("[disabled], [aria-disabled='true']");
    });
  }

  // 点击后按钮节点常被框架重建，确认时按卡片重新找“已沟通”控件，而不是死盯原节点。
  function findGreetedControl(card) {
    if (!card) return null;
    return greetingControls(card, createDiscovery(), isGreetedText)[0] || null;
  }

  // 有的页面点完“打招呼”会把文案换成“立即沟通”，而“立即沟通”同时也是初始文案之一。
  // 只有原本确实是“打招呼”时，才把“立即沟通”当作已发送的证据。
  function findConvertedControl(card, originalText) {
    if (!card || normalizeText(originalText) !== "打招呼") return null;
    return greetingControls(card, createDiscovery())
      .find((element) => normalizeText(element.textContent) === "立即沟通") || null;
  }

  function getPageDiagnostics() {
    const discovery = createDiscovery();
    const controls = greetingControls(document, discovery);
    const samples = controls.slice(0, 3).map((element) => {
      const ancestors = [];
      for (let node = element, depth = 0; node && node !== document.body && depth < 6; node = node.parentElement, depth += 1) {
        ancestors.push({ tag: node.tagName.toLowerCase(), classes: Array.from(node.classList).slice(0, 8) });
      }
      return { action: normalizeText(element.textContent), ancestors };
    });
    return {
      version: 1, pageUrl: location.origin + location.pathname,
      candidateCount: discoverCandidateCards(discovery).length, greetControlCount: controls.length,
      greetedControlCount: greetingControls(document, discovery, isGreetedText).length,
      rawCardElementCount: uniqueElements(candidateElements(discovery), discovery).length,
      actionSamples: samples
    };
  }

  function getPageText() {
    return normalizeText(document.body ? document.body.innerText : "");
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

  function candidateAliases(card) {
    // 真实结构里 data-geekid 挂在内层 .card-inner，外层 li.card-item 没有属性，
    // 只看卡片自身会退化成哈希去重，所以再补一层最近的子标记。
    const marker = card.querySelector("[data-geekid], [data-geek], [data-geek-id], [data-candidate-id]");
    const nodes = marker ? [card, marker] : [card];
    const values = nodes.flatMap((node) => [
      node.getAttribute("data-geek-id"), node.getAttribute("data-candidate-id"),
      node.getAttribute("data-geekid"), node.getAttribute("data-geek")
    ]);
    return window.BossCandidateIdentity.aliases([...values, findProfileUrl(card)]);
  }

  function candidateIdentity(card) {
    return candidateAliases(card)[0] || "";
  }

  function getCurrentJobContext() {
    const roots = "[class*='job-select'], .job-name-select";
    const selected = "input, select, [role='combobox'], .ui-select-selection, .ui-select-selected-value, .selected-value, .select-value";
    const targets = Array.from(document.querySelectorAll(
      "[data-current-job], [class*='job-select'] [class*='label'], [class*='job-select'] [class*='text'], .job-select .selected, .job-select .label, .job-name-select, [class*='job-selector'] [class*='selected'], " +
      selected.split(", ").map((selector) => roots.split(", ").map((root) => `${root} ${selector}`).join(", ")).join(", ")
    )).filter((element) => visible(element) && !element.isContentEditable && !element.closest(
      "[role='listbox'], [role='option'], option, .ui-dropmenu-list, .ui-select-dropdown, .dropdown-menu"
    ));
    const titles = Array.from(new Set(targets.map((element) => {
      if (element.matches("input")) return element.readOnly ? normalizeText(element.value) : "";
      if (element.matches("select")) return element.selectedOptions.length === 1 ? normalizeText(element.selectedOptions[0].textContent) : "";
      // Read selected labels/fields rather than an open menu's unselected options.
      if (element.querySelector("input, select, [role='listbox'], [role='option'], .ui-dropmenu-list, .ui-select-dropdown")) return "";
      return normalizeText(element.innerText || element.textContent);
    }).filter((value) => value && value.length < 100)));
    return { currentJobText: titles.length === 1 ? titles[0] : "",
      jobStatus: titles.length === 1 ? "selected" : titles.length ? "ambiguous" : "missing" };
  }

  function getCurrentJobText() {
    return getCurrentJobContext().currentJobText;
  }

  window.BossGreetingSelectors = {
    TEXT,
    getCandidateCards,
    findGreetButton,
    findGreetedControl,
    findConvertedControl,
    findProfileUrl,
    candidateIdentity,
    candidateAliases,
    getCurrentJobContext,
    getCurrentJobText,
    getPageDiagnostics,
    getPageText,
    inViewport,
    isGreetedText,
    isGreetText,
    topClickable,
    normalizeText,
    visible
  };
})();
