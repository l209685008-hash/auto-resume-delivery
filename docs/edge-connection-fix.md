# Edge connection repair - 2026-11-07

## Goal

Restore candidate-list discovery on the confirmed recommendation URL
`https://www.zhipin.com/web/chat/recommend`. Keep scan-only as the default and
never reinterpret a connection failure as permission to start or send.

## Reproduced defects

- A responsive top frame concealed a missing receiver in the candidate iframe;
  no missing-receiver recovery was attempted.
- A successful page connection with zero recognized cards was returned as an
  offline error, losing the useful waiting state.
- A stale owner could pin routing to an iframe that no longer existed.
- A failed script injection consumed the panel's only repair opportunity.
- A button plus its wrapper/label was counted as multiple greeting actions;
  hidden responsive copies also excluded valid cards.

The exact live user's DOM remains unavailable. These are independently
reproduced defects in the reported discovery/reconnection path; they are not a
claim that one particular live DOM cause has been conclusively established.

## Acceptance

- State reads discover frames and preserve each frame's connected/ready status.
- A connected page without cards stays connected, shows why it is waiting,
  and keeps Start disabled.
- Repair scripts target only missing allowed BOSS frames; read-only recovery
  never dispatches Start or clicks.
- Failed injections can recover after a fresh explicit reconnect, with backoff
  for automatic retry.
- Stale ownership is cancelled before release. A state read may rediscover the
  new frame; control commands never silently restart or broadcast.
- A valid running owner takes precedence in state reads even if its list is
  temporarily empty or another frame has cards. Stop remains scoped to that
  owner; a new Start still requires a unique candidate list.
- State probes have a bounded wait, and Stop of a known owner does not probe
  unrelated frames. Owner claim, invalidation, and release share serialized
  compare-and-update operations; cancellation precedes any queued cleanup.
- Greeting wrappers and labels resolve to one actual control; two independent
  active controls remain ambiguous. Hidden or already greeted controls cannot
  cause a new greeting.
- Diagnostic export contains browser/version, sanitized page paths, frame
  health, counts, and CSS structure only; no candidate names or resume text.
- Run regressions, real isolated Edge extension/iframe scanning when supported,
  actual popup checks, and package parity. Report any live-environment gap.
