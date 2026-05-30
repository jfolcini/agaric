## Session 921 — #258: preserve callout type through the editor round-trip (2026-05-30)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-30 |
| **Subagents** | orchestrator-direct + Playwright runtime verification |
| **Items closed** | #258 |
| **Items modified** | — |
| **Tests added** | +4 unit (CalloutBlockquote attr round-trip) +1 e2e (`/callout` → callout-block after save) |
| **Files touched** | 3 |

**Summary:** Fixed #258 — callouts lost their type through the editor. The app stores callouts as `> [!TYPE] …`; the markdown parser sets `attrs.calloutType` and the serializer emits `[!TYPE]` back from it, but the editor used **stock `@tiptap/extension-blockquote`** which has no `calloutType` attribute, so the type was silently dropped on parse→setContent→serialize. Every callout created via `/callout` (and, once #253 lands, the toolbar Callout button) was downgraded to a plain blockquote, and the static renderer never saw `[!TYPE]` → no `callout-block`.

Fix: a custom `CalloutBlockquote = Blockquote.extend({ addAttributes: { calloutType (data-callout-type) } })`, swapped in for stock `Blockquote` in `use-roving-editor.ts`. The serializer/parser already handle `[!TYPE]`; declaring the attribute lets it survive editing.

**How it was found + verified:** the owner enabled runtime verification (vite dev server + tauri mock + Playwright). While verifying #253 I drove the real app and saw `/callout` produce `<blockquote><p>…</p></blockquote>` with no `callout-block`. After this fix, a Playwright e2e confirms `/callout` renders `data-testid="callout-block"` (containing the text) after save.

**Files touched:** `src/editor/extensions/callout-blockquote.ts` (new), `src/editor/use-roving-editor.ts` (swap import + extension entry), tests: `src/editor/__tests__/callout-blockquote.test.ts` (+4, attr parse/render/round-trip), `e2e/callout-roundtrip.spec.ts` (+1 runtime).

**Verification:** 4 unit + 1 e2e green; 495 serializer/editor/renderer tests green (no regression); tsc + oxlint + oxfmt clean.

**Process notes:**
- This makes `/callout` actually produce callouts, and (once #253/#257 merges) the toolbar Callout button too. The #253 e2e callout assertion can be upgraded from `blockquote` to `callout-block` in a follow-up now that the round-trip works.
- Editor-side *visible* callout styling while editing (vs. the static-render styling) is a separate enhancement, not required for correct round-trip.

**Commit plan:** single commit / pushed. `Closes #258`.
