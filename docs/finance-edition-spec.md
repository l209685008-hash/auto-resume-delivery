# Cross-border finance edition - 2026-11-07

> 历史文件：本文件描述 0.2.x 的六项口径。0.3.0 起筛选条件已收敛为
> “本科专业为财经类”“财经类相关经验 1–2 年”两条，并取消“待核实”，
> 见 `finance-major-edition.md`。

## Goal and scope

Create a local, installable Chrome MV3 edition for the cross-border e-commerce
finance vacancy. Use the existing repository as the base. No GitHub publication
or live greetings form part of this implementation run.

## Frozen rule contract

- Degree: completed associate degree or higher.
- Major: finance, accounting, auditing, or taxation.
- English: explicit CET-4 or higher evidence; absent or ambiguous evidence is
  pending verification.
- Experience: 12-24 months of personal finance work in cross-border e-commerce.
  The industry and duties must belong to the same work entry. Overlapping
  periods are counted once; total career length is not relevant tenure.
- Pay: expected monthly CNY pay range intersects CNY 6,000-7,000. Missing or
  incomparable pay evidence is pending verification.
- Employment history: three or more distinct formal employer spells intersecting
  the last 36 months fails this condition. Internships do not count; continuous
  work at the same employer is merged. Incomplete timelines cannot establish a
  pass. This interpretation is visible in the requirements panel.
- Age, sex, birth date, and family status do not participate in parsing, ranking,
  eligibility, or greetings.
- All checks pass: match. Any failed check: reject. Otherwise: review. These are
  local screening results, not changes to a candidate's platform status.

## Execution and interface

The panel shows the fixed job requirements, scan mode, run stage, stop reason,
counts, and candidate evidence. Defaults to scanning only. Only candidates with
all checks passed can reach a greeting when the user enables sending and starts
the run. Review and reject results are never greeted.

There is one owner per running browser tab/frame. Explicit start is required.
Limit each run to at most 60 attempts. Persist attempt identities before a click;
unknown click outcomes are not retried. Count success only after the same
candidate's greeting button changes to a confirmed state. Stop on authentication,
verification, platform frequency warnings, job changes, runtime exhaustion, or
three consecutive unconfirmed attempts. Never refresh, navigate, or switch jobs.

## Execution graph and evidence

1. Pure rule engine + boundary tests (worker).
2. Panel + evidence rendering (worker).
3. Visible profile extraction, runner, and routing (main).
4. Integration and synthetic browser replay.
5. Independent standards and requirement reviews, repair, and package validation.

Workers do not send greetings, publish changes, or overwrite other work. The
main loop integrates the branches and owns final acceptance. Existing project
changes must be preserved. Start point: local HEAD ba08cfe.

## Acceptance

Run offline rules and integration tests, verify manifest references and JavaScript
syntax, inspect actual panel screenshots at narrow and popup widths, verify no
overlap or horizontal overflow, and compare packaged files with source. Record
the commands, outcomes, and limitations in docs/verification.md. Live BOSS DOM
compatibility remains unverified unless a bound real page is observed.
