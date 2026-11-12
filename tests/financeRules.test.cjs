"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { PROFILE, KEYWORDS, DEGREES, evaluate } = require("../src/content/financeRules.js");

const KEYS = ["major", "keyword"];

function profile(overrides = {}) {
  return { educationText: "2018-09 至 2022-06 某大学 会计学 本科", text: "负责亚马逊平台账务核算", ...overrides };
}

function statuses(result) {
  return Object.fromEntries(result.checks.map((check) => [check.key, check.status]));
}

test("the profile exposes exactly two hard requirements plus the keyword list", () => {
  assert.equal(PROFILE.id, "cross_border_finance");
  assert.deepEqual(PROFILE.requirements.map((item) => item.key), KEYS);
  assert.equal(Object.isFrozen(PROFILE), true);
  assert.equal(Object.isFrozen(PROFILE.requirements), true);
  assert.equal(Object.isFrozen(KEYWORDS), true);
  for (const keyword of ["跨境电商", "亚马逊", "海外仓", "退税"]) {
    assert.ok(KEYWORDS.includes(keyword), keyword);
  }
});

test("CommonJS and browser globals expose the same public interface", () => {
  const source = readFileSync(path.join(__dirname, "../src/content/financeRules.js"), "utf8");
  const context = vm.createContext({});
  vm.runInContext(source, context);
  assert.equal(JSON.stringify(Object.keys(context.BossFinanceRules).sort()), JSON.stringify(["DEGREES", "KEYWORDS", "PROFILE", "evaluate"]));
  assert.equal(JSON.stringify(context.BossFinanceRules.PROFILE.requirements.map((item) => item.key)), JSON.stringify(KEYS));
});

test("only match and reject exist, and both checks must pass", () => {
  const allowed = new Set(["match", "reject"]);
  for (const input of [profile(), profile({ educationText: "" }), profile({ text: "" }), {}, profile({ text: "日常报销" })]) {
    const result = evaluate(input);
    assert.ok(allowed.has(result.outcome), result.outcome);
    assert.equal(result.eligible, result.outcome === "match");
    assert.deepEqual(result.checks.map((check) => check.key), KEYS);
    for (const check of result.checks) assert.ok(["pass", "fail"].includes(check.status), check.status);
    if (result.outcome === "match") assert.deepEqual(statuses(result), { major: "pass", keyword: "pass" });
  }
});

for (const educationText of [
  "2018-09 至 2021-06 某职业技术学院 会计 大专",
  "2018-09 至 2021-06 某学院 财务管理 专科",
  "2018-09 至 2021-06 某职业学院 审计 高职",
  "2018-09 至 2022-06 某大学 会计学 本科",
  "2018-09 至 2022-06 某大学 财务管理 本科",
  "2018-09 至 2022-06 某大学 审计学 学士",
  "2018-09 至 2022-06 某大学 税务 本科",
  "2018-09 至 2022-06 某大学 税收学 本科",
  "2018-09 至 2022-06 某大学 会计学专业 本科",
  "本科 会计学",
  "会计学 本科"
]) {
  test(`finance major at associate level or above passes: ${educationText}`, () => {
    const result = evaluate(profile({ educationText }));
    assert.equal(statuses(result).major, "pass");
    assert.equal(result.outcome, "match");
  });
}

for (const educationText of [
  "2015-09 至 2018-06 某中专 会计 中专",
  "2015-09 至 2018-06 某职高 会计 职高",
  "2012-09 至 2015-06 某中学 高中"
]) {
  test(`below associate level fails even with a finance major: ${educationText}`, () => {
    const result = evaluate(profile({ educationText }));
    assert.equal(statuses(result).major, "fail");
    assert.equal(result.outcome, "reject");
    assert.match(result.checks[0].reason, /中专|大专/);
  });
}

for (const educationText of [
  "2018-09 至 2022-06 某大学 金融学 本科",
  "2018-09 至 2022-06 某大学 经济学 本科",
  "2018-09 至 2022-06 某大学 国际经济与贸易 本科",
  "2018-09 至 2022-06 某大学 经济统计学 本科",
  "2018-09 至 2022-06 某大学 工商管理 本科",
  "2018-09 至 2022-06 某大学 计算机科学与技术 本科",
  "2018-09 至 2022-06 某大学 英语 本科"
]) {
  test(`non-finance majors fail even with cross-border keywords: ${educationText}`, () => {
    const result = evaluate(profile({ educationText }));
    assert.equal(statuses(result).major, "fail");
    assert.equal(statuses(result).keyword, "pass");
    assert.equal(result.outcome, "reject");
  });
}

test("an associate degree counts, but a non-finance major at the same level does not", () => {
  assert.equal(statuses(evaluate(profile({ educationText: "大专 会计" }))).major, "pass");
  assert.equal(statuses(evaluate(profile({ educationText: "大专 计算机应用技术" }))).major, "fail");
  assert.equal(statuses(evaluate(profile({ educationText: "中专 会计" }))).major, "fail");
});

test("a finance word in the school name never proves the major", () => {
  // 校名整词剔除：上海立信会计金融学院读计算机，不能被校名里的“会计”带过。
  assert.equal(statuses(evaluate(profile({ educationText: "2018-09 至 2022-06 上海立信会计金融学院 计算机科学与技术 本科" }))).major, "fail");
  assert.equal(statuses(evaluate(profile({ educationText: "2018-09 至 2022-06 上海立信会计金融学院 会计学 本科" }))).major, "pass");
  assert.equal(statuses(evaluate(profile({ educationText: "2018-09 至 2022-06 中央财经大学 计算机科学与技术 本科" }))).major, "fail");
  // 院系名同样按校名处理，只有院系、没有专业名时不作为证据。
  assert.equal(statuses(evaluate(profile({ educationText: "某大学 会计学院 本科" }))).major, "fail");
  assert.equal(statuses(evaluate(profile({ educationText: "某大学 会计学院 会计学 本科" }))).major, "pass");
  assert.equal(statuses(evaluate(profile({ educationText: "某大学 会计学院 计算机科学与技术 本科" }))).major, "fail");
});

test("coursework in finance does not replace the declared major", () => {
  assert.equal(statuses(evaluate(profile({ educationText: "本科 计算机科学与技术 主修课程：基础会计、财务管理" }))).major, "fail");
});

test("an explicitly non-finance major fails without guessing", () => {
  assert.equal(statuses(evaluate(profile({ educationText: "本科 非财务相关专业" }))).major, "fail");
});

test("master and doctoral finance degrees count as bachelor-level finance", () => {
  for (const educationText of ["2020-09 至 2023-06 某大学 会计学 硕士", "2020-09 至 2024-06 某大学 财务管理 博士"]) {
    assert.equal(statuses(evaluate(profile({ educationText }))).major, "pass", educationText);
  }
});

test("incidental words in an education row do not erase the degree or major", () => {
  for (const educationText of [
    "专升本 会计学",
    "本科 会计学（辅修金融）",
    "2018-09 至 2022-06 某大学 会计学 本科 期望岗位：财务",
    "本科 会计学 已参加初级会计培训"
  ]) {
    assert.equal(statuses(evaluate(profile({ educationText }))).major, "pass", educationText);
  }
});

test("missing or unrelated education text fails closed with an explicit reason", () => {
  for (const educationText of ["", "   ", "某公司 2025-01 至 2026-01 财务会计", "教育经历"]) {
    const result = evaluate(profile({ educationText }));
    assert.equal(statuses(result).major, "fail");
    assert.match(result.checks[0].reason, /不符合/);
  }
});

test("job requirements and training claims never become the candidate's major", () => {
  assert.equal(statuses(evaluate(profile({ educationText: "岗位要求 本科 会计学专业" }))).major, "fail");
});

for (const text of [
  "负责亚马逊平台账务核算",
  "AMAZON FBA 结算与对账",
  "跨境电商公司总账",
  "海外仓成本核算",
  "办理出口退税申报",
  "独立站收款核对",
  "速卖通店铺结算",
  "Shopee 平台对账",
  "外贸公司应收会计",
  "报关与结汇",
  "阿里巴巴国际站财务",
  "负责保税仓库存账"
]) {
  test(`cross-border keyword counts as a hit: ${text}`, () => {
    const result = evaluate(profile({ text }));
    assert.equal(statuses(result).keyword, "pass", text);
    assert.equal(result.outcome, "match");
    assert.ok(result.matchedKeywords.length >= 1);
  });
}

for (const text of ["", "   ", "负责日常报销与凭证整理", "国内制造企业成本核算", "每月出具财务报表"]) {
  test(`text without cross-border keywords fails closed: ${JSON.stringify(text)}`, () => {
    const result = evaluate(profile({ text }));
    assert.equal(statuses(result).keyword, "fail");
    assert.equal(result.outcome, "reject");
    assert.match(result.checks[1].reason, /关键词/);
    assert.deepEqual(result.matchedKeywords, []);
  });
}

test("a longer keyword absorbs its own prefix", () => {
  assert.deepEqual(evaluate(profile({ text: "跨境电商财务" })).matchedKeywords, ["跨境电商"]);
  assert.deepEqual(evaluate(profile({ text: "出口退税申报" })).matchedKeywords, ["出口退税"]);
  assert.deepEqual(evaluate(profile({ text: "保税仓管理" })).matchedKeywords, ["保税仓"]);
  assert.deepEqual(evaluate(profile({ text: "阿里巴巴国际站" })).matchedKeywords, ["阿里巴巴国际站"]);
});

test("keywords are matched inside work entries as well as card text", () => {
  const result = evaluate({
    educationText: "本科 会计学",
    workEntries: [{ company: "深圳跨境电商有限公司", title: "会计", description: "负责对账" }]
  });
  assert.equal(statuses(result).keyword, "pass");
  assert.deepEqual(result.matchedKeywords, ["跨境电商"]);
  const viaDescription = evaluate({
    educationText: "本科 会计学",
    workEntries: [{ company: "某贸易公司", title: "会计", description: "负责海外仓成本核算" }]
  });
  assert.equal(statuses(viaDescription).keyword, "pass");
});

test("a keyword hit never rescues a candidate who fails the major gate", () => {
  const result = evaluate({ educationText: "中专 会计", text: "亚马逊 跨境电商 退税" });
  assert.deepEqual(statuses(result), { major: "fail", keyword: "pass" });
  assert.equal(result.outcome, "reject");
  assert.match(result.summary, /大专及以上 · 财务相关专业/);
});

test("keywordText excludes education so a school name cannot trigger a keyword", () => {
  const result = evaluate({
    educationText: "2018-09 至 2022-06 广东外语外贸大学 会计学 本科",
    text: "广东外语外贸大学 会计学 本科 某国内制造公司 会计 负责日常报销",
    keywordText: "某国内制造公司 会计 负责日常报销"
  });
  assert.deepEqual(result.matchedKeywords, []);
  assert.equal(result.outcome, "reject");
  const withoutKeywordText = evaluate({
    educationText: "2018-09 至 2022-06 广东外语外贸大学 会计学 本科",
    text: "广东外语外贸大学 会计学 本科 某国内制造公司 会计 负责日常报销"
  });
  assert.deepEqual(withoutKeywordText.matchedKeywords, ["外贸"]);
});

test("evidence quotes the matched keyword and its context", () => {
  const result = evaluate(profile({ text: "2023 至今 深圳某跨境电商公司 负责亚马逊账务" }));
  const check = result.checks.find((item) => item.key === "keyword");
  assert.match(check.evidence, /跨境电商/);
  assert.match(check.evidence, /亚马逊/);
  assert.match(check.evidence, /…|深圳/);
});

test("personal attributes never change evidence, decisions or summaries", () => {
  const base = profile();
  const plain = evaluate(base);
  const decorated = evaluate({ ...base, age: 24, gender: "女", maritalStatus: "已婚", birthDate: "2002-03-01" });
  assert.deepEqual(decorated, plain);
  assert.doesNotMatch(plain.summary, /年龄|性别|婚/);
});

test("summaries state the outcome and never mention a review state", () => {
  const matched = evaluate(profile());
  assert.match(matched.summary, /^符合：/);
  assert.match(matched.summary, /亚马逊/);
  assert.doesNotMatch(matched.summary, /待核实|复核/);
  const rejected = evaluate(profile({ text: "日常报销" }));
  assert.match(rejected.summary, /^不符合：/);
  assert.match(rejected.summary, /命中跨境电商关键词/);
});

test("evaluate tolerates absent and malformed input", () => {
  for (const input of [undefined, null, "文本", 42, [], { workEntries: "文本" }, { workEntries: [null, 3] }]) {
    const result = evaluate(input);
    assert.equal(result.outcome, "reject");
    assert.equal(result.eligible, false);
  }
});

test("the extractor recognises every degree word the rules rely on", () => {
  const { degreeWords } = require("../src/content/profileExtractor.js");
  const words = new Set(degreeWords);
  for (const [group, list] of Object.entries(DEGREES)) {
    for (const word of list) assert.ok(words.has(word), `${group}: ${word} 缺失于提取器词表`);
  }
});
