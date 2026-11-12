# Release verification

## 0.5.6 audit round: real-browser geometry and the 立即沟通 confirmation - 2026-11-12

Two independent checks this round: a headed-browser run (the debugger banner is a
headless blind spot), and a selector-level comparison against a maintained HR-side
script that works on the real recommend page.

### Headed browser (negative result, no change needed)

`npm run verify:click` now honours `BOSS_HEADED=1` and drops `--headless=new`.
The concern was that attaching `chrome.debugger` shows a "being debugged" banner
that could shrink the viewport and shift the layout after the click coordinates
were computed. Running the full scenario headed passed all checks, and the page
received the click at the expected point, so the banner does not reflow content in
this Chrome. No code change.

### Comparison against a working HR-side script

KuroNya39/boss-candidate-tool (Electron + CDP, still maintained) confirms the real
recommend page structure:

- the list lives in `iframe[name=recommendFrame]` — matches the field failure that
  0.5.5 fixed;
- the greet button is `button.btn.btn-greet` inside `.card-inner[data-geekid]`,
  wrapped by `li.card-item` / `.candidate-card-wrap`;
- after clicking, they verify by reading **any** `button` in the card, because the
  class changes, and they accept `继续沟通`, contains `沟通过`, contains `已联系`,
  **and `立即沟通`**;
- they scroll into view, wait 450ms, then measure — evidence that measurement must
  not happen mid-scroll.

### Adopted

- **`立即沟通` after a click counts as sent.** `立即沟通` is also a legitimate
  *initial* label, so the new `findConvertedControl(card, originalLabel)` only
  applies when the button was literally `打招呼` before the click. An initial
  `立即沟通` button is still never treated as already sent.
- **Instant scrolling plus 250ms settle.** `scrollIntoView` now passes
  `behavior: "instant"` so a page-level `scroll-behavior: smooth` cannot make the
  rect be measured mid-animation. `loadMore` already scrolled instantly.

### Verification

- `npm test` - 239 passing tests. New selector cases: a `打招呼` button rewritten
  to `立即沟通` counts as sent; a button that starts as `立即沟通` never does.
- `npm run verify:click` - 8 checks. The iframe scenario now ends with the button
  rewritten to `立即沟通`, so the confirmation path runs end-to-end through the
  real background and scanner.
- Negative controls (both run against a patched copy of the same source):
  removing `findConvertedControl` fails the iframe scenario with `0 !== 1`;
  reverting `getFrameOffset` to URL matching fails it with an empty click list.
- `npm run verify:browser` - 43 checks; `verify:popup` 12; `verify:edge` 12.

### Still unverified

- The real recommend-page DOM has not been exercised: no account is available in
  this environment, so every page is a local synthetic fixture. The selectors are
  now cross-checked against a working project, but the live page can still differ.
- Whether BOSS opens a greeting editor instead of sending directly is unknown; the
  confirmation logic assumes the card button changes label.

## 0.5.5 candidate list inside an iframe could not be clicked - 2026-11-11

A field screenshot showed the run stopping with 「无法唯一定位候选人所在的 iframe」,
12 scanned, 2 qualified, 1 click attempted, 0 confirmed. No greeting could be sent
on that page at all.

### The defect

The click path needs the candidate frame's offset inside the top-level viewport.
It was resolved by asking the top frame to find an `<iframe>` whose `src`
attribute, resolved against the top URL, equalled the candidate frame's current
`location.href`:

    frames = [...document.querySelectorAll("iframe")]
      .filter(frame => new URL(frame.src, location.href).href === payload.frameUrl)

Recommendation pages put the list inside an iframe and then rewrite its URL
(`history.replaceState`, relative src, or a nested frame). The attribute and the
current address no longer match, so zero frames are found, `frames.length !== 1`
throws, and `BGA_TRUSTED_CLICK` aborts before any mouse event is dispatched.

Two consequences:

- no greeting can ever be sent on such a page;
- the attempt row was already persisted as `clicked_unknown`, so that candidate
  was permanently blocked by the dedupe store even though nothing was sent.

### The fix

- The candidate frame now computes its own offset by walking `window.frameElement`
  up to `window.top`, summing `getBoundingClientRect()` plus `clientLeft/clientTop`
  at each level, with a per-level scale check. Works for relative src, SPA-rewritten
  URLs and nested frames; cross-origin or over-deep chains fail closed with a clear
  message. The old URL lookup remains as a fallback when the frame has no receiver.
- `BGA_TRUSTED_CLICK` now tracks whether `mousePressed` was actually dispatched.
  Failures before the press (offset, validation, debugger attach) delete the
  `clicked_unknown` row, so a transient error no longer blacklists a candidate.
  Failures at or after the press keep the record and are still never retried.
- New panel action 「清空发送记录」 (rotate icon next to the audit buttons) with a
  confirmation dialog, to release candidates already blacklisted by older builds.

### Verification

- `npm test` - 237 passing tests. The background suite covers both directions:
  a pre-press failure releases the attempt, a press failure keeps `clicked_unknown`
  and refuses a second dispatch; the popup suite covers the new 清空发送记录 action.
- `npm run verify:click` - 7 checks. New scenario: the candidate list lives in an
  iframe whose `src` is `/web/geek/frame-list` while its address is
  `/web/geek/frame-list?spa=1`. The real mouse event still lands.
  Reverting `getFrameOffset` to the URL lookup on a copy of the same source makes
  that scenario fail with `actual []`, so the check is a true regression gate.
- `npm run verify:browser` - 43 checks; `verify:popup` 12; `verify:edge` 12.

### Known limitations

- The iframe scenario is still a local synthetic page. On a real page the frame
  chain may include a cross-origin hop, in which case the tool refuses to click
  (`候选框架跨域，无法可靠定位按钮`) rather than guessing coordinates.

## 0.5.4 education window crossed the name line, plus a real-click gate - 2026-11-11

A usability audit turned into a real end-to-end test. Loading the built extension
into a real Chromium and driving a non-dry-run scan exposed a defect that unit
tests and the dry-run replays could not see.

### The defect

The education fallback built its evidence from a window around each degree word:

    start = match.index - 16
    window = body.slice(start, end).split(/[\n。；]/)[0]

Recommendation cards render the name first and the education line second. When
the degree word sat within 16 characters of a line start, the lookback reached
into the name line, and splitting at the newline kept the part *before* it, which
is the name. The degree word was discarded.

Measured on a card rendering "测试候选人甲" above "离职 · 本科 · 会计学 · 已毕业":

- before: educationText = "测试候选人甲", major = fail「未见大专及以上学历」
- after: educationText = "离职 · 本科 · 会计学 · 已毕业", major = pass

Every real card that renders a name line above the education line was affected,
so in practice the tool rejected everyone. A 0.5.1-era screenshot showing
"卡片未展示教育经历" is consistent with this path.

### The fix

- The window is clamped to the degree word's own line (`lastIndexOf("\n")` /
  `indexOf("\n")`), so it can never reach a neighbouring line.
- The window stays length-bounded (16 before, 12 after). Using the whole line was
  tried first and broke the keyword gate: subtracting an entire inline line from
  keywordText also removed "亚马逊" from the same line.
- When a line contains nothing but the degree ("本科" on one line, "会计学" on the
  next), the next non-empty line is joined **only** when it looks like a major
  (ends with 学/管理/专业 and is ≤12 chars). A following job title such as
  "财务会计" is not treated as a major.

### New: npm run verify:click

`scripts/verify-click.cjs` launches Chromium (new headless) with the built
extension loaded, maps www.zhipin.com to a local HTTPS server via
`--host-resolver-rules`, and drives the extension's own popup page over CDP. It
then starts a **non-dry-run** scan and asserts:

- the page receives a real click (the page's own click handler fetches /report);
- the greeting is confirmed by re-reading the card after the label is rewritten;
- a below-associate card is evaluated and never clicked;
- an already-contacted card is not even considered a candidate;
- a second run against a stale page state (button reset to 打招呼) sends nothing,
  because the attempt store still holds the record;
- exactly one confirmed attempt exists after both runs.

Stability: 5 consecutive runs, 6/6 checks each. The driver is the popup page
rather than the MV3 service worker; direct CDP attachment to the worker timed out
in 2 of 5 attempts because Chrome recycles the worker target.

### Verification

- `npm test` - 235 passing tests (three new extractor cases: name line above
  education, degree and major on separate lines, degree followed by a job title).
- `npm run verify:browser` - 43 checks; `verify:popup` 12; `verify:edge` 12.
- `npm run verify:click` - 6 checks in a real browser with a real mouse event.
- `npm run build` - 13 files, SHA-256 verified per file inside the archive.

### Known limitations

- Every end-to-end page is a local synthetic fixture. The real recommend-page DOM
  is still unverified; the job gate needs a recognisable selected job title and
  will refuse to send (scan-only still works) when it cannot read one.

## 0.5.3 degree vocabulary drift and inline cards - 2026-11-11

Review of 0.5.2 found three paths where education was still missed. All three came
from the same root: the degree vocabulary was copied into several places and had
drifted apart.

### Defects and fixes

- `高职` and `研究生` were accepted by the rules but missing from the extractor's
  degree list, so such cards produced an empty educationText and were reported as
  "卡片未展示教育经历". The extractor list now covers every rule word, and the
  rules export their vocabulary (`DEGREES`) so a test can compare both lists.
- A school token such as `宁波某专科学校` was dropped wholesale by the school-name
  filter, losing the embedded 专科 evidence. School tokens containing 专科/大专/高职
  now count as an associate degree before being dropped.
- Inline cards concatenate spans into one long string; the previous fallback
  required a short line and rejected the whole thing when it contained 期望/岗位.
  The fallback now takes a window around each degree word (clipped at line breaks,
  ≤16 chars before and 12 after), and the per-token filter only skips tokens that
  *start* with an intention word.
- Card detection in domSelectors now also accepts 专科/高职/研究生/学士/职高/技校, so a
  card whose only education word is 高职 is still discovered.
- Removed the now-unused `NON_WORK` constant.

### Verification

- `npm test` - 232 passing tests, including a cross-file vocabulary assertion that
  would have failed for the 高职/研究生/专升本 drift.
- `npm run verify:browser` - 43 checks; `verify:popup` 12; `verify:edge` 12.

## 0.5.2 associate degree accepted - 2026-11-11

The degree gate moved from bachelor to associate: 大专/专科/高职 with a finance
major now passes; 中专/中职/职高/技校/高中 and below still fail.

### Behavior

- Degree tokens split into two sets: `HIGHER_DEGREE` (本科及以上, including 专升本)
  and `ASSOCIATE_DEGREE` (大专/专科/高职). Only `BELOW_DEGREE` (中专及以下) is
  disqualifying now. A candidate passes when (higher or associate) and a finance
  major are both present.
- Requirement label became 大专及以上 · 财务相关专业; summaries now read
  "符合：大专及以上财务相关专业，…".
- Replay fixtures changed the reject card from 大专 to 中专 so the 1 match / 2
  rejects counts still describe the same scenario, and the "changed qualification"
  downgrade now writes 中专.

### Verification

- `npm test` - 227 passing tests. New: 大专/专科/高职 finance majors pass, 大专 with
  a non-finance major fails, 中专/职高/高中 still fail.
- `npm run verify:browser` - 43 checks; `verify:popup` 12; `verify:edge` 12.

## 0.5.1 summary cards without school or dates - 2026-11-11

A field screenshot showed a real candidate judged "证据不足…卡片未展示教育经历" with
0/2 checks passed. The education row detector required school + degree + a year
range; recommendation summary cards usually render only "本科 · 会计学", so
educationText was empty and the major gate could never pass.

### Fix

- When no structured education row exists and there is no 教育经历 heading, fall
  back to short card lines containing a degree word (≤40 chars). Lines containing
  要求/招聘/任职/职位/优先/以上学历/不限/岗位 are skipped so job requirements do not
  become candidate evidence.
- The keyword text now also removes those fallback lines, so a school name such as
  广东外语外贸大学 cannot re-enter through the text fallback and hit 外贸.

### Verification

- `npm test` - 223 passing tests. New: a card with only "离职 · 本科 · 会计学"
  passes the major gate; "任职要求：本科以上学历" stays out of educationText; the
  fallback path still strips the school name from keywordText.
- `npm run verify:browser` - 43 checks; `verify:popup` 12; `verify:edge` 12.

## 0.5.0 adaptations from maintained GitHub projects - 2026-11-11

Sources reviewed (all still updating in 2026-11): KuroNya39/boss-candidate-tool
(HR side, CDP), ga-ven/boss-hire-automation (HR side, boss-cli), Ocyss/boss-helper
(2.5k stars, job-seeker side), gstranded/autocast-boss-assistant.

### Adopted

- Real recommend-page structure: `li.card-item`, `.candidate-card-wrap`,
  `.card-inner`, `button.btn-greet`. Previously only generic class guesses were
  covered, so one DOM revision could empty the card list.
- `data-geekid` / `data-geek` identity attributes, including the inner
  `.card-inner` marker, so a wrapper `li` without attributes no longer falls back
  to a hash key. Weaker dedupe was the practical consequence of missing these.
- Confirmation after clicking now re-queries the card for a greeted control
  instead of requiring the original button node: both the label and the class are
  rewritten by the framework after a click. Greeted labels extended with
  已联系 / 沟通过 / 已沟通, matched by substring ("沟通过 3 次").
- Default click interval 0.5-0.9s to 2-5s. The two HR-side projects pace at 2-5s
  and 25-70s; 0.5-0.9s was an outlier. The 0.5s floor remains for manual tuning.

### Rejected

- Direct `/wapi` API calls with the `bst` cookie token (boss-helper). Faster and
  more robust than DOM scraping, but a greeting becomes a bare API request with a
  clearer automation signature, and the payloads can change without notice. The
  real mouse click plus page confirmation stays as the safety boundary.

### Verification

- `npm test` - 220 passing tests. New coverage: the real list structure, both
  identity attributes, and seven greeted labels recognised after the node is
  rewritten.
- `npm run verify:browser` - 43 checks; `verify:popup` 12; `verify:edge` 12.

## 0.4.2 audit footprint and dead-code removal - 2026-11-11

Two review leftovers were closed: the audit log rewrote a multi-megabyte array on
every event, and the extractor still computed salary, English and history fields
that no rule reads.

### Behavior

- A single CANDIDATE_EVALUATED record measured 897 bytes. At 3000 records that is
  a ~2.6MB array rewritten for every audit event, roughly 200 times per run.
  Records are now compacted (strings capped at 300 chars, arrays at 24 items) and
  the cap is 1500, keeping the working set near 1MB.
- `unlimitedStorage` was deliberately not requested: the quota was never the
  failure mode, and the permission would not address the rewrite cost.
- Per-candidate and greeting audit writes are now non-fatal (`auditSafe`). The
  failure is surfaced in `lastFailureReason` and the scan continues, because the
  send decision is already persisted in the attempt store. RUN_STARTED stays
  strict: a run that cannot be recorded must not start.
- Audit `pageUrl` now stores origin + pathname only, dropping query strings.
- Removed `candidateSalary`, `englishText`, `historyComplete` and the
  salary/English-specific fixtures and tests. The extractor returns
  `{ text, keywordText, educationText, workEntries }`.

### Verification

- `npm test` - 211 passing tests, including a new case where every
  CANDIDATE_EVALUATED write throws and the scan still reaches its limit.
- `npm run verify:browser` - 43 checks; `verify:popup` 12; `verify:edge` 12.

## 0.4.1 review fixes: school names and keyword scope - 2026-11-11

Code review of 0.4.0 found two false-positive paths that could greet the wrong
person. Both are fixed and covered by tests.

### Defects and fixes

- A school name could satisfy the major gate. `上海立信会计金融学院 计算机科学与技术`
  passed because the old heuristic stripped only `大学`-suffixed tokens, then found
  “会计” inside the retained `学院` token. Major parsing is now token based: any
  token ending in 大学/学院/学校/中学/职校/技校 is dropped before matching, so the
  school and faculty names cannot stand in for a major.
- A school name could satisfy the keyword gate. `广东外语外贸大学` contains “外贸”,
  so every finance graduate of that school passed regardless of their work. The
  extractor now returns `keywordText` with the education rows removed, and the rule
  engine prefers it over the raw card text.
- While fixing the tokenizer: `专升本` was not recognised as a bachelor-level
  degree; `本科 会计学（辅修金融）`, `本科 会计学 已参加初级会计培训` and education
  rows containing 期望 were rejected because a single incidental word caused the
  whole row to be dropped. Course sections are now truncated, course/minor tokens
  are dropped individually, and only rows that are themselves job requirements are
  skipped.
- The manifest name still said 财经本科版 from 0.3.0; it is now 财务关键词版.

### Reproduction and behavior

- `npm test` - 223 passing tests, including the new school-name, 专升本, 辅修,
  course-section and keywordText cases.
- `npm run verify:browser` - 43 checks.
- `npm run verify:popup` - 12 checks.
- `npm run verify:edge` - 12 checks, zero clicks.

## 0.4.0 finance major plus keyword hits - 2026-11-11

Spec: [finance-major-edition.md](finance-major-edition.md). The experience gate
became a keyword gate: any of 跨境电商/亚马逊/海外仓/退税/FBA/独立站/速卖通/
外贸/报关/结汇 etc. in the card text or work entries passes, and month counting
was deleted. The major gate narrowed from 财经类 back to 财务相关.

### Reproduction and behavior

- `npm test` - 220 passing tests. The rule suite now covers the finance-major
  list, non-finance majors (金融/经济/国贸/统计/工商管理/计算机), school-name
  decoys, coursework, the 22-word keyword list, case-insensitive hits, long-word
  absorption (跨境电商 over 跨境, 出口退税 over 退税), work-entry hits, and the
  rule that a keyword hit cannot rescue a candidate failing the major gate.
- `npm run verify:browser` - 43 checks. Scan-only replay classifies the three
  synthetic cards as one match and two rejects with zero sends; the 137-card
  replay stops at 100 rejections; the panel renders two requirements and three
  statistics without overflow at 320/380/480px.
- `npm run verify:popup` - 12 checks against the real action popup.
- `npm run verify:edge` - 12 checks in a throwaway Edge profile, zero clicks.
- `npm run build` - 13 files, SHA-256 verified per file inside the archive.

### Known limitations

- Keywords are presence checks only. A finance-major candidate who merely writes
  “对接亚马逊运营” also passes; the matched sentence is shown in the evidence so
  a human can judge it. Purely domestic finance experience now fails even when
  the tenure matches the vacancy.
- Education completion is still not evaluated, and live BOSS DOM compatibility
  remains unverified. No greeting was sent to any real account during these runs.

## 0.3.0 two hard gates and no review state - 2026-11-07

Spec: [finance-major-edition.md](finance-major-edition.md). Screening collapsed
from six checks to two: a finance-related bachelor major, and 12-24 months of
finance work. English, pay, stability and the separate completed-degree check
were removed; the review state is gone, so missing evidence is a rejection with
an explicit reason.

### Reproduction and behavior

- `npm test` - 211 passing tests. `tests/financeRules.test.cjs` was rewritten
  for the two-check contract (major list, school-name decoys, coursework, degree
  level, 12/24 boundaries, overlap de-duplication, ongoing jobs, excluded work
  kinds, third-party duties, invalid dates, personal attributes, malformed
  input). Extractor tests now assert only extraction; rule outcomes live in the
  rule suite.
- `npm run verify:browser` - 43 checks. The 137-card replay now stops at 100
  rejections with zero sends in both modes; scan-only counts are match/reject;
  the changed-qualification replay flips the education row to a junior college so
  the pre-send re-check still has a real downgrade to detect; the panel renders
  three statistics and two filter tabs without overflow at 320/380/480px.
- `npm run verify:popup` - 12 checks against the real action popup.
- `npm run verify:edge` - 12 checks in a throwaway Edge profile; the real
  background job gate accepts a selected finance job, one dry-run scan classifies
  all synthetic candidates, and a 150-card list stops at 100 with zero clicks.
- `npm run build` - 13 files, SHA-256 verified per file inside the archive.

### Known limitations

- Education completion is no longer evaluated: a "本科 会计学 在读" card passes
  the major gate. The experience gate still filters most students, but a working
  student with 1-2 years of real finance work would qualify. Add a completion
  check back if the vacancy requires a finished degree.
- Live BOSS DOM compatibility is still unverified; all replay pages are local
  synthetic fixtures. No greeting was sent to any real account during these runs.

## 0.2.4 scan limit and selected-job repair - 2026-11-07

Spec: [scan-limit-and-job-context-fix.md](scan-limit-and-job-context-fix.md).
The supplied screenshot shows a connected page, a selected cross-border
accounting job, a failed job-authorization message, 105 screened candidates,
105 reviews and zero greeting attempts. The previous recent-results limit of
100 was a display limit; the scanner stopped on matches or greeting attempts.

### Reproduction and behavior

- A 137-person replay exceeded the requested scan limit before repair. The new
  `maxCandidates` setting defaults to 100 and accepts 1-100 in both modes. It is
  separate from `maxGreetings`, whose 60-attempt maximum remains. Scan-only mode
  does not stop early at the greeting limit, even if everyone matches.
- Readonly selected-job inputs and native selected options were not read. The
  background also queried only the host document, missing a selected job in the
  initiating candidate iframe. Public regressions first failed for these paths.
  Selected text now comes from explicit widgets in those two documents.
  Conflicting selections, editable search text and ambiguous widgets cannot
  authorize a send. Sources which establish selection are retained for the run;
  losing any such source blocks validation, preparation and clicking.
- A synthetic screenshot layout reproduced six unknown checks because dated
  work and education rows had no section headings. Extraction now supports
  independent dated rows and dedicated candidate salary structures. The example
  becomes education pass, major/salary fail, with English/experience/history
  still unknown. No missing facts or complete history are invented.
- Independent review found qualifier loss, excluded-subtree leakage, salary
  currency loss, editable-combobox authorization and nested-wrapper regressions.
  These counterexamples are part of the final regression scope. Rule thresholds,
  the scan-only default, send intervals and persistent no-retry records remain.

### Final verification

- `npm test`: 296 passed, zero failures, including 47 profile extraction cases.
- `npm run verify:browser`: 43 passed, including two 137-card replays which stop
  at exactly 100 reviews in scan-only and greeting modes with zero sends.
- `npm run verify:popup -- --output test-results/action-popup-0.2.4`: 12 passed
  in a real headed action popup; no horizontal overflow.
- `npm run verify:edge`: 12 passed in isolated Edge 156.0.4314.58. The real
  background accepted a selected iframe job while the host had none; the claim
  was immediately released without preparation or clicking. A 150-card fixture
  stopped after exactly 100 reviews. Dense STATE took 9ms in this local run.
  No request was forwarded to real BOSS; context and temporary profile cleaned up.
- Both independent review axes passed after fixes and repeated counterexamples.
  [Review and closure record](reviews/2026-11-07-0.2.4.md).
- Build syntax, manifest references and ZIP parity passed for 13 files. Separate
  source/ZIP/unpacked SHA-256 checks, five version checks, ten Edge input hashes
  and four popup input hashes matched. `git diff --check` exited 0.

Release: `dist/BOSS-Finance-Assistant-v0.2.4.zip`.
Unpacked directory: `dist/BOSS-Finance-Assistant-v0.2.4-7b75989e`.
ZIP SHA-256:
`F6D58426198A8DF89AD79DCA220F32547F0841CD8C763136314BC0EDB926AAE8`.

### Live-environment limit

There is no observable matching Edge main window or Edge CDP endpoint locally.
The screenshot does not expose DOM classes, so class adapters and compact salary
conventions are compatibility assumptions covered by synthetic replay. The user's
live Edge 157 session has not been updated or verified. Missing English evidence
or incomplete employment history still prevents automatic greeting; a review
result is not a conclusion that the candidate lacks the qualification.

## 0.2.3 dense-list connection repair - 2026-11-07

Spec: [edge-state-timeout-fix.md](edge-state-timeout-fix.md).
The user's 0.2.2 JSON confirmed the recommendation URL and offline error but
contained no frame details. A populated screenshot cannot distinguish a missing
receiver from a slow or failing handler; 0.2.2 incorrectly collapsed all of those
cases into `receiver_not_found`.

### Reproduction and repair

`npm run verify:edge` reproduced the reported error with 150 synthetic cards and
real MV3 messages in isolated Edge 156.0.4314.58. A state request exceeded the
1500ms probe budget because discovery repeatedly queried whole ancestor lists.
This was missed by the earlier three-card fixture. Ordinary extension reload
plus reinjection into the same documents passed without a document refresh.

Per-discovery caches and ancestor traversal reduce repeated work without keeping
DOM results across calls. The selector feedback loop's 150-card query-work count
fell from 363,157 to 1,358. The worker's same-fixture diagnostic benchmark fell
from 6217.3ms to 3.7ms; the main real Edge 150-card routed state then completed in
11ms, within the unchanged probe limit. These figures are local synthetic
measurements, not a promise about live BOSS latency.

Three new background regressions failed before the error-contract fix and now
pass: offline responses retain frame health, timeouts are identified separately,
and handler errors do not masquerade as absent listeners. Two bootstrap cases
also failed before the fix: a missing dependency or failed listener registration
left the installed flag set. The flag and public handler now appear only after
validated dependencies and a successful registration; healthy reload remains
idempotent.

Offline exports now keep matching-tab frame health and a recovery stage while
redacting error text, dynamic paths, and unknown CSS fields. Successful script
injection is confirmed against every target receiver before its per-frame cache
is recorded. Failed or unconfirmed repair has 10-second backoff and at most two
automatic attempts; explicit reconnect resets that repair budget. Late failures
from an invalidated attempt cannot repopulate the new attempt's repair cache.

An independent selector review also found a pre-existing person-grouping defect:
an active card could expand into a shared container holding another disabled or
already-greeted card. The repair counts independent explicit candidate roots,
deduplicates nested markers on the same ancestor chain, and refuses containers
spanning multiple people. Thirteen added cases failed before repair; all 37
selector cases now pass. Final 150-card query work is 1,208; the final Edge routed
state measured 8ms.

The final independent review also closed two error-contract findings. A handler
response containing transport-error text is now classified as `page_script_error`
and cannot enter the missing-receiver injection path, whether other frames are
online or all are offline. Repeated export redaction preserves `port_closed`,
including failed injection followed by backoff. Both Standards and Spec review
axes passed their final known-finding closure checks without remaining findings.

### Fresh verification

- `npm test`: 206 passed, zero failures.
- `npm run verify:browser`: 41 passed, including offline failure evidence,
  permissions, cross-tab/URL invalidation, confirmed repair, bounded automatic
  attempts, manual recovery, privacy and all prior scan/send fixture checks.
- `npm run verify:popup -- --output test-results/action-popup-0.2.3`: 12 real
  headed Chromium action-popup checks passed, without horizontal overflow.
- `npm run verify:edge`: 9 passed in isolated real Edge 156.0.4314.58. Includes
  150-card state, extension reload/reinjection into existing documents without
  page refresh, iframe discovery, dry-run tri-state scanning and empty lists.
  Zero clicks, greeting attempts, or requests forwarded to real BOSS. The fresh
  profile was removed and the browser context closed.
- `npm run build`: syntax, manifest references, and ZIP hash parity passed for
  all 13 files. A separate source-to-unpacked SHA-256 comparison passed; all five
  Manifest/package/lock/root-package/release version checks equal 0.2.3. Final
  source hashes still match the real Edge verification inputs.
- `git diff --check`: exit 0, with only existing line-ending notices.

Release: `dist/BOSS-Finance-Assistant-v0.2.3.zip`.
Unpacked directory: `dist/BOSS-Finance-Assistant-v0.2.3-ad82015f`.
ZIP SHA-256:
`37F6A0E76333B7EB79399285B5FF80C9051E61B0132A111C365B1FDACB4B0015`.

### Live-environment limit

The supplied diagnostic has Edge 157 in its user-agent. The observable local
executable is Edge 156.0.4314.58 with no main window or matching standard-profile
BOSS extension. The browser-control kernel also failed to initialize with a
path-not-found error. The user's live Edge session was not modified or verified.
No profile/cookie copy, real BOSS request, refresh, greeting, commit, or GitHub
publication forms part of this repair.

## 0.2.2 Edge connection repair - 2026-11-07

Confirmed user URL: `https://www.zhipin.com/web/chat/recommend`.
Contract: [edge-connection-fix.md](edge-connection-fix.md).

Independently reproduced and repaired partial iframe connection, connected
empty-list state, stale ownership, failed injection recovery, and nested/hidden
greeting-control duplication. The exact user's live DOM remains unobserved;
these are verified defects on the reported path, not a definitive live diagnosis.

Independent review preparation also caught a state-routing regression: when a
running owner's list was empty and another list became ready, STATE returned
frame 9 instead of the owner in frame 3. The new regression failed before the
fix. STATE now prefers a valid running owner, while Start still refuses multiple
ready lists and Stop dispatches once to the original owner.

The Standards review then reproduced an unrelated nonresponding frame blocking
Stop, and two stale invalidations deleting a newly claimed owner. Three new
background regressions failed before repair. State probes now run concurrently
with a 1500ms limit; Stop probes only its known owner. Owner claim, release, and
invalidation share a separate queue, while immediate cancellation continues to
block suspended clicks. All 27 background regressions pass, including stopped
or replaced owners and the original click-cancellation reproductions.

The Spec review reproduced all-offline broadcast injection, raw error-text leaks
in diagnostic JSON, ancestor-opacity hidden actions, and disabled copies causing
false ambiguity. Recovery now enumerates frames and injects only allowed HTTPS
BOSS frames whose missing receiver was confirmed. Diagnostics use structural
allowlists, redacted dynamic URL paths, and fixed error codes. Hidden and disabled
new actions are excluded; disabled already-greeted status remains recognizable.
The selector feedback loop failed 10 cases before repair and passes all 21 now;
the browser feedback loop failed six added scenarios before repair.

Fresh validation against version 0.2.2:

- `npm test`: 183 passed, zero failures.
- `npm run verify:browser`: 23 checks passed, including precise partial and
  all-offline iframe repair, failed-injection recovery, and hostile error/text
  redaction in diagnostic export.
- `npm run verify:popup -- --output test-results/action-popup-0.2.2`: all 12
  real headed Chromium action-popup checks passed; viewport 395x600px,
  HTML/body 380px, readable controls and no horizontal overflow.
- `npm run verify:edge`: all 7 checks passed with installed Edge 156.0.4314.58
  and the actual MV3 service worker and Chrome APIs. A local synthetic candidate
  iframe produced one match, one review, and one reject in one explicit dry run.
  Empty-list STATE returned success with `frameReady: false`. Zero clicks,
  zero greeting attempts, and zero requests forwarded to real BOSS.
- Edge used a fresh temporary profile, local fulfill/abort routing and a rejecting
  loopback proxy. Context closure and exact-path profile cleanup were verified.
- `git diff --check`: exit 0; only local line-ending notices.
- `npm run build`: 13 files passed syntax, manifest references, and ZIP hash
  parity. A separate SHA-256 comparison confirmed all 13 unpacked files match
  current source, and Manifest/package/lock/release versions all equal 0.2.2.

Release: `dist/BOSS-Finance-Assistant-v0.2.2.zip`.
Unpacked directory: `dist/BOSS-Finance-Assistant-v0.2.2-041c421d`.
ZIP SHA-256:
`4E7BBA81A15EDC186B3A56592939CF05A6E88A5BB11E2E6CBEA01EA7CA52CDB9`.

### Standards review

Fixed point: `ba08cfe7a17e2fcee877d1adbf3fbc1380981ed7`, with the immutable
0.2.1 unpacked source used to isolate the connection repair. Two actionable
findings (P1 and P2) were repaired and independently closed. The final review
passed 27 background tests plus additional bounded-probe, no-deadlock, late-state,
and release-identity scenarios. No remaining actionable Standards findings were
reported in the reviewed connection code.

### Spec review

Source: `docs/edge-connection-fix.md` and `docs/finance-edition-spec.md`.
All four reported gaps were repaired and independently closed. The reviewer
ran 18 in-memory DOM scenarios and 13 recovery/export scenarios, with no remaining
findings in those scopes. Unknown CSS tokens and dynamic URL path segments are
intentionally redacted. Live BOSS compatibility remains outside this evidence.

Evidence: `test-results/edge-verification/verification.json`,
`test-results/action-popup-0.2.2/verification.json`, and their screenshots.
The desktop browser-control kernel could not initialize (path-not-found error),
so the user's active Edge installation and live BOSS DOM were not changed or
verified. No automatic BOSS refreshes, real greetings, commits, or GitHub writes.

## 0.2.1 popup display repair - 2026-11-07

The user's toolbar action popup collapsed to a narrow column. The previous
browser replay exercised side-panel layout and did not catch Chrome's intrinsic
action-popup sizing. A new small-initial-viewport regression failed at 140px
before repair. An independent headed Chromium action-popup reproduction using
the original stylesheet measured a 139px viewport and 124px content width, with
the title, mode labels, and start label wrapping incorrectly.

The root `max-width: 100vw` constrained the popup while Chrome measured its
initial viewport. The action document now has a 380px width and minimum width;
the side-panel override remains fluid with zero minimum width. Explicit body
font inheritance also overrides Chrome's extension-page font reduction, which
the real popup test caught on the start label.

Validation after the final style change:

- `npm test`: 149 passed, zero failures; screening and sending code unchanged.
- `npm run verify:browser`: 14 checks passed, including intrinsic popup sizing,
  horizontal text, and side-panel layouts at 320/380/480px.
- `npm run verify:popup -- --output test-results/action-popup-after`: all 12
  real action-popup checks passed in independent headed Chromium.
- The actual installed directory and final unpacked release were separately
  loaded in independent Chromium profiles; all 12 checks passed for each.
- Fixed real popup: 395x600px viewport including the scrollbar, 380px HTML/body
  content, readable single-line title/modes/start label, and no horizontal
  overflow. No real BOSS pages or greetings were used.
- `npm run build`: 13 files checked for syntax, references, and ZIP hash parity.

The installed Chrome Profile 1 extension
`gncijnhgkepodkkpokgnnnchfafpihdj` points to
`dist/BOSS-Finance-Assistant-v0.2.0-aff6178f`. Its stylesheet was backed up and
updated in place; its Manifest remains 0.2.0 and its local storage was untouched.
The deployed stylesheet SHA-256 is
`105BEA70481339185A7314E52BCBDB959D03C61B1865BFE0EB23454B39E94DFA`.
An already-open popup must be closed and opened again to load the updated CSS.
The desktop browser-control kernel could not initialize, so the user's active
window was not reloaded or visually observed after deployment. The exact
installed files were verified through the independent real-popup test instead.

Release: `dist/BOSS-Finance-Assistant-v0.2.1.zip`.
Unpacked directory: `dist/BOSS-Finance-Assistant-v0.2.1-227eee2a`.
ZIP SHA-256:
`61CFB98A03B0C417FF8142F3B36D2A74D1BE25DD2BB558C0FE8EC15B8F52A502`.

Evidence and screenshots are under `test-results/action-popup-before/`,
`action-popup-after/`, `action-popup-installed/`, and `action-popup-package/`.
The original 0.2.0 ZIP is unchanged; the historical unpacked directory now
contains the display hotfix described above.

## Original 0.2.0 verification - 2026-11-07

## Scope

Cross-border e-commerce finance edition, based on
`ba08cfe7a17e2fcee877d1adbf3fbc1380981ed7` and the frozen contract in
[finance-edition-spec.md](finance-edition-spec.md).

Local implementation, synthetic verification, and packaging only. No real BOSS
greetings were sent. No Git commits or GitHub publication were performed.
Age and sex are excluded from screening and sending decisions.

## Fresh verification

| Command | Result |
| --- | --- |
| `npm test` | 149 passed, 0 failed, 0 skipped |
| `npm run verify:browser` | 13 checks passed; Chromium 151.0.7922.34 |
| `npm run build` | Exit 0; 13 files packaged and individually SHA-256 compared |
| `git diff --check` | Exit 0; only local line-ending notices |

The 149 tests cover rule boundaries, negated credentials, third-party duties,
salary comparisons, incomplete extraction, single ownership, durable no-retry
records, and cancellation while the final iframe lookup is awaiting a callback.
The four new background reproductions failed before the identity and cancellation
fixes and passed afterward.

The 13 browser checks cover scan-only tri-state results and zero sends, eligible
synthetic sending with same-button confirmation, no retry after a URL identity
gains a data ID, qualification changes before sending, scoped extraction, stop
before click, security challenges, panel layouts at 320/380/480px, mode and limit
controls, double-start prevention, disconnected cached state, and actual MV3
extension loading in an independent Chromium profile. All candidate sends in
these checks use a local fixture and simulated Chrome messaging.

Screenshots were inspected for narrow layout, readable requirements, accessible
run controls, and overflow. Machine-readable browser evidence and screenshots
are generated under `test-results/` and are excluded from Git.

## Independent review

The review used separate Standards and Spec reviewers against the fixed base and
the frozen finance-edition contract. Findings were repaired and rechecked.

- Standards: the two final P1 findings are closed. URL/data-ID aliases and legacy
  records prevent retries, including after worker restart. A stop acknowledged
  during the final asynchronous coordinate lookup prevents a later mouse press.
  Manifest, popup injection, shared identity module, and worker imports were
  independently checked.
- Spec: the final P2 personal-duty false rejection is closed. Explicit personal
  ownership of company Amazon accounting passes; third-party accounting remains
  excluded. Previously closed rule/extractor examples showed no regression.

## Release artifact

- Version: `0.2.0`.
- Rules: `2026-11-07.1`.
- ZIP: `dist/BOSS-Finance-Assistant-v0.2.0.zip`.
- Loadable directory: `dist/BOSS-Finance-Assistant-v0.2.0-aff6178f`.
- Files: 13, with JavaScript syntax and Manifest references checked.
- ZIP SHA-256: `50A63F04B8684540FA854EB846562BCB23440FBA426E0085412B065241B411D7`.

The installable package contains the Manifest, README, and runtime source.
Development reports, tests, scripts, and browser profiles remain in the source
project and are not part of the extension package.

## Limits

Real BOSS DOM compatibility and real greeting delivery remain unverified. The
extractor reads visible structured card sections and does not open full resumes.
Missing English, major, salary, or complete history evidence stays pending and
cannot trigger automatic greetings. Natural-language rules require sufficiently
clear wording and do not establish facts absent from the page.

One-to-two years means 12-24 completed, deduplicated months of relevant formal
work. Three or more formal employer spells during the last 36 months fails the
history rule; incomplete timelines cannot establish a pass. These interpretations
are visible in the panel and README.
