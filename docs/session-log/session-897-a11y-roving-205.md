## Session 897 — #205: arrow-key roving for tablist + radiogroup (2026-05-29)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-29 |
| **Subagents** | 1 build (orchestrator-verified) |
| **Items closed** | `#205` |
| **Items modified** | — |
| **Tests added** | +11 (5 tablist + 6 radiogroup, incl. axe) |
| **Files touched** | 4 |

**Summary:** Closed #205 (filed earlier during the interactive-supports-focus burndown). `JournalControls`'s
`role="tablist"` and `QueryBuilderModal`'s `role="radiogroup"` had roving `tabIndex` (one tab stop) but
**no arrow-key handler**, so keyboard users could Tab to the active option but couldn't reach the others.
Added WAI-ARIA **automatic-activation** roving:
- **tablist** (horizontal): `ArrowLeft`/`ArrowRight` (wrap) + `Home`/`End` → `setMode(target)` + focus the target tab.
- **radiogroup**: `ArrowUp`/`ArrowDown`/`ArrowLeft`/`ArrowRight` (wrap) + `Home`/`End` → `setQueryType(target)` + focus the target radio.

**Implementation:** small inline `onKeyDown` on each container (no suitable shared hook exists; the
`breadcrumb` toolbar idiom only moves focus without select-on-focus). Option order hoisted to module
consts (`JOURNAL_MODES`, `QUERY_TYPES`); button refs via `useRef<Record<string, HTMLButtonElement|null>>`
(the shadcn `Button` forwards refs). Added `tabIndex={-1}` to each container so `onKeyDown` on the
`role="tablist"`/`radiogroup` div doesn't trip `interactive-supports-focus` (inner buttons own the tab stop).

**Files touched:** `JournalControls.tsx`, `QueryBuilderModal.tsx`, + their `__tests__` files.

**Verification:**
- `npx oxlint` — 0 error-level findings (no new a11y violations).
- `npx tsc -b` — clean.
- `npx vitest run` (both test files) — 56 pass; new tests assert state change (via `aria-selected`/`aria-checked`), focus movement, wraparound, and `axe(container)`.

**Process notes:** Picked as a clean, unblocked ticket while #107 IPC (the crud `_inner` ~367-site
cascade was surfaced to the maintainer — boundary-only vs full propagation) and #109 Phase 2 (blocked
on Open Qs 2/3) await maintainer steer.

**Commit plan:** single commit, pushed from main tree, PR with `Closes #205`.
