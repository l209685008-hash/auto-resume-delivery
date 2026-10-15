(function () {
  "use strict";

  const STATE_KEY = "bossGreetingState";
  const WAIT_FOR_CARDS_ATTEMPTS = 8;
  const SETTLE_AFTER_CLICK_MS = 180;
  const GREET_RESULT_ATTEMPTS = 4;
  const JOB_PATTERN_VERSION = "2026-07-03.4";
  const OPERATIONS_TITLE_PATTERN =
    /(?:运营\s*助理|运营\s*专员|运营\s*实习生?|运营助理\/专员|电商\s*(?:运营|助理|专员)|跨境\s*电商\s*运营|国内\s*电商\s*运营|(?:网店|店铺|平台|商品|产品|内容|用户|社群|私域|新媒体|直播|短视频|视频|中控|商家|数据)\s*运营|联合创始(?:人|运营)?|数据标注|AI\s*训练师|采购\s*(?:专员|助理|管理))/
  const OPERATIONS_PLATFORM_PATTERN =
    /(?:(?:淘宝|天猫|京东|拼多多|抖音|抖店|快手|小红书|视频号|公众号|微信|1688|阿里巴巴|阿里国际站|诚信通|跨境|电商).{0,10}运营|运营.{0,10}(?:淘宝|天猫|京东|拼多多|抖音|抖店|快手|小红书|视频号|公众号|微信|1688|阿里巴巴|阿里国际站|诚信通|跨境|电商))/;
  const OPERATIONS_TASK_PATTERN =
    /(?:(?:电商|网店|店铺|平台|淘宝|天猫|京东|拼多多|抖音|抖店|快手|小红书|1688|阿里巴巴|新媒体|内容|直播|短视频).{0,26}(?:商品上架|商品发布|上架|发布|维护|客服|售前|售后|订单|活动|推广|投放|后台|数据|直播|短视频|账号|粉丝|店铺后台|聚水潭|马帮ERP|erp系统|素材|文案|剪辑|数据标注|AI训练)|(?:商品上架|商品发布|上架|发布|维护|客服|售前|售后|订单|活动|推广|投放|后台|数据|直播|短视频|账号|粉丝|店铺后台|聚水潭|马帮ERP|erp系统|素材|文案|剪辑|数据标注|AI训练).{0,26}(?:电商|网店|店铺|平台|淘宝|天猫|京东|拼多多|抖音|抖店|快手|小红书|1688|阿里巴巴|新媒体|内容|直播|短视频))/i;
  const JOB_RULES = [
    {
      key: "operations_assistant",
      label: "运营助理相关工作经验",
      jobPattern: /(?:1688)?运营助理|电商运营助理|运营助理\/专员/,
      matcher: matchOperationsAssistantExperience
    },
    {
      key: "packing",
      label: "打包/电商仓储相关行业经验",
      jobPattern: /(?:电商)?打包(?:员)?|包装/,
      candidatePattern: /(?:电商|网店|淘宝|天猫|拼多多|抖音|快手|小红书|1688|仓库|仓储|物流|打包|包装|装箱|贴标|配货|分拣|拣货|理货|发货|仓管|仓库管理员|仓储物流|快递|售前|售后|订单|WMS|erp|ERP)/
    },
    {
      key: "finance_manager",
      label: "财务相关行业经验",
      jobPattern: /财务(?:总监|主管)/,
      candidatePattern: /(?:财务|会计|出纳|总账|成本|税务|审计|应收|应付|报税|开票|发票|记账|对账|结算|预算|资金|往来账|金蝶|用友|管家婆)/
    }
  ];
  let runState = createIdleState();
  let overlay = null;

  function createIdleState() {
    return {
      running: false,
      status: "idle",
      runId: "",
      startedAt: "",
      processedCount: 0,
      eligibleCount: 0,
      greetedCount: 0,
      skippedCount: 0,
      dryRunMatches: 0,
      unconfirmedCount: 0,
      lastFailureReason: "",
      lastMessage: "not-started",
      currentJobText: "",
      currentJobRule: "general_experience",
      frameReady: false,
      seenCandidateKeys: []
    };
  }

  function isCandidateFrame() {
    return window.BossGreetingSelectors.getCandidateCards().length > 0;
  }

  function publicState() {
    return {
      running: runState.running,
      status: runState.status,
      runId: runState.runId,
      startedAt: runState.startedAt,
      processedCount: runState.processedCount,
      eligibleCount: runState.eligibleCount,
      greetedCount: runState.greetedCount,
      skippedCount: runState.skippedCount,
      dryRunMatches: runState.dryRunMatches,
      unconfirmedCount: runState.unconfirmedCount,
      lastFailureReason: runState.lastFailureReason,
      currentJobText: runState.currentJobText,
      currentJobRule: runState.currentJobRule,
      frameReady: isCandidateFrame(),
      lastMessage: runState.lastMessage
    };
  }

  function saveState() {
    chrome.storage.local.set({ [STATE_KEY]: publicState() });
    renderOverlay();
  }

  function setMessage(message, status, failureReason) {
    runState.lastMessage = message;
    if (status) runState.status = status;
    if (failureReason) runState.lastFailureReason = failureReason;
    saveState();
  }

  function recordFailure(reason) {
    runState.lastFailureReason = reason || "";
  }

  function normalizeSearchText(value) {
    return window.BossGreetingSelectors.normalizeText(value)
      .replace(/\s*([·/｜|,，;；、-])\s*/g, "$1")
      .replace(/ＥＲＰ/gi, "ERP");
  }

  function buildJobEvidenceText(text) {
    const normalized = normalizeSearchText(text);
    return normalized
      .replace(/(?:期望|最近关注|求职意向|想找).{0,90}?(?=(?:优势|工作经历|教育经历|20\d{2}|19\d{2}|$))/g, " ");
  }

  function selectJobRule(jobText) {
    const normalized = normalizeSearchText(jobText);
    return JOB_RULES.find((rule) => rule.jobPattern.test(normalized)) || null;
  }

  function describeJobRule(rule) {
    return rule ? `has explicit work experience and ${rule.label}` : "has explicit work experience";
  }

  function evidenceAroundMatch(text, match) {
    const normalized = normalizeSearchText(text);
    if (!match) return "";
    const index = Math.max(0, match.index - 28);
    return normalized.slice(index, index + 96);
  }

  function findMatchedEvidence(text, pattern) {
    return evidenceAroundMatch(text, normalizeSearchText(text).match(pattern));
  }

  function matchPattern(text, pattern, mode) {
    const normalized = normalizeSearchText(text);
    const match = normalized.match(pattern);
    if (!match) return null;
    return {
      ok: true,
      jobMatchMode: mode,
      matchedEvidence: evidenceAroundMatch(normalized, match),
      jobKeywordHits: [match[0]].filter(Boolean),
      nearMissReason: ""
    };
  }

  function matchOperationsAssistantExperience(evidenceText) {
    const titleMatch = matchPattern(evidenceText, OPERATIONS_TITLE_PATTERN, "operations_title_match");
    if (titleMatch) return titleMatch;

    const platformMatch = matchPattern(evidenceText, OPERATIONS_PLATFORM_PATTERN, "operations_platform_match");
    if (platformMatch) return platformMatch;

    const taskMatch = matchPattern(evidenceText, OPERATIONS_TASK_PATTERN, "operations_task_match");
    if (taskMatch) return taskMatch;

    const hasIntentOnly = /(?:期望|最近关注|求职意向|想找).{0,60}(?:运营|电商)/.test(normalizeSearchText(evidenceText));
    return {
      ok: false,
      jobMatchMode: "",
      matchedEvidence: "",
      jobKeywordHits: [],
      nearMissReason: hasIntentOnly ? "has_ops_keyword_but_intent_only" : "no_operations_experience_keyword"
    };
  }

  function matchJobExperience(rule, evidenceText) {
    if (!rule) {
      return {
        ok: true,
        jobMatchMode: "general_experience_only",
        matchedEvidence: "",
        jobKeywordHits: [],
        nearMissReason: ""
      };
    }

    if (rule.matcher) return rule.matcher(evidenceText);

    const match = normalizeSearchText(evidenceText).match(rule.candidatePattern);
    return {
      ok: Boolean(match),
      jobMatchMode: match ? "keyword_match" : "",
      matchedEvidence: evidenceAroundMatch(evidenceText, match),
      jobKeywordHits: match ? [match[0]] : [],
      nearMissReason: match ? "" : `no_${rule.key}_keyword`
    };
  }

  function candidateAuditPayload(candidate) {
    const { searchText, ...payload } = candidate;
    return payload;
  }

  function parseExperienceMonths(text) {
    const normalized = String(text || "").trim();
    if (!normalized) return 0;
    if (/应届|在校|无经验|经验不限/.test(normalized)) return 0;
    if (/1\s*年以内|一年以内/.test(normalized)) return 7;

    const rangeMatch = normalized.match(/(\d+)\s*[-~至]\s*(\d+)\s*年/);
    if (rangeMatch) return Number(rangeMatch[1]) * 12;

    const aboveMatch = normalized.match(/(\d+)\s*年\s*以上/);
    if (aboveMatch) return Number(aboveMatch[1]) * 12 + 1;

    const yearMonthMatch = normalized.match(/(\d+)\s*年\s*(\d+)\s*个?月/);
    if (yearMonthMatch) return Number(yearMonthMatch[1]) * 12 + Number(yearMonthMatch[2]);

    const yearMatch = normalized.match(/^(\d+)\s*年$/);
    if (yearMatch) return Number(yearMatch[1]) * 12;

    const monthMatch = normalized.match(/(\d+)\s*个?月/);
    if (monthMatch) return Number(monthMatch[1]);

    return 0;
  }

  function extractExperienceText(card) {
    const text = window.BossGreetingSelectors.normalizeText(card.textContent);
    const fragments = text.split(/[|｜·,，\s]+/).filter(Boolean);
    const strong = fragments.find((fragment) =>
      /^(\d{2}\s*年应届生|应届生|\d+\s*[-~至]\s*\d+\s*年|\d+\s*年\s*以上|\d+\s*年\s*\d+\s*个?月|\d+\s*年|\d+\s*个?月|1\s*年以内|一年以内|应届|在校|无经验|经验不限)$/.test(fragment)
    );
    if (strong) return strong;

    const loose = text.match(/(\d{2}\s*年应届生|应届生|\d+\s*[-~至]\s*\d+\s*年|\d+\s*年\s*以上|\d+\s*年\s*\d+\s*个?月|\d+\s*年|\d+\s*个?月|1\s*年以内|一年以内|应届|在校|无经验|经验不限)/);
    return loose ? loose[0] : "";
  }

  function extractCandidateName(card) {
    const text = window.BossGreetingSelectors.normalizeText(card.textContent);
    const beforeStatus = text.split(/在线|刚刚活跃|今日活跃|昨天活跃|本周活跃|3日内活跃|离职|在职|期望|最近关注|优势/)[0] || "";
    return beforeStatus.trim().slice(0, 20);
  }

  function hashText(value) {
    let hash = 0;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash << 5) - hash + text.charCodeAt(index);
      hash |= 0;
    }
    return `h${Math.abs(hash)}`;
  }

  function parseCandidateCard(card) {
    const text = window.BossGreetingSelectors.normalizeText(card.textContent);
    const experienceText = extractExperienceText(card);
    const profileUrl = window.BossGreetingSelectors.findProfileUrl(card);
    const name = extractCandidateName(card);
    const candidateKey = profileUrl || hashText(`${name}|${experienceText}|${text.slice(0, 160)}`);
    return {
      candidateKey,
      name,
      profileUrl,
      experienceText,
      experienceMonths: parseExperienceMonths(experienceText),
      searchText: text.slice(0, 1600),
      cardTextSample: text.slice(0, 240)
    };
  }

  function seenSet() {
    return new Set(runState.seenCandidateKeys);
  }

  function markSeen(candidateKey) {
    const seen = seenSet();
    seen.add(candidateKey);
    runState.seenCandidateKeys = Array.from(seen).slice(-900);
  }

  function createOverlay() {
    const root = document.createElement("div");
    root.id = "boss-greeting-assistant-overlay";
    root.innerHTML = [
      "<div class=\"bga-title\">BOSS Greeting Assistant</div>",
      "<div class=\"bga-line\" data-field=\"message\"></div>",
      "<div class=\"bga-grid\">",
      "  <span>Scanned</span><strong data-field=\"processed\"></strong>",
      "  <span>Matched</span><strong data-field=\"eligible\"></strong>",
      "  <span>Greeted</span><strong data-field=\"greeted\"></strong>",
      "  <span>Skipped</span><strong data-field=\"skipped\"></strong>",
      "</div>",
      "<button type=\"button\" data-action=\"stop\">Stop</button>"
    ].join("");

    const style = document.createElement("style");
    style.textContent = [
      "#boss-greeting-assistant-overlay{position:fixed;right:18px;bottom:18px;z-index:2147483647;width:220px;padding:12px;background:#102a2a;color:#fff;border-radius:8px;box-shadow:0 12px 30px rgba(0,0,0,.24);font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
      "#boss-greeting-assistant-overlay .bga-title{font-weight:700;margin-bottom:6px}",
      "#boss-greeting-assistant-overlay .bga-line{color:#c9eeee;margin-bottom:8px;word-break:break-word}",
      "#boss-greeting-assistant-overlay .bga-grid{display:grid;grid-template-columns:1fr auto;gap:2px 10px;margin-bottom:10px}",
      "#boss-greeting-assistant-overlay strong{color:#39d6cd}",
      "#boss-greeting-assistant-overlay button{width:100%;height:30px;border:0;border-radius:6px;background:#1bb7ad;color:#fff;cursor:pointer}"
    ].join("");
    document.documentElement.appendChild(style);
    document.documentElement.appendChild(root);
    root.querySelector("[data-action='stop']").addEventListener("click", () => stopRun("stopped from overlay"));
    return root;
  }

  function renderOverlay() {
    if (!runState.running) {
      if (overlay) {
        overlay.remove();
        overlay = null;
      }
      return;
    }
    overlay = overlay || createOverlay();
    overlay.querySelector("[data-field='message']").textContent = runState.lastMessage;
    overlay.querySelector("[data-field='processed']").textContent = String(runState.processedCount);
    overlay.querySelector("[data-field='eligible']").textContent = String(runState.eligibleCount);
    overlay.querySelector("[data-field='greeted']").textContent = String(runState.greetedCount);
    overlay.querySelector("[data-field='skipped']").textContent = String(runState.skippedCount);
  }

  async function audit(type, payload) {
    return window.BossGreetingAudit.audit(runState.runId, type, payload);
  }

  function findScrollableContainer() {
    const cards = window.BossGreetingSelectors.getCandidateCards();
    const firstCard = cards[0];
    let current = firstCard ? firstCard.parentElement : null;
    while (current && current !== document.body && current !== document.documentElement) {
      if (current.scrollHeight > current.clientHeight + 40) return current;
      current = current.parentElement;
    }

    const candidates = Array.from(document.querySelectorAll("*"))
      .filter((element) => {
        const style = window.getComputedStyle(element);
        return (
          /auto|scroll/.test(style.overflowY) &&
          element.scrollHeight > element.clientHeight + 80 &&
          window.BossGreetingSelectors.visible(element)
        );
      })
      .sort((a, b) => b.scrollHeight - a.scrollHeight);

    return candidates[0] || document.scrollingElement || document.documentElement;
  }

  async function tryLoadMoreCandidates(previousSeenCount) {
    const container = findScrollableContainer();
    const beforeTop = container === document.scrollingElement ? window.scrollY : container.scrollTop;
    const delta = Math.max(480, Math.floor(window.innerHeight * 0.82));

    if (container === document.scrollingElement || container === document.documentElement || container === document.body) {
      window.scrollBy({ top: delta, behavior: "smooth" });
    } else {
      container.scrollBy({ top: delta, behavior: "smooth" });
    }

    await window.BossGreetingSafety.sleep(800);

    const afterTop = container === document.scrollingElement ? window.scrollY : container.scrollTop;
    const newCards = window.BossGreetingSelectors.getCandidateCards()
      .map(parseCandidateCard)
      .filter((candidate) => !seenSet().has(candidate.candidateKey));
    return afterTop !== beforeTop || newCards.length > 0 || seenSet().size > previousSeenCount;
  }

  async function maybeConfirmCandidate(config, candidate) {
    if (!config.requirePerCandidateConfirm) return true;
    return window.confirm(
      `确认给该候选人打招呼？\n\n姓名：${candidate.name || "未识别"}\n经验：${candidate.experienceText || "未识别"}\n判断月数：${candidate.experienceMonths}`
    );
  }

  function dispatchNativeClick(element) {
    const rect = element.getBoundingClientRect();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    };
    element.dispatchEvent(new MouseEvent("mouseover", eventInit));
    element.dispatchEvent(new MouseEvent("mousemove", eventInit));
    element.dispatchEvent(new MouseEvent("mousedown", eventInit));
    element.dispatchEvent(new MouseEvent("mouseup", eventInit));
    element.click();
  }

  function requestTrustedClick(element) {
    const rect = element.getBoundingClientRect();
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "BGA_TRUSTED_CLICK",
          frameUrl: location.href,
          rect: {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height
          }
        },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false, error: "empty trusted click response" });
        }
      );
    });
  }

  function isGreetingConfirmed(card) {
    return Boolean(card && card.isConnected && window.BossGreetingSelectors.isGreetedText(card.textContent));
  }

  async function waitForGreetingConfirmation(card) {
    for (let attempt = 0; attempt < GREET_RESULT_ATTEMPTS && runState.running; attempt += 1) {
      if (isGreetingConfirmed(card)) return true;
      await window.BossGreetingSafety.sleep(350);
    }
    return isGreetingConfirmed(card);
  }

  async function greetCandidate(config, card, candidate) {
    if (!card || !card.isConnected) {
      runState.skippedCount += 1;
      recordFailure("candidate card detached before click");
      await audit("GREETING_SKIPPED", {
        candidateKey: candidate.candidateKey,
        reason: "card_detached"
      });
      return false;
    }

    const greetButton = window.BossGreetingSelectors.findGreetButton(card);
    if (!greetButton || window.BossGreetingSafety.isElementDisabled(greetButton)) {
      runState.skippedCount += 1;
      recordFailure("greet button missing or disabled");
      await audit("GREETING_SKIPPED", {
        candidateKey: candidate.candidateKey,
        reason: "button_missing_or_disabled"
      });
      return false;
    }

    if (config.dryRun) {
      runState.dryRunMatches += 1;
      runState.skippedCount += 1;
      await audit("DRY_RUN_MATCH", candidateAuditPayload(candidate));
      return false;
    }

    const approved = await maybeConfirmCandidate(config, candidate);
    if (!approved) {
      runState.skippedCount += 1;
      recordFailure("candidate rejected by confirmation");
      await audit("GREETING_SKIPPED", {
        candidateKey: candidate.candidateKey,
        reason: "user_rejected_candidate"
      });
      return false;
    }

    greetButton.scrollIntoView({ block: "center", inline: "nearest" });
    await window.BossGreetingSafety.sleep(260);

    if (!window.BossGreetingSelectors.inViewport(greetButton) || !window.BossGreetingSelectors.topClickable(greetButton)) {
      runState.skippedCount += 1;
      recordFailure("greet button not clickable");
      await audit("GREETING_SKIPPED", {
        candidateKey: candidate.candidateKey,
        reason: "button_not_clickable"
      });
      return false;
    }

    try {
      const trustedClick = await requestTrustedClick(greetButton);
      if (!trustedClick || !trustedClick.ok) {
        dispatchNativeClick(greetButton);
        await audit("TRUSTED_CLICK_FALLBACK", {
          candidateKey: candidate.candidateKey,
          reason: trustedClick && trustedClick.error
        });
      }
    } catch (error) {
      runState.skippedCount += 1;
      recordFailure(`click failed: ${error.message}`);
      await audit("GREETING_SKIPPED", {
        candidateKey: candidate.candidateKey,
        reason: "click_failed",
        message: error.message
      });
      return false;
    }

    const confirmed = await waitForGreetingConfirmation(card);
    if (!confirmed) {
      runState.unconfirmedCount += 1;
      recordFailure("click not confirmed by page state");
      await audit("GREETING_NOT_CONFIRMED", {
        candidateKey: candidate.candidateKey,
        name: candidate.name,
        experienceText: candidate.experienceText,
        experienceMonths: candidate.experienceMonths,
        cardTextSample: window.BossGreetingSelectors.normalizeText(card.textContent).slice(0, 260)
      });
      return false;
    }

    runState.greetedCount += 1;
    await audit("GREETING_CLICKED", {
      candidateKey: candidate.candidateKey,
      name: candidate.name,
      experienceText: candidate.experienceText,
      experienceMonths: candidate.experienceMonths,
      greetedCount: runState.greetedCount
    });
    await window.BossGreetingSafety.sleep(
      Math.max(
        SETTLE_AFTER_CLICK_MS,
        window.BossGreetingSafety.randomDelay(config.minDelayMs, config.maxDelayMs)
      )
    );
    return true;
  }

  function targetReached(config) {
    return config.dryRun ? runState.dryRunMatches >= config.maxGreetings : runState.greetedCount >= config.maxGreetings;
  }

  function evaluateCandidateEligibility(candidate, config) {
    const experienceOk = candidate.experienceMonths > config.minExperienceMonths;
    const jobRule = selectJobRule(config.jobText);
    const evidenceText = buildJobEvidenceText(candidate.searchText || candidate.cardTextSample);
    const jobMatch = matchJobExperience(jobRule, evidenceText);
    const jobExperienceOk = jobMatch.ok;
    const hasKnownJobRule = Boolean(jobRule);
    const industryOk = hasKnownJobRule ? jobExperienceOk : true;
    const eligible = hasKnownJobRule ? jobExperienceOk : experienceOk;
    let skipReason = "";
    if (!industryOk) skipReason = `missing_${jobRule.key}_industry_experience`;
    else if (!eligible) skipReason = "no_explicit_work_experience";

    return {
      eligible,
      experienceOk,
      looseIndustryPass: !experienceOk && jobExperienceOk,
      jobText: config.jobText,
      jobRuleKey: jobRule ? jobRule.key : "general_experience",
      jobExperienceOk,
      jobPatternVersion: JOB_PATTERN_VERSION,
      jobMatchMode: jobMatch.jobMatchMode,
      jobKeywordHits: jobMatch.jobKeywordHits,
      nearMissReason: jobMatch.nearMissReason,
      matchedEvidence: jobMatch.matchedEvidence,
      evidenceTextSample: evidenceText.slice(0, 320),
      evidenceTextLength: evidenceText.length,
      rule: describeJobRule(jobRule),
      skipReason
    };
  }

  async function waitForCardsOrBlocker() {
    for (let attempt = 0; attempt < WAIT_FOR_CARDS_ATTEMPTS && runState.running; attempt += 1) {
      const blocker = window.BossGreetingSafety.detectHumanRequiredBlocker();
      if (blocker) return { blocker, cards: [] };

      const cards = window.BossGreetingSelectors.getCandidateCards();
      if (cards.length) return { blocker: "", cards };

      setMessage("waiting for candidate list to load", "loading");
      await window.BossGreetingSafety.sleep(450);
    }
    return { blocker: "", cards: window.BossGreetingSelectors.getCandidateCards() };
  }

  async function scanLoop(config) {
    let emptyLoads = 0;

    while (runState.running && !targetReached(config)) {
      if (Date.now() - new Date(runState.startedAt).getTime() > config.maxRuntimeMs) {
        await stopRun("max runtime reached", "max_runtime");
        return;
      }

      const ready = await waitForCardsOrBlocker();
      if (ready.blocker) {
        await audit("RUN_STOPPED_HUMAN_REQUIRED", { reason: ready.blocker });
        await stopRun(`human action required: ${ready.blocker}`, "human_required");
        return;
      }

      const cards = ready.cards;
      if (!cards.length) {
        const loaded = await tryLoadMoreCandidates(seenSet().size);
        emptyLoads = loaded ? 0 : emptyLoads + 1;
        if (emptyLoads >= window.BossGreetingSafety.MAX_EMPTY_LOADS) {
          await audit("RUN_STOPPED_NO_MORE_PROGRESS", { emptyLoads });
          await stopRun("no candidate cards found after waiting", "no_cards");
          return;
        }
        continue;
      }

      let madeProgress = false;
      let clickedThisCycle = false;

      for (const card of cards) {
        if (!runState.running || targetReached(config)) break;
        if (!card || !card.isConnected || !window.BossGreetingSelectors.visible(card)) continue;

        const candidate = parseCandidateCard(card);
        if (!candidate.candidateKey || seenSet().has(candidate.candidateKey)) continue;

        markSeen(candidate.candidateKey);
        runState.processedCount += 1;
        madeProgress = true;

        const decision = evaluateCandidateEligibility(candidate, config);
        await audit("CANDIDATE_EVALUATED", {
          ...candidateAuditPayload(candidate),
          ...decision
        });

        if (!decision.eligible) {
          runState.skippedCount += 1;
          if (decision.skipReason) recordFailure(decision.skipReason);
          saveState();
          continue;
        }

        runState.eligibleCount += 1;
        setMessage(
          config.dryRun
            ? `matched ${runState.dryRunMatches + 1}/${config.maxGreetings}`
            : `greeting ${runState.greetedCount + 1}/${config.maxGreetings}`,
          config.dryRun ? "scanning" : "greeting"
        );

        clickedThisCycle = await greetCandidate(config, card, candidate);
        if (!clickedThisCycle) {
          markSeen(`${candidate.candidateKey}|unconfirmed|${Date.now()}`);
        }
        saveState();

        if (clickedThisCycle) break;
      }

      if (targetReached(config)) {
        await audit("RUN_STOPPED_LIMIT_REACHED", {
          limit: config.maxGreetings,
          greeted: runState.greetedCount,
          dryRunMatches: runState.dryRunMatches
        });
        await stopRun(config.dryRun ? "dry run matched target candidates" : "completed automatic greetings", "limit_reached");
        return;
      }

      if (clickedThisCycle) {
        emptyLoads = 0;
        setMessage(`clicked; continuing ${runState.greetedCount}/${config.maxGreetings}`, "greeting");
        continue;
      }

      if (!madeProgress) {
        const loaded = await tryLoadMoreCandidates(seenSet().size);
        emptyLoads = loaded ? 0 : emptyLoads + 1;
        if (emptyLoads >= window.BossGreetingSafety.MAX_EMPTY_LOADS) {
          await audit("RUN_STOPPED_NO_MORE_PROGRESS", { emptyLoads });
          await stopRun("not enough matched candidates; stopped", "no_more_progress");
          return;
        }
      } else {
        emptyLoads = 0;
        await tryLoadMoreCandidates(seenSet().size);
      }

      setMessage(
        config.dryRun
          ? `scanning; matched ${runState.dryRunMatches}/${config.maxGreetings}`
          : `scanning; greeted ${runState.greetedCount}/${config.maxGreetings}`,
        "scanning"
      );
      await window.BossGreetingSafety.sleep(700);
    }
  }

  async function startRun(rawConfig) {
    if (runState.running) return publicState();
    if (!/zhipin\.com/.test(location.hostname)) {
      throw new Error("please run on BOSS page");
    }
    if (!isCandidateFrame()) {
      return {
        ...publicState(),
        frameReady: false,
        lastMessage: "waiting for candidate list"
      };
    }

    const config = window.BossGreetingSafety.normalizeConfig(rawConfig);
    config.jobText = window.BossGreetingSelectors.normalizeText(
      config.jobText || window.BossGreetingSelectors.getCurrentJobText()
    ).slice(0, 160);
    const jobRule = selectJobRule(config.jobText);
    runState = createIdleState();
    runState.running = true;
    runState.status = config.dryRun ? "scanning" : "greeting";
    runState.runId = window.BossGreetingAudit.uuid();
    runState.startedAt = new Date().toISOString();
    runState.lastMessage = config.dryRun ? "dry run scanning" : "auto-greeting visible matches";
    runState.currentJobText = config.jobText;
    runState.currentJobRule = jobRule ? jobRule.key : "general_experience";
    saveState();

    await audit("RUN_STARTED", {
      maxGreetings: config.maxGreetings,
      minExperienceMonths: config.minExperienceMonths,
      jobText: config.jobText,
      jobRuleKey: runState.currentJobRule,
      rule: describeJobRule(jobRule),
      dryRun: config.dryRun,
      requirePerCandidateConfirm: config.requirePerCandidateConfirm,
      minDelayMs: config.minDelayMs,
      maxDelayMs: config.maxDelayMs
    });

    scanLoop(config).catch(async (error) => {
      await audit("RUN_ERROR", { message: error.message, stack: String(error.stack || "") });
      await stopRun(`run error: ${error.message}`, "error");
    });

    return publicState();
  }

  async function stopRun(message, status) {
    if (!runState.running && status !== "human_required") return publicState();
    runState.running = false;
    runState.status = status || "stopped";
    runState.lastMessage = message || "stopped";
    await audit(status === "limit_reached" ? "RUN_STOPPED_LIMIT_REACHED" : "RUN_STOPPED", {
      status: runState.status,
      message: runState.lastMessage
    });
    saveState();
    return publicState();
  }

  async function handleMessage(message) {
    if (!message || !message.type) return { ok: false, error: "missing message type" };

    if (message.type === "BGA_START") {
      const state = await startRun(message.config);
      return { ok: true, state };
    }

    if (message.type === "BGA_STOP") {
      const state = await stopRun("stopped from popup", "stopped");
      return { ok: true, state };
    }

    if (message.type === "BGA_STATE") {
      return { ok: true, state: publicState() };
    }

    if (message.type === "BGA_PAGE_CONTEXT") {
      return {
        ok: true,
        context: {
          currentJobText: window.BossGreetingSelectors.getCurrentJobText(),
          pageUrl: location.href
        }
      };
    }

    if (message.type === "BGA_GET_FRAME_RECT") {
      const frame = Array.from(document.querySelectorAll("iframe")).find((iframe) => {
        const src = iframe.getAttribute("src") || "";
        return (
          (message.frameUrl && src && message.frameUrl.includes(src.split("?")[0])) ||
          src.includes("/web/frame/recommend") ||
          iframe.name === "recommendFrame"
        );
      });
      if (!frame) return { ok: false, error: "recommend iframe not found" };
      const rect = frame.getBoundingClientRect();
      return {
        ok: true,
        rect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height
        }
      };
    }

    return { ok: false, error: "unknown message type" };
  }

  window.BossGreetingAssistantHandleMessage = handleMessage;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });
})();
