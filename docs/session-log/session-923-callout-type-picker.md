## Session 923 — #215: callout type picker on the toolbar (2026-05-30)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-30 |
| **Subagents** | orchestrator-direct + Playwright runtime verification |
| **Items closed** | — (partial: #215 callout type picker) |
| **Items modified** | #215 |
| **Tests added** | +~13 (CalloutTypeSelector unit, consumer variant cases, FormattingToolbar popover, e2e) |
| **Files touched** | 8 |

**Summary:** #215 sub-issue 2 — the toolbar Callout button inserted only the `info` variant; the other four (warning/tip/error/note) were slash-only. The button now opens a **type picker popover** (5 variants, icon + label, mirroring the code-block/heading selectors). Selecting a variant dispatches `INSERT_CALLOUT` with the chosen `type` in the event detail; `useBlockTreeEventListeners` reads it (validated against the known set, falling back to `info`) and applies `> [!TYPE] …`.

This was only possible because the two prerequisite bugs landed first this session: #253 wired the previously-dead `INSERT_CALLOUT` consumer, and #258 made callouts survive the editor round-trip. With both, the picker renders real, typed callouts.

**Files touched:** `src/components/CalloutTypeSelector.tsx` (new popover), `src/components/FormattingToolbar/RefsAndBlocksGroup.tsx` (`renderCalloutButton`), `src/components/FormattingToolbar.tsx` (wire `calloutPopoverOpen` + dispatch case), `src/hooks/useBlockTreeEventListeners.ts` (consumer reads `detail.type`, validated), plus tests: `CalloutTypeSelector.test.tsx` (new), `useBlockTreeEventListeners.test.ts` (+variant cases), `FormattingToolbar.test.tsx` (callout-now-a-popover), `e2e/callout-picker.spec.ts` (new).

**Verification:** 83 unit tests green; tsc + oxlint + oxfmt clean. **Runtime (Playwright):** clicking Callout → "Warning" renders a `callout-block` with `data-callout-type="warning"` and the content after save — the full chain (picker → event detail → consumer → CalloutBlockquote → static render) confirmed end-to-end.

**Process notes:**
- The plain toolbar action button is now a popover; updated the two FormattingToolbar tests that asserted a direct dispatch, and pointed the "overflow row dispatches its action" test at the divider (still a direct action) while adding a callout-overflow popover test.
- Editor-side *visible* callout styling while editing remains a separate enhancement (the static render shows the styled callout).

**Commit plan:** single commit / pushed.
