# Session 1221 — WDIO real-backend lane: live iteration to green (#155)

**Issue:** #155 (weekly real-backend lane, post-#3093 hardening)

## The three live runs

1. **Run 1** (post-#3093): 0/6. Root cause: bare `aria/<label>` resolves accessible
   names document-wide — the Journal nav button and the Journal view `<h1>` share
   `t('sidebar.journal')`. Fixed in #3096 (subtree-scoped XPath + afterTest
   diagnostics + artifact upload).
2. **Run 2**: 2/6 — nav fix verified live. Diagnostics captured the next cause
   directly: the first-boot `welcome-modal` (modal Radix dialog) aria-hides the root
   and intercepts clicks. Fixed in #3097 (deterministic "Get Started" dismissal in
   `waitForAppReady`).
3. **Run 3**: 3/6, alternating pass/fail. Deep investigation (evidence-first, no
   speculative fixes):
   - **The backend is sound.** The suspicious recovery-rewind boot path
     (`apply cursor ahead of snapshot watermark`, every session — WDIO kills the app
     so the clean-exit snapshot never writes) was reproduced in a Rust test:
     rewind → full replay → create through the real local-op path → block lands in
     the projection with intact content. Now a permanent regression test
     (`recovery/tests.rs::rewind_boot_then_create_lands_in_projection_with_intact_content`).
   - **Failure mode A — dropped keystrokes:** `browser.keys(marker.split(''))` races
     the live TipTap editor; failing sessions rendered the block WITH corrupted text
     (`crosview`, `realbackendsmoke17848528610`), so the `*=marker` selector missed.
     Fix: `typeMarkerVerified` — read-back verification with select-all + retype (≤3
     attempts), commit only after the editor text equals the marker.
   - **Failure mode B — virgin-vault CTA:** with no day page, DaySection renders
     "Add your first block" (`journal.addFirstBlock`), not "Add block". Fix:
     `openJournalBlockEditor` matches either label (both route to the identical
     `onAddBlock` handler ending with a focused editor — verified in
     `useJournalBlockCreation.ts`).

## Verification

- Rust: new regression test passes; `cargo clippy --tests -p agaric` clean; fmt.
- TS: `tsc -p tsconfig.wdio.json` (only the 2 environmental TS2688s); oxlint clean.
- Next dispatch run validates live; expectation 6/6.

## Watch items

- WDIO's abrupt kill means the snapshot-rehydrate boot path is never exercised in
  this lane and every boot pays a full replay (idempotent, but the cursor never
  durably advances). A graceful test-shutdown or short snapshot interval under a
  test flag would add that coverage — candidate follow-up.
