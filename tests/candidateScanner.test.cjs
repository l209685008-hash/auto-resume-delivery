"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function element() {
  return {
    style: {}, dataset: {}, children: [], setAttribute() {}, addEventListener() {}, remove() {},
    append(...children) { this.children.push(...children); },
    querySelector(selector) { return this.children.find((child) => selector.includes(`'${child.dataset.field}'`)); }
  };
}

function setup({ outcomes = ["reject"], batchSize = 137, auditFailure = "" } = {}) {
  const requests = [];
  const records = [];
  const extracted = [];
  const evaluated = [];
  const snapshots = [];
  let page = 0;
  let runNumber = 0;
  const document = { body: {}, documentElement: element(), createElement: element, querySelectorAll: () => [] };
  const cards = Array.from({ length: 137 }, (_, index) => ({
    id: `person-${index + 1}`, outcome: outcomes[index % outcomes.length], isConnected: true,
    parentElement: document.body,
    querySelector: () => ({ textContent: `Person ${index + 1}` })
  }));
  const visibleCards = () => cards.slice(page * batchSize, (page + 1) * batchSize);
  const window = {
    scrollBy() { page += 1; },
    BossGreetingSelectors: {
      getCandidateCards: visibleCards, getCurrentJobText: () => "cross-border finance",
      getPageText: () => "", getPageDiagnostics: () => ({ candidateCount: visibleCards().length }),
      normalizeText: (value) => value.trim(), visible: () => true,
      candidateIdentity: (card) => card.id, candidateAliases: (card) => [card.id]
    },
    BossFinanceProfile: { extract(card) {
      extracted.push(card.id);
      if (card.outcome === "reject") return { educationText: "高中毕业" };
      return {
        educationText: "本科毕业，会计学专业",
        workEntries: [{ company: "甲公司", title: "财务会计", description: "负责Amazon账务核算",
          start: "2025-01", end: "2026-01" }]
      };
    } },
    BossCandidateIdentity: {},
    BossGreetingAudit: {
      uuid: () => `scan-run-${++runNumber}`,
      async audit(runId, type, payload) {
        if (type === auditFailure) throw new Error("QUOTA_BYTES quota exceeded");
        records.push(structuredClone({ runId, type, payload }));
      }
    }
  };
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(payload, callback) {
        requests.push(structuredClone(payload));
        assert.ok(["BGA_CLAIM_RUN", "BGA_VALIDATE_RUN", "BGA_RELEASE_RUN"].includes(payload.type),
          `unexpected send-side request: ${payload.type}`);
        callback({ ok: true, jobText: "cross-border finance" });
      }
    },
    storage: { local: { set(value) { snapshots.push(structuredClone(value.bossGreetingState)); } } }
  };
  const context = vm.createContext({ window, document, chrome, innerHeight: 900,
    location: { hostname: "www.zhipin.com", href: "https://www.zhipin.com/synthetic" } });
  for (const name of ["safetyGuards", "financeRules", "candidateScanner"]) {
    vm.runInContext(readFileSync(path.join(__dirname, `../src/content/${name}.js`), "utf8"), context);
    if (name === "financeRules") {
      const rules = context.BossFinanceRules;
      window.BossFinanceRules = { ...rules, evaluate(profile) {
        const result = rules.evaluate(profile, new Date("2026-11-07T04:00:00Z"));
        evaluated.push(result.outcome);
        return result;
      } };
    }
  }
  window.BossGreetingSafety.sleep = async () => {};
  return {
    requests, records, extracted, evaluated, snapshots,
    async run(config = {}) {
      page = 0;
      const reply = await window.BossGreetingAssistantHandleMessage({ type: "BGA_START", config });
      assert.equal(reply.ok, true);
      for (let tick = 0; tick < 20; tick += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        const { state } = await window.BossGreetingAssistantHandleMessage({ type: "BGA_STATE" });
        if (!state.running && requests.at(-1)?.type === "BGA_RELEASE_RUN") return state;
      }
      assert.fail("runner did not stop and release ownership");
    }
  };
}

function assertScanLimit(app, state, limit) {
  assert.equal(state.processedCount, limit);
  assert.equal(app.extracted.length, limit, "no candidate beyond the cap is even extracted");
  assert.equal(app.evaluated.length, limit);
  assert.equal(state.rejectedCount, limit);
  assert.equal(state.eligibleCount, 0);
  assert.equal(state.greetedCount, 0);
  assert.equal(state.clickAttemptCount, 0);
  assert.equal(state.status, "scan_limit_reached");
  assert.equal(state.lastMessage, `已达到本次扫描人数上限（${limit} 人）`);
  assert.ok(app.snapshots.every((state) => state.processedCount <= limit));
  assert.equal(app.records.filter((record) => record.type === "CANDIDATE_EVALUATED").length, limit);
  const stopped = app.records.find((record) => record.type === "RUN_STOPPED");
  assert.equal(stopped.payload.status, state.status);
  assert.equal(stopped.payload.reason, state.lastMessage);
  assert.equal(app.requests.filter((request) => /PREPARE_ATTEMPT|TRUSTED_CLICK|FINISH_ATTEMPT/.test(request.type)).length, 0);
}

for (const dryRun of [true, false]) {
  test(`legacy config stops at 100 scans with all rejects, dryRun=${dryRun}`, async () => {
    const app = setup({ outcomes: ["reject"] });
    const state = await app.run({ dryRun, maxGreetings: 60 });
    assertScanLimit(app, state, 100);
    assert.equal(state.rejectedCount, 100);
  });
  test(`lower scan cap applies across reject batches, dryRun=${dryRun}`, async () => {
    const app = setup({ outcomes: ["reject"], batchSize: 7 });
    assertScanLimit(app, await app.run({ dryRun, maxCandidates: 13, maxGreetings: 1 }), 13);
  });
  test(`raw scan cap above 100 cannot bypass the hard limit, dryRun=${dryRun}`, async () => {
    const app = setup({ outcomes: ["reject"], batchSize: 37 });
    assertScanLimit(app, await app.run({ dryRun, maxCandidates: 1000, maxGreetings: 60 }), 100);
  });
}

test("a fresh run gets its own scan budget", async () => {
  const app = setup();
  const first = await app.run({ maxCandidates: 5 });
  const second = await app.run({ maxCandidates: 5 });
  assert.equal(first.processedCount, 5);
  assert.equal(second.processedCount, 5);
  assert.notEqual(first.runId, second.runId);
  assert.equal(app.extracted.length, 10);
  assert.equal(second.status, "scan_limit_reached");
});

test("scan-only mode uses the scan cap even when every candidate matches", async () => {
  const app = setup({ outcomes: ["match"] });
  const state = await app.run({ dryRun: true, maxCandidates: 100, maxGreetings: 3 });
  assert.equal(state.processedCount, 100);
  assert.equal(state.dryRunMatches, 100);
  assert.equal(state.status, "scan_limit_reached");
  assert.equal(state.clickAttemptCount, 0);
  assert.equal(state.greetedCount, 0);
});

test("an audit write failure is recorded but never stops the scan", async () => {
  const app = setup({ outcomes: ["reject"], batchSize: 7, auditFailure: "CANDIDATE_EVALUATED" });
  const state = await app.run({ maxCandidates: 5 });
  assert.equal(state.processedCount, 5);
  assert.equal(state.status, "scan_limit_reached");
  assert.match(state.lastFailureReason, /审计写入失败/);
  assert.equal(app.records.filter((record) => record.type === "CANDIDATE_EVALUATED").length, 0);
  assert.equal(app.requests.at(-1).type, "BGA_RELEASE_RUN");
});
