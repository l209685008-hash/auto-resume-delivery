const { test } = require("node:test");
const assert = require("node:assert/strict");
const { aliases } = require("../src/content/candidateIdentity.js");

test("old id forms normalize to one stable token", () => {
  assert.deepEqual(aliases(["x123", "id:x123", "profile:x123", "encryptGeekId:x123"]), ["id:x123"]);
});

test("profile path identity ignores tracking and URL variants", () => {
  assert.deepEqual(aliases([
    "https://www.zhipin.com/geek/person123.html?source=a",
    "https://www.zhipin.com/web/geek/detail/person123.html?source=b"
  ]), ["id:person123"]);
});

test("query identities preserve co-occurring identifiers", () => {
  assert.deepEqual(aliases(["https://www.zhipin.com/web/chat?encryptGeekId=p1&resumeId=r1&source=a"]), ["id:p1", "id:r1"]);
});

test("unrelated domains, list URLs and fallback text are not sending identities", () => {
  assert.deepEqual(aliases([
    "https://fakezhipin.com/geek/p1", "http://www.zhipin.com/geek/p1",
    "https://www.zhipin.com/geek/list", "https://www.zhipin.com/web/chat?source=a", "unknown:x", "姓名 学历"
  ]), []);
});
