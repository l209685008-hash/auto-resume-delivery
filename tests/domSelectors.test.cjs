const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const path = require("node:path");

let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser.close(); });

async function inspect(control, extra = "", read = () => {
  const cards = BossGreetingSelectors.getCandidateCards();
  return { count: cards.length, tag: cards.length ? BossGreetingSelectors.findGreetButton(cards[0])?.tagName : null };
}) {
  return inspectMarkup(`<article class="candidate-card" data-candidate-id="test-person"><h3>合成候选人</h3><p>本科已毕业，曾在跨境电商公司负责财务核算，期望月薪6500元</p>${control}${extra}</article>`, read);
}

async function inspectMarkup(markup, read) {
  const page = await browser.newPage();
  try {
    await page.setContent(markup);
    await page.addScriptTag({ path: path.resolve(__dirname, "../src/content/candidateIdentity.js") });
    await page.addScriptTag({ path: path.resolve(__dirname, "../src/content/domSelectors.js") });
    return await page.evaluate(read);
  } finally { await page.close(); }
}

for (const [name, markup] of [
  ["input value", '<div class="job-select"><input readonly value="跨境电商会计-双休朝九晚六_宁波 6-7K"></div>'],
  ["native selected option", '<div class="job-select"><select><option>国内运营</option><option selected>跨境电商会计-双休朝九晚六_宁波 6-7K</option></select></div>'],
  ["dropdown selection label", '<div class="job-select"><div class="ui-dropmenu-label">跨境电商会计-双休朝九晚六_宁波 6-7K</div><ul role="listbox"><li role="option">国内运营</li></ul></div>']
]) {
  test(`selected job reads ${name} without unselected options`, async () => {
    assert.equal(await inspectMarkup(markup, () => BossGreetingSelectors.getCurrentJobText()), "跨境电商会计-双休朝九晚六_宁波 6-7K");
  });
}

test("selected job ignores placeholder, hidden controls and candidate expectations", async () => {
  assert.equal(await inspectMarkup('<div class="job-select"><input placeholder="跨境电商会计"></div><div class="job-select" hidden><input value="跨境电商会计"></div><article class="candidate-card"><p>期望 跨境电商会计</p></article>',
    () => BossGreetingSelectors.getCurrentJobText()), "");
});

test("an editable job search does not prove that a job was selected", async () => {
  assert.equal(await inspectMarkup('<div class="job-select"><input value="跨境电商会计" role="combobox" aria-autocomplete="list"></div>',
    () => BossGreetingSelectors.getCurrentJobText()), "");
});

test("contenteditable combobox text does not prove a selected job", async () => {
  assert.deepEqual(await inspectMarkup('<div class="job-select"><div role="combobox" contenteditable="true"><span class="label">跨境电商会计</span></div></div>',
    () => BossGreetingSelectors.getCurrentJobContext()), { currentJobText: "", jobStatus: "missing" });
});

test("conflicting selected job widgets remain unconfirmed", async () => {
  assert.deepEqual(await inspectMarkup('<div class="job-select"><input readonly value="跨境电商会计"></div><div data-current-job>国内财务</div>',
    () => ({ ...BossGreetingSelectors.getCurrentJobContext(), text: BossGreetingSelectors.getCurrentJobText() })),
  { currentJobText: "", jobStatus: "ambiguous", text: "" });
});

test("one greeting action inside a btn wrapper is one candidate", async () => {
  assert.deepEqual(await inspect('<div class="btns"><button class="btn greet">打招呼</button></div>'), { count: 1, tag: "BUTTON" });
});

test("a btn label inside an anchor does not become a second greeting", async () => {
  assert.deepEqual(await inspect('<a class="btn" href="javascript:;"><span class="btn-label">打招呼</span></a>'), { count: 1, tag: "A" });
});

test("hidden responsive greeting copies do not hide the visible candidate", async () => {
  assert.deepEqual(await inspect('<button>打招呼</button>', '<button style="display:none">打招呼</button>'), { count: 1, tag: "BUTTON" });
});

test("a greeting under a transparent ancestor is neither visible nor clickable", async () => {
  const result = await inspect('<div style="opacity:0"><div><button>打招呼</button></div></div>', "", () => {
    const card = document.querySelector(".candidate-card");
    const button = card.querySelector("button");
    const rect = button.getBoundingClientRect();
    return {
      positiveRect: rect.width > 0 && rect.height > 0,
      ownOpacity: getComputedStyle(button).opacity,
      visible: BossGreetingSelectors.visible(button),
      inViewport: BossGreetingSelectors.inViewport(button),
      clickable: BossGreetingSelectors.topClickable(button),
      selected: Boolean(BossGreetingSelectors.findGreetButton(card)),
      count: BossGreetingSelectors.getCandidateCards().length,
      greetControlCount: BossGreetingSelectors.getPageDiagnostics().greetControlCount
    };
  });
  assert.deepEqual(result, {
    positiveRect: true, ownOpacity: "1", visible: false, inViewport: false,
    clickable: false, selected: false, count: 0, greetControlCount: 0
  });
});

for (const [name, copy] of [
  ["transparent control", '<button style="opacity:0">打招呼</button>'],
  ["transparent parent", '<div style="opacity:0"><button>打招呼</button></div>'],
  ["transparent grandparent", '<div style="opacity:0"><div class="btns"><button><span class="btn-label">打招呼</span></button></div></div>'],
  ["hidden parent", '<div style="visibility:hidden"><button>打招呼</button></div>'],
  ["undisplayed parent", '<div style="display:none"><button>打招呼</button></div>']
]) {
  test(`${name} copies do not hide the visible candidate`, async () => {
    assert.deepEqual(await inspect('<button>打招呼</button>', copy), { count: 1, tag: "BUTTON" });
  });
}

test("a partially transparent ancestor retains its active greeting", async () => {
  assert.deepEqual(await inspect('<div style="opacity:0.5"><button>打招呼</button></div>'), { count: 1, tag: "BUTTON" });
});

for (const [name, copy] of [
  ["native disabled button", '<button disabled>打招呼</button>'],
  ["ARIA-disabled button", '<button aria-disabled="true">打招呼</button>'],
  ["disabled fieldset", '<fieldset disabled><button>打招呼</button></fieldset>'],
  ["ARIA-disabled ancestor", '<div aria-disabled="true"><button>打招呼</button></div>'],
  ["wrapped disabled action", '<div class="btns"><button disabled><span class="btn-label">打招呼</span></button></div>'],
  ["ARIA-disabled anchor", '<a href="#" aria-disabled="true">打招呼</a>']
]) {
  test(`${name} is excluded from new greeting discovery`, async () => {
    assert.deepEqual(await inspect(copy), { count: 0, tag: null });
    assert.deepEqual(await inspect('<button>打招呼</button>', copy), { count: 1, tag: "BUTTON" });
  });
}

test("diagnostics count only enabled new greetings", async () => {
  const result = await inspect('<button>打招呼</button><div class="btns"><button disabled>打招呼</button></div>', "", () => {
    const diagnostics = BossGreetingSelectors.getPageDiagnostics();
    return { candidates: diagnostics.candidateCount, greetings: diagnostics.greetControlCount, samples: diagnostics.actionSamples.length };
  });
  assert.deepEqual(result, { candidates: 1, greetings: 1, samples: 1 });
});

test("two separate active greeting actions are not silently merged", async () => {
  assert.equal((await inspect('<button>打招呼</button><button>打招呼</button>')).count, 0);
});

test("two active actions remain ambiguous beside disabled and hidden copies", async () => {
  assert.equal((await inspect('<button>打招呼</button><a href="#">立即沟通</a>',
    '<button disabled>打招呼</button><div style="opacity:0"><button>打招呼</button></div>')).count, 0);
});

test("an already greeted action cannot become a new greeting", async () => {
  assert.equal((await inspect('<button>继续沟通</button>')).count, 0);
});

test("disabled already-greeted status remains available for confirmation diagnostics", async () => {
  const result = await inspect('<div class="btns"><button disabled><span class="btn-label">已打招呼</span></button></div>', "", () => {
    const card = document.querySelector(".candidate-card");
    const button = card.querySelector("button");
    const diagnostics = BossGreetingSelectors.getPageDiagnostics();
    return {
      greeted: BossGreetingSelectors.isGreetedText(button.textContent),
      selected: Boolean(BossGreetingSelectors.findGreetButton(card)),
      candidates: diagnostics.candidateCount,
      greetings: diagnostics.greetControlCount,
      greetedControls: diagnostics.greetedControlCount
    };
  });
  assert.deepEqual(result, { greeted: true, selected: false, candidates: 0, greetings: 0, greetedControls: 1 });
});

for (const [marker, attributes] of [
  ["candidate class", () => 'class="candidate-card"'],
  ["geek class", () => 'class="geek-card"'],
  ["recommendation class", () => 'class="recommend-card-wrap"'],
  ["list item", () => 'class="card-item"'],
  ["candidate data", (id) => `data-candidate-id="${id}"`],
  ["geek data", (id) => `data-geek-id="${id}"`]
]) {
  for (const [state, control] of [
    ["disabled", '<button disabled>打招呼</button>'],
    ["already greeted", '<button>继续沟通</button>']
  ]) {
    test(`a shared wrapper seed keeps ${marker} candidates separate when the sibling is ${state}`, async () => {
      const result = await inspectMarkup(`<div id="shared" class="recommend-card-wrap card-list">
        <article id="candidate-a" ${attributes("person-a")}><h3>Candidate A</h3>
          <p>本科已毕业，曾在跨境电商公司负责财务核算，期望月薪6500元</p>
          <a href="https://www.zhipin.com/geek/resume/a">Resume A</a><button id="greet-a">打招呼</button>
        </article>
        <article id="candidate-b" ${attributes("person-b")}><h3>Candidate B</h3>
          <p>OTHER-RESUME 本科已毕业，曾在其他公司负责财务分析，期望月薪9000元</p>
          <a href="https://www.zhipin.com/geek/resume/b">Resume B</a>${control}
        </article>
      </div>`, () => {
        const cards = BossGreetingSelectors.getCandidateCards();
        return {
          roots: cards.map((card) => card.id),
          profiles: cards.map((card) => BossGreetingSelectors.findProfileUrl(card)),
          actions: cards.map((card) => BossGreetingSelectors.findGreetButton(card)?.id),
          mixedResume: cards.some((card) => card.textContent.includes("OTHER-RESUME")),
          diagnostics: BossGreetingSelectors.getPageDiagnostics().candidateCount
        };
      });
      assert.deepEqual(result, {
        roots: ["candidate-a"], profiles: ["https://www.zhipin.com/geek/resume/a"],
        actions: ["greet-a"], mixedResume: false, diagnostics: 1
      });
    });
  }
}

test("nested explicit wrappers for one candidate still expand to the complete candidate", async () => {
  const result = await inspectMarkup(`<article id="complete" class="recommend-card-wrap" data-candidate-id="same-person">
    <p>完整候选人履历，本科已毕业，期望月薪6500元</p>
    <section class="candidate-card" data-geek-id="same-person"><div class="card-list"><div class="card-item">
      <div class="geek-card"><h3>合成候选人</h3><p>本科已毕业，曾在跨境电商公司负责财务核算，期望月薪6500元</p>
        <button>打招呼</button>
      </div>
    </div></div></section>
  </article>`, () => {
    const cards = BossGreetingSelectors.getCandidateCards();
    return { roots: cards.map((card) => card.id), diagnostics: BossGreetingSelectors.getPageDiagnostics().candidateCount };
  });
  assert.deepEqual(result, { roots: ["complete"], diagnostics: 1 });
});

test("candidate grouping is refreshed when independent roots are added and removed", async () => {
  const result = await inspectMarkup(`<div id="shared" class="recommend-card-wrap">
    <p>完整候选人履历</p><article id="candidate-a" class="candidate-card">
      <p>本科已毕业，曾在跨境电商公司负责财务核算，期望月薪6500元</p><button>打招呼</button>
    </article>
  </div>`, () => {
    const wrapper = document.querySelector("#shared");
    const states = [];
    function snapshot() {
      states.push({
        roots: BossGreetingSelectors.getCandidateCards().map((card) => card.id),
        diagnostics: BossGreetingSelectors.getPageDiagnostics().candidateCount
      });
    }
    snapshot();
    const sibling = document.querySelector("#candidate-a").cloneNode(true);
    sibling.id = "candidate-b";
    sibling.querySelector("button").disabled = true;
    wrapper.append(sibling);
    snapshot();
    sibling.remove();
    snapshot();
    return states;
  });
  assert.deepEqual(result, [
    { roots: ["shared"], diagnostics: 1 },
    { roots: ["candidate-a"], diagnostics: 1 },
    { roots: ["shared"], diagnostics: 1 }
  ]);
});

test("dense candidate discovery and diagnostics keep DOM work linear", async (t) => {
  const measurements = await inspect('<div class="btns"><button class="btn">打招呼</button></div>', "", () => {
    const template = document.querySelector(".candidate-card").cloneNode(true);
    const list = document.createElement("main");
    list.className = "recommend-list";
    document.body.replaceChildren(list);
    const results = [];
    for (const size of [30, 150]) {
      list.replaceChildren(...Array.from({ length: size }, (_, index) => {
        const card = template.cloneNode(true);
        card.dataset.candidateId = "dense-" + index;
        return card;
      }));
      for (const method of ["getCandidateCards", "getPageDiagnostics"]) {
        const work = { queries: 0, queryWork: 0, styles: 0, rects: 0, contains: 0, matches: 0 };
        const restores = [];
        function instrument(target, name, counter, countResults = false) {
          const original = target[name];
          target[name] = function (...args) {
            work[counter] += 1;
            const result = original.apply(this, args);
            if (countResults) work.queryWork += result.length + 1;
            return result;
          };
          restores.push(() => { target[name] = original; });
        }
        instrument(Document.prototype, "querySelectorAll", "queries", true);
        instrument(Element.prototype, "querySelectorAll", "queries", true);
        instrument(window, "getComputedStyle", "styles");
        instrument(Element.prototype, "getBoundingClientRect", "rects");
        instrument(Node.prototype, "contains", "contains");
        instrument(Element.prototype, "matches", "matches");
        try {
          const start = performance.now();
          const result = BossGreetingSelectors[method]();
          results.push({
            size, method, work, durationMs: performance.now() - start,
            count: method === "getCandidateCards" ? result.length : result.candidateCount,
            unique: method === "getCandidateCards" ? new Set(result).size : result.greetControlCount
          });
        } finally {
          restores.reverse().forEach((restore) => restore());
        }
      }
    }
    return results;
  });
  t.diagnostic(JSON.stringify(measurements));
  for (const measurement of measurements) {
    assert.equal(measurement.count, measurement.size);
    assert.equal(measurement.unique, measurement.size);
  }
  for (const method of ["getCandidateCards", "getPageDiagnostics"]) {
    const small = measurements.find((result) => result.method === method && result.size === 30);
    const large = measurements.find((result) => result.method === method && result.size === 150);
    for (const counter of Object.keys(small.work)) {
      assert.ok(large.work[counter] <= Math.max(1, small.work[counter]) * 6,
        `${method} ${counter} grew faster than card count: ${small.work[counter]} -> ${large.work[counter]}`);
    }
  }
});

test("discovery observes DOM and control mutations immediately between synchronous calls", async () => {
  const result = await inspect('<div class="btns"><button class="btn">打招呼</button></div>', "", () => {
    const card = document.querySelector(".candidate-card");
    const wrapper = card.querySelector(".btns");
    const button = card.querySelector("button");
    const states = [];
    function snapshot() {
      const diagnostics = BossGreetingSelectors.getPageDiagnostics();
      states.push({
        cards: BossGreetingSelectors.getCandidateCards().length,
        selected: Boolean(BossGreetingSelectors.findGreetButton(card)),
        greetings: diagnostics.greetControlCount, greeted: diagnostics.greetedControlCount
      });
    }
    snapshot();
    wrapper.style.opacity = "0";
    snapshot();
    wrapper.style.opacity = "1";
    button.disabled = true;
    snapshot();
    button.textContent = "已打招呼";
    snapshot();
    button.textContent = "立即沟通";
    button.disabled = false;
    snapshot();
    const second = button.cloneNode(true);
    wrapper.append(second);
    snapshot();
    second.remove();
    snapshot();
    const anotherCard = card.cloneNode(true);
    document.body.append(anotherCard);
    snapshot();
    anotherCard.remove();
    snapshot();
    return states;
  });
  const active = { cards: 1, selected: true, greetings: 1, greeted: 0 };
  const inactive = { cards: 0, selected: false, greetings: 0, greeted: 0 };
  assert.deepEqual(result, [active, inactive, inactive,
    { ...inactive, greeted: 1 }, active,
    { cards: 0, selected: true, greetings: 2, greeted: 0 }, active,
    { cards: 2, selected: true, greetings: 2, greeted: 0 }, active]);
});

test("the real recommend list structure is recognised: li.card-item + .card-inner + btn-greet", async () => {
  const result = await inspectMarkup(`
    <ul class="card-list">
      <li class="card-item">
        <div class="card-inner" data-geekid="abc123def">
          <h3>合成候选人</h3>
          <p>本科已毕业，曾在跨境电商公司负责财务核算</p>
          <button class="btn btn-greet">打招呼</button>
        </div>
      </li>
    </ul>`, () => {
    const cards = BossGreetingSelectors.getCandidateCards();
    return {
      count: cards.length,
      containsListItem: cards.some((card) => card.matches("li.card-item") || card.querySelector(".card-inner")),
      identity: cards[0] ? BossGreetingSelectors.candidateIdentity(cards[0]) : "",
      button: cards[0] ? BossGreetingSelectors.findGreetButton(cards[0])?.textContent : null
    };
  });
  assert.equal(result.count, 1);
  assert.equal(result.containsListItem, true);
  assert.equal(result.identity, "id:abc123def", "data-geekid must be read as the candidate identity");
  assert.equal(result.button, "打招呼");
});

test("data-geek is also accepted as the candidate identity", async () => {
  const identity = await inspectMarkup(
    `<article class="candidate-card" data-geek="geek-77"><h3>合成候选人</h3><p>本科已毕业，曾在跨境电商公司负责财务核算</p><button>打招呼</button></article>`,
    () => BossGreetingSelectors.candidateIdentity(BossGreetingSelectors.getCandidateCards()[0]));
  assert.equal(identity, "id:geek-77");
});

for (const label of ["继续沟通", "已打招呼", "沟通中", "继续聊", "已联系", "沟通过 3 次", "已沟通"]) {
  test(`already-contacted label is recognised after the click rewrites text and class: ${label}`, async () => {
    // 真实页面点完后按钮文案与类名都会变，所以先按“可打招呼”取到卡片，再改写按钮模拟点击结果。
    const result = await inspectMarkup(
      `<article class="candidate-card" data-candidate-id="p"><h3>合成候选人</h3>
        <p>本科已毕业，曾在跨境电商公司负责财务核算，期望月薪6500元</p>
        <button class="btn-greet" data-final="${label}">打招呼</button></article>`, () => {
        const card = BossGreetingSelectors.getCandidateCards()[0];
        const button = BossGreetingSelectors.findGreetButton(card);
        const before = Boolean(button);
        button.textContent = button.dataset.final;
        button.className = "btn-changed";
        return {
          before,
          greeted: Boolean(BossGreetingSelectors.findGreetedControl(card)),
          greetAfter: Boolean(BossGreetingSelectors.findGreetButton(card))
        };
      });
    assert.equal(result.before, true);
    assert.equal(result.greeted, true, "a contacted candidate must be detected even after the node is rewritten");
    assert.equal(result.greetAfter, false, "a contacted candidate must never offer a greet action");
  });
}

test("a card whose only education word is 高职 is still recognised", async () => {
  const count = await inspectMarkup(`<ul class="card-list"><li class="card-item"><div class="card-inner">
    <h3>合成候选人</h3><p>高职 · 会计学 · 已毕业 · 现居宁波 · 期望财务岗位</p>
    <button class="btn btn-greet">打招呼</button></div></li></ul>`,
    () => BossGreetingSelectors.getCandidateCards().length);
  assert.equal(count, 1, "卡片识别关键字必须覆盖高职/专科等学历词");
});

test("a greet button rewritten to 立即沟通 counts as sent only when it started as 打招呼", async () => {
  const result = await inspectMarkup(
    `<article class="candidate-card" data-candidate-id="p"><h3>合成候选人</h3>
      <p>本科已毕业，曾在跨境电商公司负责财务核算，期望月薪6500元</p>
      <button class="btn btn-greet" data-final="立即沟通">打招呼</button></article>`, () => {
      const card = BossGreetingSelectors.getCandidateCards()[0];
      const button = BossGreetingSelectors.findGreetButton(card);
      const original = BossGreetingSelectors.normalizeText(button.textContent);
      button.textContent = button.dataset.final;
      return {
        original,
        converted: Boolean(BossGreetingSelectors.findConvertedControl(card, original)),
        greeted: Boolean(BossGreetingSelectors.findGreetedControl(card))
      };
    });
  assert.equal(result.original, "打招呼");
  assert.equal(result.converted, true, "从打招呼变成立即沟通必须算已发送");
  assert.equal(result.greeted, false, "这不是“已沟通”文案，仍要走转换判定");
});

test("an initial 立即沟通 button is never mistaken for a sent greeting", async () => {
  const result = await inspectMarkup(
    `<article class="candidate-card" data-candidate-id="p"><h3>合成候选人</h3>
      <p>本科已毕业，曾在跨境电商公司负责财务核算，期望月薪6500元</p>
      <button class="btn btn-greet">立即沟通</button></article>`, () => {
      const card = BossGreetingSelectors.getCandidateCards()[0];
      const button = BossGreetingSelectors.findGreetButton(card);
      const original = BossGreetingSelectors.normalizeText(button.textContent);
      return { original, converted: Boolean(BossGreetingSelectors.findConvertedControl(card, original)) };
    });
  assert.equal(result.original, "立即沟通");
  assert.equal(result.converted, false, "初始就是立即沟通时不能当作已发送");
});
