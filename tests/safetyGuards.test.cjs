"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const window = {};
vm.runInNewContext(readFileSync(path.join(__dirname, "../src/content/safetyGuards.js"), "utf8"), { window });
const { normalizeConfig } = window.BossGreetingSafety;

test("old settings without a scan cap default to 100 and retain their greeting cap", () => {
  for (const settings of [undefined, {}, { maxGreetings: 60, dryRun: false }]) {
    const normalized = normalizeConfig(settings);
    assert.equal(normalized.maxCandidates, 100);
    assert.equal(normalized.maxGreetings, settings?.maxGreetings ?? 30);
  }
});

for (const [value, expected] of [[1000, 100], [101, 100], [100, 100], [13, 13], [13.9, 13],
  ["17", 17], [1, 1], [0, 1], [-5, 1], [undefined, 100], [null, 100], ["", 100],
  ["invalid", 100], [NaN, 100], [Infinity, 100]]) {
  test(`scan cap normalizes ${String(value)} to ${expected}`, () => {
    const config = normalizeConfig({ maxCandidates: value, maxGreetings: 1000 });
    assert.equal(config.maxCandidates, expected);
    assert.equal(config.maxGreetings, 60, "greeting attempts keep their separate hard cap");
    assert.equal(config.minDelayMs, 2000);
    assert.equal(config.maxDelayMs, 5000);
  });
}
