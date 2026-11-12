(function () {
  "use strict";

  // 两条硬条件：大专及以上财务相关专业 + 命中跨境关键词。命中即符合，不再计算经验月数。
  // 关键词表按需增删；同时命中的长词会吸收短词（命中“跨境电商”不再重复报“跨境”）。
  const KEYWORDS = Object.freeze([
    "跨境电商", "跨境", "亚马逊", "amazon", "海外仓", "退税", "出口退税",
    "fba", "保税仓", "保税", "独立站", "速卖通", "shopee", "lazada", "tiktok shop",
    "阿里巴巴国际站", "国际站", "外贸", "报关", "进出口", "结汇", "外汇"
  ]);

  const PROFILE = Object.freeze({
    id: "cross_border_finance",
    version: "2026-11-11.4",
    title: "财务专业 · 跨境关键词",
    requirements: Object.freeze([
      {
        key: "major",
        label: "大专及以上 · 财务相关专业",
        description: "大专、本科或以上学历，专业属会计、财务管理、审计、税务、税收等财务相关专业。中专、高中及以下不通过；金融/经济/国贸等非财务专业不通过。"
      },
      {
        key: "keyword",
        label: "命中跨境电商关键词",
        description: "简历文本出现跨境电商、亚马逊、海外仓、退税、FBA、独立站、速卖通、外贸、报关、结汇等任一关键词即通过；不再按经验月数判断。"
      }
    ].map((item) => Object.freeze(item)))
  });

  // 整行就是岗位要求/求职意向时，整行丢弃；行内个别词命中只丢那个词。
  const REQUIREMENT_ROW = /^(?:岗位要求|任职要求|招聘要求|职位要求|求职意向|目标岗位|期望|希望从事)|(?:岗位要求|任职要求|招聘要求|职位要求)\s*[:：]/;
  // 逐词过滤只用“开头”判断，避免把内联长词整体丢掉。
  const START_NON_WORK = /^(?:求职|意向|目标岗位|期望|希望从事|岗位|任职|招聘|职位|培训|课程|学习|模拟|案例)/;

  // 词表用数组维护：profileExtractor 的学历词表必须覆盖这里全部词，测试会比对。
  const HIGHER_WORDS = Object.freeze(["博士", "硕士", "研究生", "本科", "学士", "专升本", "专转本", "专接本"]);
  // 大专（含专科、高职）自 0.5.2 起算达标；只有中专及以下不通过。
  const ASSOCIATE_WORDS = Object.freeze(["大专", "专科", "高职"]);
  const BELOW_WORDS = Object.freeze(["中专", "中职", "职高", "技校", "高中", "初中", "小学"]);
  const HIGHER_DEGREE = new RegExp(HIGHER_WORDS.join("|"));
  const ASSOCIATE_DEGREE = new RegExp(ASSOCIATE_WORDS.join("|"));
  const BELOW_DEGREE = new RegExp(BELOW_WORDS.join("|"));
  // 财务相关：会计、财务管理、审计、税务、税收等。
  const FINANCE_MAJOR = /会计|财务|财会|审计|税务|税收/;
  const OTHER_MAJOR = /金融|经济|统计|国际贸易|国际经济|贸易经济|国际商务|财政|保险|投资|证券|资产评估|计算机|软件|信息|电子|通信|自动化|机械|土木|建筑|材料|化工|环境|能源|临床|护理|药学|医学|法学|英语|日语|汉语言|新闻|传播|广告|市场营销|人力资源|工商管理|行政管理|公共事业|旅游|物流|电子商务|艺术|音乐|美术|设计|体育|数学|物理|化学|生物|农学|历史|哲学|教育学/;
  // 校名/院系名（上海立信会计金融学院、会计学院）不能当作专业证据。
  const SCHOOL_TOKEN = /(?:大学|学院|学校|中学|职校|技校)$/;
  // 课程段落整体截断，课程/证书类词单独丢弃，辅修/选修整词丢弃。
  const COURSE_INTRO = /主修课程|核心课程|主要课程|专业课程|开设课程|课程\s*[:：]/;
  const COURSE_TOKEN = /课程|培训|证书|考试|资格/;
  const MINOR_TOKEN = /^(?:辅修|选修|自学)/;
  const MAJOR_PREFIX = /^主修/;

  function text(value) {
    return typeof value === "string" ? value.normalize("NFKC").trim() : "";
  }

  function result(key, status, evidence, reason) {
    const requirement = PROFILE.requirements.find((item) => item.key === key);
    return { key, label: requirement.label, status, evidence, reason };
  }

  // 逐词判定：先剔除校名、院系名、课程与求职意向词，再在剩余词里找学历和专业。
  // 这样“上海立信会计金融学院 计算机科学与技术”不会被校名里的“会计”带过。
  function majorCheck(value) {
    const evidence = text(value);
    if (!evidence) return result("major", "fail", evidence, "证据不足，按不符合处理：卡片未展示教育经历。");
    const rows = evidence.split(/[；;\n]+/).map((row) => row.trim()).filter(Boolean);
    let higher = false;
    let associate = false;
    let below = false;
    let finance = false;
    let other = "";
    for (const raw of rows) {
      if (REQUIREMENT_ROW.test(raw)) continue;
      const cut = raw.search(COURSE_INTRO);
      const row = cut >= 0 ? raw.slice(0, cut) : raw;
      const tokens = row.replace(/[（）()【】\[\]]/g, " ").split(/[\s·•|｜,，、;；。]+/).filter(Boolean);
      for (let token of tokens) {
        if (MAJOR_PREFIX.test(token)) token = token.replace(MAJOR_PREFIX, "");
        if (!token || COURSE_TOKEN.test(token) || MINOR_TOKEN.test(token)) continue;
        // 只丢弃“以求职意向开头”的词：内联卡片会把学历、期望、岗位粘成一整词，
        // 用包含判断会连学历一起丢掉。
        if (START_NON_WORK.test(token)) continue;
        if (SCHOOL_TOKEN.test(token)) {
          // “宁波某专科学校”这类写法，学校名本身就是学历证据，不能整词丢掉。
          if (/专科|大专|高职/.test(token)) associate = true;
          continue;
        }
        if (/(?:非|不是|并非)\s*财务|非财经/.test(token)) { other = other || token; continue; }
        if (FINANCE_MAJOR.test(token)) finance = true;
        else if (OTHER_MAJOR.test(token)) other = other || token;
        if (HIGHER_DEGREE.test(token)) higher = true;
        else if (ASSOCIATE_DEGREE.test(token)) associate = true;
        else if (BELOW_DEGREE.test(token)) below = true;
      }
    }
    const qualified = higher || associate;
    if (qualified && finance) return result("major", "pass", evidence, "大专及以上学历的专业为财务相关。");
    if (qualified) return result("major", "fail", evidence, other
      ? "专业不属于财务相关专业。" : "专业未见财务相关证据。");
    if (below) return result("major", "fail", evidence, "最高学历为中专/高中及以下，未达大专。");
    return result("major", "fail", evidence, "证据不足，按不符合处理：未见大专及以上学历。");
  }

  function matchedKeywords(value) {
    const haystack = text(value).toLowerCase();
    if (!haystack) return [];
    const hits = KEYWORDS.filter((keyword) => haystack.includes(keyword));
    // 长词吸收短词：命中“跨境电商”时不再单独报“跨境”。
    return hits.filter((keyword) => !hits.some((other) => other !== keyword && other.length > keyword.length && other.includes(keyword)));
  }

  function excerpt(value, index) {
    const body = text(value);
    if (!body) return "";
    const start = Math.max(0, index - 12);
    const end = Math.min(body.length, index + 24);
    return (start ? "…" : "") + body.slice(start, end) + (end < body.length ? "…" : "");
  }

  function keywordCheck(value) {
    const evidence = text(value);
    const hits = matchedKeywords(evidence);
    if (!hits.length) {
      return result("keyword", "fail", excerpt(evidence, 0),
        "未见跨境电商相关关键词（跨境电商、亚马逊、海外仓、退税、FBA、独立站、外贸、报关、结汇等）。");
    }
    const lower = evidence.toLowerCase();
    const first = hits.slice().sort((a, b) => lower.indexOf(a) - lower.indexOf(b))[0];
    return result("keyword", "pass",
      `命中：${hits.join("、")}｜${excerpt(evidence, lower.indexOf(first))}`,
      `简历中出现${hits.join("、")}等跨境关键词。`);
  }

  function candidateText(input) {
    const entries = Array.isArray(input.workEntries) ? input.workEntries : [];
    // keywordText 由提取器提供，已排除教育经历；缺省时回退到整卡文本。
    const parts = [text(input.keywordText) || input.text];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      parts.push([entry.company, entry.title, entry.description].map(text).filter(Boolean).join(" "));
    }
    return parts.map(text).filter(Boolean).join("\n");
  }

  function evaluate(profile) {
    const input = profile && typeof profile === "object" ? profile : {};
    const scanned = candidateText(input);
    const checks = [majorCheck(input.educationText), keywordCheck(scanned)];
    const failed = checks.filter((item) => item.status !== "pass");
    const outcome = failed.length ? "reject" : "match";
    const summary = failed.length
      ? "不符合：" + failed.map((item) => item.label).join("、")
      : "符合：大专及以上财务相关专业，" + checks[1].reason;
    return { eligible: outcome === "match", outcome, checks, summary, matchedKeywords: matchedKeywords(scanned) };
  }

  const api = Object.freeze({
    PROFILE, KEYWORDS, evaluate,
    DEGREES: Object.freeze({ higher: HIGHER_WORDS, associate: ASSOCIATE_WORDS, below: BELOW_WORDS })
  });
  globalThis.BossFinanceRules = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
