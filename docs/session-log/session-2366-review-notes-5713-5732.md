# Session 2366 — Review notes from #5713 to #5732

The non-blocking review notes on the PRs merged since #5716, each checked
against the code first.

- **#5715, fixed.** The comment in `e2e/settings.spec.ts` now reads
  "Settings › Help › About".
- **#5719, fixed.** The icon-size comment in `button.test.tsx` says the `xs`
  size keeps its own `size-3`, which is all the test checks.
- **#5727, fixed.** Testing invariant 5 in `AGENTS.md` says persistence is
  checked "never by reloading": `page.reload()` re-seeds the mock in `e2e/`
  just as `browser.refresh()` is the trap in `e2e-tauri/`.
- **#5732, fixed.** `openVoiceNoteRecorder` has one caller, the `voice` slash
  handler, and `BlockTree` filters that command out when recording is
  unsupported. `VoiceNoteUnavailable`, the `voiceNote.unavailable` key and
  their tests are deleted, and `VoiceNoteDialog` renders `VoiceNoteRecorder`
  unconditionally. `canRecordVoiceNote` and the slash filter stay.
- **Doc drift from the #5726 audit, fixed.** `PageBrowserHeader` has no
  Tree/Flat control, so `docs/features/views.md` now describes only the
  namespace tree; no other doc made the claim.
- **#5720, no change.** The reviewer asked whether "#5608" in the session log
  and "#5713" in the PR body disagree. They do not: #5608 is the issue and
  #5713 is its PR.

Back-references, since merged logs are not edited:
- session 2328 (#5608) said the cross-space-moved-page loss was "filed
  separately"; it is #5712.
- session 2324 said the boot rehydrate trim was "filed separately"; it is
  #5707.
