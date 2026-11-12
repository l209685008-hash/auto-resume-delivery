# Scan limit and selected-job repair - 2026-11-07

## Run spec

The user requests at most 100 screened people per run and asks why greetings are
blocked. Their screenshot shows a connected page, a selected cross-border
accounting job, a start error saying that the job is not selected, 105 reviewed
people, zero matches and zero greeting attempts. Treat the image as evidence.

The stable objective is to enforce the scan cap, repair demonstrated extraction
and selected-job context defects, explain any remaining evidence gaps, and build
a verified local release. Keep the six job-related requirements, per-candidate
no-retry records, 60 greeting-attempt cap and 0.5-0.9s delay. Do not use age or
gender. Do not send real greetings, refresh live BOSS, copy profiles/cookies,
commit or publish. Authentication and risk challenges require human handling.

The local browser process inspection has no visible Edge main window or debug
endpoint. The screenshot alone does not expose actual DOM classes; synthetic
replay success is not proof of compatibility with the user's live page.

## Graph and acceptance

1. Main: reproduce missing selected values and the top-frame-only context defect.
   Read selected widgets, not candidate text or unselected dropdown options.
   Combine the top and initiating candidate frame; conflicting titles, changed
   titles or uncertain context must block sending. Revalidate before clicks.
2. Scan worker: separate a default/max 100 screened-person limit from the existing
   greeting-attempt limit. Stop exactly at the configured scan count regardless
   of match/review/reject. Only scan count limits scan-only mode; the greeting
   limit applies to send attempts. Expose the two settings distinctly.
3. Extraction worker: add candidate-scoped recommendation-card field support and
   preserve work/education row boundaries. Missing English or incomplete work
   history remains unknown; never invent evidence or relax requirements.
4. Independent review: inspect Standards and this Spec against 0.2.3 archive
   SHA256 37F6A0E76333B7EB79399285B5FF80C9051E61B0132A111C365B1FDACB4B0015.
5. Main: run unit, browser, actual popup and isolated Edge checks; build 0.2.4;
   verify source/ZIP/unpacked parity and record final evidence.

Trigger: fresh user screenshot and explicit scan-count request. Retry only local
test runs after changed evidence; never retry uncertain sends. Finish when the
local regressions pass, review findings close and the package is verified. Leave
the live environment explicitly unverified when it cannot be observed.
