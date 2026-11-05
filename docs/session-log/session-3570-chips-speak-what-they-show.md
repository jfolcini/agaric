# Session 3570 — chips speak what they show (#5745 S3)

Set out to pin that each chip's accessible text matches what it shows, so a screen reader and voice control ("click <label>") get the same words a sighted user reads.

- New vitest `src/components/RichContentRenderer/marks/__tests__/accessible-text.test.tsx` (static chips, static and clickable) and `src/editor/__tests__/chip-accessible-text.test.ts` (the roving editor's NodeViews). The property: the accessible text opens with the shown words, any state after them ("(deleted)", "Remove link"), and no full ULID. Unresolved chips show and speak the 8-character prefix; changing that visible fallback stays out of scope (plan Q4).
- One defect: a deleted page-link chip's `aria-label` used the full title, while the chip shows the leaf of a namespaced title, or its stored label. `renderBlockLink` now names it by the shown label. Shown red (4 cases) before the fix; the editor test was falsified by breaking the broken-link `aria-label` and the tag chip's name.
- Reveal markers were already pinned `aria-hidden` by `markdown-reveal.test.ts`, so they get no second test.
- Not fixed, needs the maintainer: the repeat chip shows "Every week" and is named "Repeats +1w" (the raw rule). The fix is to use `formatRepeatLabel` in the label, but `e2e/page-mode.spec.ts` and `PageModeEditor.test.tsx` pin "Repeats +1w", and existing tests are not edited without approval.
- `dom-accessibility-api` is only a transitive dependency and its types do not resolve under `exports`, so the helpers read `aria-label` or the content. No chip uses `aria-labelledby`.
- Ran: the two new files, the RichContentRenderer suites, the full vitest suite, `npm run typecheck`, oxlint and oxfmt. The e2e selection is 214 Playwright and 72 WebdriverIO specs; CI's run is the check.
