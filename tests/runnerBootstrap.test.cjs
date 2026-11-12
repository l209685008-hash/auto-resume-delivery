const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const source = readFileSync(path.resolve(__dirname, "../src/content/candidateScanner.js"), "utf8");

function setup() {
  const listeners = [];
  let failRegistration = false;
  const selectors = { getPageDiagnostics: () => ({ candidateCount: 1 }), getCurrentJobText: () => "跨境电商财务" };
  const window = {
    BossGreetingSelectors: selectors,
    BossGreetingSafety: { normalizeConfig() {} },
    BossFinanceRules: { PROFILE: { id: "cross_border_finance", version: "test" }, evaluate() {} },
    BossGreetingAudit: { uuid() {}, audit() {} },
    BossFinanceProfile: { extract() {} },
    BossCandidateIdentity: { aliases() {} }
  };
  const chrome = { runtime: { onMessage: { addListener(listener) {
    if (failRegistration) { failRegistration = false; throw new Error("synthetic registration failure"); }
    listeners.push(listener);
  } } } };
  const context = vm.createContext({ window, chrome, Set });
  return { window, selectors, listeners,
    run: () => vm.runInContext(source, context),
    failNextRegistration: () => { failRegistration = true; },
    state: () => new Promise((resolve) => listeners.at(-1)({ type: "BGA_STATE" }, {}, resolve)) };
}

test("missing dependencies cannot poison a later complete runner injection", async () => {
  const app = setup();
  delete app.window.BossGreetingSelectors;
  try { app.run(); } catch (_) { /* A partial bundle cannot install a healthy runner. */ }
  assert.notEqual(app.window.BossFinanceRunnerInstalled, true);
  app.window.BossGreetingSelectors = app.selectors;
  app.run();
  assert.equal(app.listeners.length, 1);
  assert.equal((await app.state()).ok, true);
});

test("failed listener registration leaves reinjection available", async () => {
  const app = setup();
  app.failNextRegistration();
  assert.throws(() => app.run(), /synthetic registration failure/);
  assert.notEqual(app.window.BossFinanceRunnerInstalled, true);
  assert.equal(app.window.BossGreetingAssistantHandleMessage, undefined);
  app.run();
  assert.equal(app.listeners.length, 1);
  assert.equal((await app.state()).ok, true);
});

test("a healthy runner injection remains idempotent", async () => {
  const app = setup();
  app.run();
  const handle = app.window.BossGreetingAssistantHandleMessage;
  app.run();
  assert.equal(app.listeners.length, 1);
  assert.equal(app.window.BossGreetingAssistantHandleMessage, handle);
  assert.equal((await app.state()).state.frameReady, true);
});

for (const jobStatus of ["selected", "missing", "ambiguous"]) {
  test(`page context preserves the selector's ${jobStatus} job status`, async () => {
    const app = setup();
    const context = { currentJobText: jobStatus === "selected" ? "跨境电商财务" : "", jobStatus };
    app.selectors.getCurrentJobContext = () => context;
    app.run();
    const response = await app.window.BossGreetingAssistantHandleMessage({ type: "BGA_PAGE_CONTEXT" });
    assert.equal(response.ok, true);
    assert.deepEqual(response.context, context);
  });
}

test("page context remains compatible with selectors exposing only job text", async () => {
  const app = setup();
  app.run();
  const response = await app.window.BossGreetingAssistantHandleMessage({ type: "BGA_PAGE_CONTEXT" });
  assert.equal(response.ok, true);
  assert.equal(response.context.currentJobText, "跨境电商财务");
  assert.equal(response.context.jobStatus, undefined);
});
