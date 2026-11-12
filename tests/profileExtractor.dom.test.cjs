const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const fixture = readFileSync(path.join(__dirname, "fixtures/recommend-profile.synthetic.html"), "utf8");
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { if (browser) await browser.close(); });

async function inspect(markup = fixture, mutate = () => {}, discover = false) {
  const context = await browser.newContext({ offline: true, serviceWorkers: "block" });
  try {
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    await page.setContent(markup);
    await page.addScriptTag({ path: path.resolve(__dirname, "../src/content/profileExtractor.js") });
    await page.addScriptTag({ path: path.resolve(__dirname, "../src/content/financeRules.js") });
    if (discover) await page.addScriptTag({ path: path.resolve(__dirname, "../src/content/domSelectors.js") });
    await page.evaluate(mutate);
    return await page.evaluate((discover) => {
      const cards = discover ? BossGreetingSelectors.getCandidateCards() : [document.querySelector("article")];
      const profile = BossFinanceProfile.extract(cards[0], new Date(2026, 10, 7));
      const evaluation = BossFinanceRules.evaluate(profile, new Date(2026, 10, 7));
      return { profile, statuses: Object.fromEntries(evaluation.checks.map((check) => [check.key, check.status])),
        matched: evaluation.matchedKeywords, roots: cards.map((card) => card.id) };
    }, discover);
  } finally { await context.close(); }
}

test("synthetic screenshot layout extracts independent education and work rows without headings", async () => {
  const { profile, statuses } = await inspect();
  assert.deepEqual(statuses, { major: "fail", keyword: "fail" });
  assert.match(profile.educationText, /2018-2023\s+宁波大学\s*·\s*工商管理\s*·\s*本科/);
  assert.equal(profile.workEntries.length, 1);
  assert.equal(profile.workEntries[0].company, "六相网络科技");
  assert.equal(profile.workEntries[0].title, "会计");
  assert.equal(profile.workEntries[0].start, "2025-04");
  assert.equal(profile.workEntries[0].end, "至今");
});

test("explicit dated DOM rows work without any inferred BOSS class names", async () => {
  const { profile, statuses } = await inspect(`<article>
    <div><span>2025.04-至今</span> <span>六相网络科技 · 会计</span></div>
    <div><span>2018-2023</span> <span>宁波大学 · 工商管理 · 本科</span></div>
    <div>期望 宁波·会计</div><div>9-10K</div>
  </article>`);
  assert.equal(profile.workEntries.length, 1);
  assert.equal(profile.workEntries[0].company, "六相网络科技");
  assert.match(profile.educationText, /宁波大学/);
  assert.doesNotMatch(profile.educationText, /六相网络/);
  assert.doesNotMatch(profile.workEntries[0].description, /宁波大学|本科/);
});

test("separate inline work rows cannot lend industry or finance titles to each other", async () => {
  const { profile, statuses, months } = await inspect(`<article class="geek-card">
    <div class="work-experience">
      <div class="experience-item">2024.01-2025.01 甲跨境电商公司 · 电商运营</div>
      <div class="experience-item">2025.02-2026.02 乙国内科技公司 · 会计</div>
    </div>
    <div class="education-exp"><div>2018-2023 宁波大学 · 工商管理 · 本科</div></div>
  </article>`);
  assert.equal(profile.workEntries.length, 2);
  assert.equal(profile.workEntries[0].company, "甲跨境电商公司");
  assert.equal(profile.workEntries[1].company, "乙国内科技公司");
  assert.doesNotMatch(profile.workEntries[0].description, /乙国内|会计/);
  assert.doesNotMatch(profile.workEntries[1].description, /甲跨境|运营/);
});

for (const range of ["2023-2028", "2023-2026", "2028-2023"]) {
  test(`the degree name survives an unfinished or invalid year range: ${range}`, async () => {
    const { profile } = await inspect(`<article><div>${range} 宁波大学 · 会计学 · 本科</div></article>`);
    // 0.3.0 只看本科专业是否财经类，不再判断是否已毕业，因此学历词必须保留。
    assert.match(profile.educationText, /本科/);
    assert.match(profile.educationText, /会计学/);
  });
}

test("an explicit pending-graduation note stays with its own education row", async () => {
  const { profile } = await inspect(`<article><div>2018-2023 宁波大学 · 工商管理 · 本科 尚未取得毕业证</div></article>`);
  assert.match(profile.educationText, /尚未取得毕业证/);
  assert.match(profile.educationText, /工商管理/);
});

test("declared work entries retain nested duties and part-time evidence", async () => {
  const { profile, statuses, months } = await inspect(`<article><div class="work-experience">
    <div class="experience-item"><div>2025.04-至今 测试跨境电商公司 · 财务会计</div>
      <p>负责Amazon平台核算</p><p>兼职</p></div>
  </div></article>`);
  assert.equal(profile.workEntries.length, 1);
  assert.match(profile.workEntries[0].description, /负责Amazon平台核算/);
  assert.equal(profile.workEntries[0].kind, "part-time");
});

test("declared education rows retain nested pending graduation evidence", async () => {
  const { profile, statuses } = await inspect(`<article><div class="education-exp">
    <div class="experience-item"><div>2018-2023 宁波大学 · 会计学 · 本科</div><p>尚未取得毕业证</p></div>
  </div></article>`);
  assert.match(profile.educationText, /尚未取得毕业证/);
});

test("semantic work rows retain a sibling part-time qualifier", async () => {
  const { profile, statuses, months } = await inspect(`<article><section>
    <div>2025.04-2026.11 甲跨境电商公司 · 会计</div><p>兼职</p>
  </section></article>`);
  assert.equal(profile.workEntries.length, 1);
  assert.equal(profile.workEntries[0].kind, "part-time");
  assert.match(profile.workEntries[0].description, /兼职/);
});

test("semantic education rows retain a sibling pending-graduation qualifier", async () => {
  const { profile, statuses } = await inspect(`<article><section>
    <div>2018-2023 宁波大学 · 会计学 · 本科</div><p>尚未取得毕业证</p>
  </section></article>`);
  assert.match(profile.educationText, /尚未取得毕业证/);
});

test("semantic qualifiers do not merge separately dated work rows", async () => {
  const { profile, statuses, months } = await inspect(`<article><section>
    <section><div>2024.01-2025.01 甲跨境电商公司 · 电商运营</div><p>兼职</p></section>
    <section><div>2025.02-2026.02 乙国内科技公司 · 会计</div><p>正式员工</p></section>
  </section></article>`);
  assert.equal(profile.workEntries.length, 2);
  assert.equal(profile.workEntries[0].kind, "part-time");
  assert.equal(profile.workEntries[1].kind, "formal");
  assert.doesNotMatch(profile.workEntries[0].description, /乙国内|会计|正式员工/);
  assert.doesNotMatch(profile.workEntries[1].description, /甲跨境|运营|兼职/);
});

test("an undated neighbouring employer cannot lend its industry to a dated work row", async () => {
  const { profile, statuses } = await inspect(`<article class="candidate-card" data-candidate-id="current">
    <section><section><div>2025.04-2026.11 甲国内科技公司 · 会计</div></section>
      <section><div>乙跨境电商公司 · 电商运营</div></section></section>
    <div data-education>2018-2023 宁波大学 · 会计学 · 本科</div><div data-english>CET-4 500分</div>
    <div data-expected-salary>人民币6500元/月</div><span data-work-history-complete="true"></span>
  </article>`);
  assert.equal(profile.workEntries.length, 1);
  assert.doesNotMatch(profile.workEntries[0].description, /乙跨境/);
});

test("pending education stays with its own dated degree", async () => {
  const { profile, statuses } = await inspect(`<article><section>
    <section><div>2010-2013 测试中学 · 高中</div><p>已毕业</p></section>
    <section><div>2013-2017 测试大学 · 会计学 · 本科</div><p>尚未取得毕业证</p></section>
  </section></article>`);
  assert.match(profile.educationText, /高中/);
  assert.match(profile.educationText, /尚未取得毕业证/);
});

for (const attributes of ['class="geek-card" data-candidate-id="other"', 'class="job-info"']) {
  test(`excluded nested subtree cannot supply a semantic work row: ${attributes}`, async () => {
    const { profile, statuses, months } = await inspect(`<article data-candidate-id="current"><section>
      <div ${attributes}>2025.04-2026.11 外部跨境电商公司 · 会计</div>
    </section></article>`);
    assert.deepEqual(profile.workEntries, []);
    assert.doesNotMatch(profile.text, /外部跨境/);
  });

  test(`excluded subtree is removed from declared evidence ancestors: ${attributes}`, async () => {
    const { profile, statuses } = await inspect(`<article data-candidate-id="current">
      <section data-education><div ${attributes}>2018-2023 外部大学 · 会计学 · 本科</div></section>
      <section class="certificates"><div ${attributes}>CET-4 500分</div></section>
      <section class="expected-salary"><div ${attributes}>人民币6500元/月</div></section>
    </article>`);
    assert.equal(profile.educationText, "");
    assert.doesNotMatch(profile.text, /外部大学|CET-4|6500/);
  });

  test(`excluded subtree cannot reach heading fallbacks or history: ${attributes}`, async () => {
    const { profile, statuses } = await inspect(`<article data-candidate-id="current"><section>
      <div ${attributes}><h3>教育经历</h3><p>本科已毕业，会计学专业</p>
        <h3>语言能力</h3><p>CET-4 500分</p><h3>工作经历</h3><p>完整工作经历</p>
        <p>2025.04-2026.11 外部跨境电商公司 · 会计</p><span data-work-history-complete="true"></span>
      </div>
    </section></article>`);
    assert.equal(profile.educationText, "");
    assert.deepEqual(profile.workEntries, []);
    assert.equal(profile.text, "");
  });

}

test("nested job text cannot lend a finance role or industry to a domestic operator", async () => {
  const { profile, statuses, months } = await inspect(`<article><section>
    2025.01-2026.01 测试国内科技公司<p>电商运营</p><div class="job-info">跨境电商财务会计</div>
  </section></article>`);
  assert.equal(profile.workEntries.length, 1);
  assert.equal(profile.workEntries[0].title, "");
  assert.doesNotMatch(profile.workEntries[0].description, /跨境电商财务会计/);
  assert.doesNotMatch(profile.text, /跨境电商财务会计/);
});

for (const identity of [false, true]) {
  test(`selector-expanded same-person wrappers preserve profile fields (identified=${identity})`, async () => {
    const { profile, statuses, months, roots } = await inspect(`<article id="complete" class="recommend-card-wrap"
      ${identity ? 'data-candidate-id="current"' : ""}>
      <p>完整候选人履历，当前在职，期望月薪6500元，核实教育和正式工作经历</p>
      <section class="geek-card" ${identity ? 'data-geek-id="current"' : ""}>
        <h3>合成候选人</h3><div data-education>2018-2023 测试大学 · 会计学 · 本科</div>
        <div data-work-entry>2025.04-2026.11 测试跨境电商公司 · 会计</div>
        <div data-english>CET-4 500分</div><div class="geek-salary">6-7K</div>
        <span data-work-history-complete="true"></span><button>打招呼</button>
      </section>
    </article>`, () => {}, true);
    assert.deepEqual(roots, ["complete"]);
    assert.deepEqual(statuses, { major: "pass", keyword: "pass" });
    assert.equal(profile.workEntries.length, 1);
  });
}

test("identified foreign roots stay excluded inside a recommendation wrapper", async () => {
  const { profile, statuses } = await inspect(`<article class="recommend-card-wrap" data-candidate-id="current">
    <section><div class="geek-card" data-candidate-id="other">
      <div data-education>2018-2023 外部大学 · 会计学 · 本科</div><div data-english>CET-4 500分</div>
      <div data-work-entry>2025.04-2026.11 外部跨境电商公司 · 会计</div>
      <span data-work-history-complete="true"></span>
    </div></section>
  </article>`);
  assert.equal(profile.text, "");
  assert.deepEqual(profile.workEntries, []);
});

test("ambiguous sibling marker roots are not treated as one candidate", async () => {
  const { profile, statuses } = await inspect(`<article class="recommend-card-wrap">
    <section class="geek-card"><div data-education>2018-2023 外部大学 · 会计学 · 本科</div></section>
    <section class="geek-card"><div data-english>CET-4 500分</div></section>
  </article>`);
  assert.equal(profile.text, "");
});

test("excluded job and foreign subtrees cannot leak into the card text", async () => {
  const { profile, statuses } = await inspect(`<article data-candidate-id="current"><section>
    <div class="job-info">美元月薪</div><div class="geek-card" data-candidate-id="other">年薪</div>
    <span class="geek-salary">6-7K</span>
  </section></article>`);
  assert.doesNotMatch(profile.text, /美元|年薪/);
});

test("keywordText drops the education row so a school name cannot hit a keyword", async () => {
  const { profile } = await inspect(`<article class="candidate-card" data-candidate-id="current">
    <div data-education>2018-09 至 2022-06 广东外语外贸大学 · 会计学 · 本科</div>
    <div data-work-entry>某国内制造公司
会计
2023.01-2025.01
负责日常报销与总账</div>
    <button class="greet">打招呼</button>
  </article>`);
  assert.match(profile.text, /广东外语外贸大学/);
  assert.doesNotMatch(profile.keywordText, /广东外语外贸大学|外贸/);
  assert.match(profile.keywordText, /负责日常报销与总账/);
});

test("a summary card without school or dates still yields education", async () => {
  const { profile, statuses } = await inspect(`<article class="candidate-card" data-candidate-id="p">
    <p>离职 · 本科 · 会计学</p><p>期望 宁波 财务</p><button>打招呼</button></article>`);
  assert.match(profile.educationText, /本科/);
  assert.match(profile.educationText, /会计学/);
  assert.equal(statuses.major, "pass", "学历与专业缺失年份时不能判成“卡片未展示教育经历”");
});

test("job-requirement lines never become education evidence", async () => {
  const { profile, statuses } = await inspect(`<article class="candidate-card" data-candidate-id="p">
    <p>任职要求：本科以上学历</p><p>熟悉亚马逊平台</p><button>打招呼</button></article>`);
  assert.equal(profile.educationText, "");
  assert.equal(statuses.major, "fail");
});

test("keywordText also drops education found by the text fallback", async () => {
  const { profile } = await inspect(`<article class="candidate-card" data-candidate-id="p">
    <p>广东外语外贸大学 会计学 本科</p><p>负责日常报销</p><button>打招呼</button></article>`);
  assert.match(profile.educationText, /广东外语外贸大学/);
  assert.doesNotMatch(profile.keywordText, /外贸/);
});

test("高职 and 研究生 are recognised as education words", async () => {
  const vocational = await inspect(`<article class="candidate-card"><p>高职 · 会计学</p><p>亚马逊运营</p><button>打招呼</button></article>`);
  assert.match(vocational.profile.educationText, /高职/);
  assert.equal(vocational.statuses.major, "pass");

  const postgraduate = await inspect(`<article class="candidate-card"><p>研究生 · 金融学</p><p>亚马逊</p><button>打招呼</button></article>`);
  assert.match(postgraduate.profile.educationText, /研究生/);
  assert.equal(postgraduate.statuses.major, "fail", "研究生金融不是财务专业");
  assert.doesNotMatch(postgraduate.profile.educationText, /亚马逊/, "教育证据不能跨行带出工作内容");
});

test("a school name containing 专科 counts as the associate degree", async () => {
  const { profile, statuses } = await inspect(`<article class="candidate-card"><p>宁波某专科学校 会计</p><p>亚马逊</p><button>打招呼</button></article>`);
  assert.match(profile.educationText, /专科学校/);
  assert.equal(statuses.major, "pass");
});

test("an inline card with no line breaks still yields education", async () => {
  const { profile, statuses } = await inspect(`<article class="candidate-card"><span>在职</span><span>大专</span><span>会计学</span><span>期望宁波财务岗位薪资面议</span><span>亚马逊运营</span><button>打招呼</button></article>`);
  assert.match(profile.educationText, /大专/);
  assert.equal(statuses.major, "pass", "内联拼接不能因为含“期望/岗位”就把学历一起丢掉");
  assert.match(profile.keywordText, /亚马逊/, "扣除教育片段时不能连带删掉同行的工作关键词");
});

test("a name line above the education line does not swallow the degree", async () => {
  // 真实卡片先渲染姓名，再渲染“离职 · 本科 · 会计学”。教育行回退若跨行取窗口，
  // 按换行截断时会把姓名当成教育证据，学历词丢失，所有人都会被判不符合。
  const { profile, statuses } = await inspect(`<article class="card-item"><div class="card-inner">
    <h3>测试候选人甲</h3>
    <p>离职 · 本科 · 会计学 · 已毕业</p>
    <p>2023.01-2025.06 深圳某跨境电商公司 财务会计</p>
    <p>负责亚马逊平台账务核算</p>
    <button class="btn btn-greet">打招呼</button></div></article>`);
  assert.equal(profile.educationText, "离职 · 本科 · 会计学 · 已毕业");
  assert.equal(statuses.major, "pass");
  assert.equal(statuses.keyword, "pass");
});

test("a degree and its major on separate lines are still joined", async () => {
  const { profile, statuses } = await inspect(`<article class="candidate-card">
    <h3>测试候选人乙</h3>
    <p>本科</p><p>会计学</p><p>负责亚马逊平台账务核算</p><button>打招呼</button></article>`);
  assert.equal(statuses.major, "pass", profile.educationText);
});

test("a degree line followed by a job title does not invent a major", async () => {
  const { statuses } = await inspect(`<article class="candidate-card">
    <h3>测试候选人丙</h3>
    <p>本科</p><p>财务会计</p><p>负责日常报销</p><button>打招呼</button></article>`);
  assert.equal(statuses.major, "fail", "职位名不能被当成专业");
});
