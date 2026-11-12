const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseWorkEntry, parseWorkText } = require("../src/content/profileExtractor.js");

test("extract a single dated personal work record", () => {
  const work = parseWorkEntry("深圳测试跨境公司\n财务会计\n2025.05-2026.11\n负责Amazon平台核算与报税");
  assert.equal(work.company, "深圳测试跨境公司");
  assert.equal(work.start, "2025-05");
  assert.equal(work.end, "2026-11");
  assert.match(work.description, /Amazon/);
});

test("flat multiple jobs never combine adjacent industry and duties", () => {
  const entries = parseWorkText("工作经历\n电商公司\n2025.01-2025.06\n跨境电商运营\n会计公司\n2025.07-至今\n会计核算");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].start, "");
  assert.equal(entries[0].end, "");
});

test("an undated work claim is preserved as incomplete instead of dropped", () => {
  const work = parseWorkEntry("跨境财务工作两年");
  assert.equal(work.start, "");
  assert.equal(work.end, "");
  assert.equal(work.description, "跨境财务工作两年");
});

test("a structured row containing two dates cannot mix the jobs", () => {
  const row = parseWorkEntry("甲公司 Amazon运营 2024.01-2025.01 乙公司 国内会计 2025.02-2026.02");
  assert.equal(row.start, "");
  assert.equal(row.end, "");
});

test("part-time and internships are classified independently of the date line", () => {
  const work = "甲公司\n会计\n2025.01-2026.01\n兼职\n负责Amazon核算";
  assert.equal(parseWorkEntry(work).kind, "part-time");
  assert.equal(parseWorkEntry(work.replace("兼职", "实习")).kind, "internship");
});

test("finance in the employer name does not turn an operator into an accountant", () => {
  const work = parseWorkEntry("测试跨境财务公司\n电商运营\n2025.01-2026.01\n负责Amazon推广运营");
  assert.equal(work.title, "");
});

test("compact dated work rows preserve explicit company and title fields", () => {
  const work = parseWorkEntry("2025.04-至今 六相网络科技 · 会计");
  assert.equal(work.company, "六相网络科技");
  assert.equal(work.title, "会计");
  assert.equal(work.start, "2025-04");
  assert.equal(work.end, "至今");
});

test("separately dated complete text rows stay separate", () => {
  const entries = parseWorkText("2024.01-2025.01 甲跨境电商公司 · 电商运营\n2025.02-2026.02 乙国内科技公司 · 会计");
  assert.equal(entries.length, 2);
  assert.equal(entries[0].company, "甲跨境电商公司");
  assert.equal(entries[1].company, "乙国内科技公司");
  assert.doesNotMatch(entries[0].description, /乙国内|会计/);
  assert.doesNotMatch(entries[1].description, /甲跨境|运营/);
});
