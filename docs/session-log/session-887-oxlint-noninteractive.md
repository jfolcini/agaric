## Session 887 — oxlint no-noninteractive-element-interactions → error (#188 batch 4) (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | 4 build + 1 review |
| **Items closed** | — |
| **Items modified** | `#188` |
| **Tests added** | +0 (a11y fixes; assertions unchanged) |
| **Files touched** | 14 |

**Summary:** Fourth #188 burndown batch. Resolved all 14 `jsx-a11y/no-noninteractive-element-interactions`
violations and restored the rule from `warn` to `error`. Most flagged elements are legitimate
container-level keyboard-delegation patterns (roving nav `<ul>`/`<nav>`/`role="group"`, `<form>`
Escape-to-cancel) — those got precise `oxlint-disable-next-line` with reasons. Two were genuine
fixes: `BlockPropertyEditor` moved an Escape handler off a `<fieldset>` to a document listener;
`AttachmentRenderer` made the image-lightbox keyboard-accessible (review caught that the lightbox
was previously mouse-only). Remaining oxlint warnings after this batch: ~176 (`prefer-tag-over-role`
115, `react-hooks/exhaustive-deps` 36, `no-autofocus` 20 left for future batches).

**Files touched (this session):**
- `.oxlintrc.json` — `no-noninteractive-element-interactions` `warn` → `error`
- `src/components/AttachmentRenderer.tsx` — **real fix**: wrapped the lightbox image in a `<button>` (keyboard-activatable; review found the lightbox was previously mouse-only and a disable comment misdescribed it); guarded the resize-group `onKeyDown` to only toggle when the group itself is focused
- `src/lib/i18n/editor.ts` — new key `attachment.openImageFullscreen`
- `src/components/BlockPropertyEditor.tsx` — **real fix**: Escape handler moved from `<fieldset>`/`<input>` to a popup-scoped document `keydown` listener (added/removed with the existing outside-click listener)
- `src/components/{BlockListItem,BacklinkGroupRenderer,LinkedReferences,UnlinkedReferences,HistoryPanel,QuickAccessBar,CollapsibleGroupList,GraphFilterBar}.tsx`, `src/components/backlink-filter/AddFilterRow.tsx` — `oxlint-disable-next-line` with reasons (container-level keyboard delegation / Escape-to-cancel; converting to interactive roles would be semantically wrong and cascade into other a11y errors)
- `src/components/__tests__/{BlockInlineControls,SortableBlock}.test.tsx` — disable-with-reason on `role="group"` mock fixtures mirroring PropertyChip

**Verification:**
- `npx oxlint` — 0 errors; `no-noninteractive-element-interactions` reports zero violations; no new error-level lint of the partner rules (`no-static-element-interactions`, `click-events-have-key-events`, `interactive-supports-focus`, `role-supports-aria-props`).
- `npx tsc -b` — no errors.
- `npx vitest run` (12 affected suites) — 570+ pass (AttachmentRenderer click→lightbox still green).
- Technical review subagent (≠ builders) — flagged the `AttachmentRenderer:146` lightbox as keyboard-inaccessible (a real bug the disable would have hidden); fixed by the orchestrator with the `<button>` wrap; all other disables verified genuinely justified.

**Process notes:** Branched from pre-#206 `main`; will rebase onto `main` after #206 merges (the
`.oxlintrc.json` line auto-merges). The review-caught lightbox bug is exactly why a non-builder
review pass on disable-heavy batches matters — a disable that hides a keyboard-inaccessible control
is a real regression, not a lint-only concern.

**Commit plan:** single commit, rebased onto main, pushed, PR opened.
