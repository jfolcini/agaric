## Session 1065 — Typed checkbox vs BulletList shadowing (#1494) (2026-06-18)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-18 |
| **Subagents** | 1 review (caught a CI-blocking test-harness defect) |
| **Items closed** | `#1494` |
| **Items modified** | — |
| **Tests added** | +6 (frontend unit) |
| **Files touched** | 2 |

**Summary:** Fixed the live-typing regression where `- [ ] ` produced a bullet
list instead of a task. Since #1436, BulletList's `- ` input rule fires on the
space after the dash and wraps the line in `<ul><li>` before CheckboxInputRule's
`^- \[ \] $` can match — so the typed-checkbox path was shadowed (the #1481 paste
route bypasses input rules and was unaffected). The fix keeps the two direct
`- [ ] `/`- [x] ` rules and adds two "unwrap" rules matching `[ ] `/`[x] ` that
fire only inside the freshly-created single-item bullet list: they replace that
bulletList with an empty paragraph and call onCheckbox. A single-item guard
keeps the rule inert in real multi-item lists and plain paragraphs (bare `[ ] `
stays literal).

**Files touched (this session):**
- `src/editor/extensions/checkbox-input-rule.ts` (+54/-13) — 2 direct + 2 bullet-unwrap input rules.
- `src/editor/__tests__/checkbox-input-rule.test.ts` (+108) — rule-count bump (2→4) + 6 new tests for the typed path under BulletList.

**Verification:**
- Reproduced the bug first with a throwaway harness (char-by-char `- [ ] ` → `bulletList>listItem>paragraph("[ ] ")`, onCheckbox never fired), then confirmed the fix across 5 cases (typed TODO/DONE/uppercase, bulk insert, bare `[ ] ` no-op, multi-item-list no-op).
- `npx vitest run` — 579 files / 13294 tests green (+6), **exit 0 with no unhandled errors**.
- `npx tsc -b --noEmit` — clean.

**Lessons learned:** check the test runner's REAL exit code, not just "N passed". The
review caught that the first char-by-char harness (`insertContent(ch, {
applyInputRules: true })`) queued an independent deferred `setTimeout(0)` per
input-rule plugin with no cross-plugin short-circuit — after the unwrap collapsed
the doc, a stale timer threw an unhandled `RangeError` that exits vitest 1 in CI
despite "36 passed". Fixed by driving the synchronous `view.someProp('handleTextInput',
…)` path (what a real keystroke does, including first-match short-circuit).

**Process notes:** An e2e for the typed path was attempted (4 strategies: fresh
block, settled block 0, split typing with an intermediate settle assertion, and
single continuous typing). All flaked ~30% in headless chromium — a dropped/
coalesced keystroke in the `[ ] ` sequence leaves the bullet un-unwrapped — i.e.
keystroke-timing on the brand-new-block/input-rule lifecycle, the same hazard
`e2e/task-paste-wiring.spec.ts` documents and avoids. Rather than ship a flaky
spec, the typed path is covered by deterministic unit tests that drive the live
input-rule plugin char-by-char. A reliable typed-path e2e harness can be a
follow-up.

**Commit plan:** single commit; pushed; PR opened.
