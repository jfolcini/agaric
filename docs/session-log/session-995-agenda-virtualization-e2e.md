## Session 995 — agenda list virtualization e2e coverage (2026-06-07)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-07 |
| **Subagents** | 1 scope (Explore), orchestrator build |
| **Items closed** | `#548` |
| **Items modified** | — |
| **Tests added** | +1 e2e spec (2 cases) |
| **Files touched** | 3 |

**Summary:** Closed #548. `AgendaResults` virtualizes its list with `@tanstack/react-virtual`, but the unit test mocks the virtualizer entirely (jsdom has no scroll geometry), so *which* rows render at an offset and that rows recycle on scroll were untested. Added a Playwright e2e spec that seeds 60 agenda items and asserts (1) only a windowed slice renders (DOM rows ≪ total; spacer height ≫ viewport) and (2) rows recycle on scroll (top rows unmount, higher-index rows mount).

**Files touched (this session):**
- `e2e/agenda-virtualization.spec.ts` (new) — the two virtualization cases.
- `src/lib/tauri-mock/seed.ts` — `addMockAgendaItems(count, parentPageId?)` bulk-seeds TODO blocks with staggered due dates so the agenda's default `todo_state IN (TODO, DOING)` filter surfaces them.
- `src/lib/tauri-mock/index.ts` — expose it as `window.__addMockAgendaItems` (mirrors the existing `__addMockAttachment` test hook).

**Verification:** `npx playwright test e2e/agenda-virtualization.spec.ts --workers=1` — 2 passed (real chromium); `tsc -b` clean; existing `AgendaResults.test.tsx` still green (32). Seeding is additive test-only infrastructure, exercised by the new spec.

**Note:** `data-index` on virtual rows spans both group-header and item rows, so the recycling assertions key on the *shift* in rendered item indices, not an absolute starting index (the first item sits behind a date group header).
