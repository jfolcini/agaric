# Replace search VIEW with search DIALOG (Cmd+K palette)

> **Status: DRAFT — needs more discussion. DO NOT START IMPLEMENTING.**
>
> This is a UX direction proposal, not a finalized plan. Several big choices below are still open and need to be settled with the user before any code moves. Open questions are flagged inline with **❓ DISCUSS:** markers; resolve every one before this leaves draft.

## Why this exists

`Ctrl+F` today calls `useNavigationStore.getState().setView('search')` (`src/hooks/useAppKeyboardShortcuts.ts:223`), which **replaces the entire main panel** with `SearchPanel.tsx` (~631 lines, mounted at `src/components/ViewDispatcher.tsx:144 case 'search'`). The user loses their open page / journal scroll position / mental context every time they search. Filter chips (page filter + multi-tag filters via two `SearchablePopover` triggers + a typed `searchFilterReducer.ts`) add chrome the user reports as overkill — the reducer is exercised by 9 references in the component but only 3 in the test file, suggesting low real-world load.

The proposal: replace the view with a Cmd+K-style **dialog** that overlays the current view, jumps on Enter or click, and closes on Escape. Mirrors Linear / Raycast / Notion / VS Code's quick-open pattern.

## Open questions (resolve before implementing)

### ❓ DISCUSS 1 — Keyboard binding

`Ctrl+F` today opens search-as-view. Options:

- **(a)** Repurpose `Ctrl+F` as the dialog opener. Existing muscle memory transfers. Cost: people who used `Ctrl+F` to *land in the view and stay there* lose that workflow.
- **(b)** Bind `Cmd/Ctrl+K` (palette convention) for the dialog and keep `Ctrl+F` opening the legacy view. Coexistence; lets users opt in.
- **(c)** Bind `Cmd/Ctrl+K` for the dialog and **delete** the legacy view entirely. Cleanest, most aggressive.

Recommendation: probably (a) — single binding, single concept. But (c) is a reasonable next step if we drop the view; (b) is the safe migration path.

### ❓ DISCUSS 2 — Filters: drop, fold in, or escalate?

The user's note was *"without filters, etc."* That implies dropping. But `filterPageId` and `filterTagIds` exist for real use cases (`"#urgent in Project Alpha"`). Options:

- **(a) Drop entirely.** Smallest surface. Power users use the existing `?tag=foo` query syntax in the legacy view if they need it.
- **(b) Fold into the dialog as query sigils.** Type `#urgent` to filter results to that tag; type `in:Project` to scope to pages. Discoverable via placeholder hint. Zero chip UI.
- **(c) Keep a tiny "Advanced search" link** at the bottom of the dialog footer that escalates to the legacy panel.

Recommendation depends on (1c) — if we delete the view, we need (b) or live with (a). My instinct: **(b)** sigils + leave the door open to add (c) later.

### ❓ DISCUSS 3 — Result shape: pages, blocks, or both, and how mixed?

(See session 2026-05-14 conversation.) Established direction:

- **One unified list**, pages first then matching blocks.
- **Visual prefix glyph** (page vs block icon) — no section headers, no tabs.
- **Not configurable** — sigils as the power-user escape hatch.

But still unresolved:

- **❓** Exact ordering within "pages": title-exact → alias → prefix → contains? Or just FTS rank?
- **❓** Cap counts in dialog mode — e.g. "show top 5 pages + top 10 blocks, click to expand"? Or render the full FTS response and let the user scroll?
- **❓** How to surface "no exact page match — create new page?" — Notion does this prominently. Worth a row at the bottom?

### ❓ DISCUSS 4 — Pagination strategy

`searchBlocks` is cursor-paginated. Two choices for the dialog:

- **(a)** Two parallel queries (pages + blocks) capped at small N each (e.g. 5 + 10), merged client-side. Frontend-only. Top-N model — no "load more" in the dialog. If the user wants more, escalate to (1c)'s legacy view or page through.
- **(b)** Single query + new backend `match_kind` column + server-side `ORDER BY pages_first`. Single fetch, cleaner ranking, more invasive.

Recommendation: **(a)** for v1 — purely frontend, ship-able as one PR. Reconsider (b) if FTS rank actually puts page hits behind a wall of block hits in real vaults.

### ❓ DISCUSS 5 — What happens to the legacy SearchPanel code?

If (1c) — delete the view — we delete:

- `src/components/SearchPanel.tsx` (631 lines)
- `src/components/SearchPanel/searchFilterReducer.ts` (98 lines)
- `src/components/SearchPanel/usePopoverEntity.ts`, `useAliasResolution.ts`
- The `'search'` view case in `src/components/ViewDispatcher.tsx:144`
- The corresponding sidebar nav entry (need to confirm where; `grep` for "search" in `AppSidebar.tsx` returned no matches, so it's either elsewhere or only reachable via `Ctrl+F` — needs confirmation)
- The 600+ lines of `src/components/__tests__/SearchPanel.test.tsx`

If (1b) — keep coexistence — we keep all of the above and *add* the dialog alongside. Two search experiences in the app.

**This is a real architectural fork.** Need an explicit user decision before starting.

### ❓ DISCUSS 6 — Mobile

Full-takeover view is bad on a phone (no breadcrumb back). A dialog opens better on mobile but needs to be a *Sheet*, not a Dialog, for full-height typing comfort. The codebase's `ConfirmDialog` already routes Dialog→Sheet via `useDialogOrSheet()` — same pattern would apply here. Confirm the mobile shape is acceptable.

### ❓ DISCUSS 7 — Recent pages / empty state

The legacy panel shows `recentPages` when the query is empty (`SearchPanel.tsx:516-531`). The dialog should do the same — opening the palette and seeing your last few pages is the fastest path to common navigation. Confirm this stays.

### ❓ DISCUSS 8 — Navigation behaviour on result click

Today, clicking a result calls `handleResultClick` which navigates the current tab to the page. Options for the dialog:

- **(a)** Same behaviour: clicking navigates the active tab.
- **(b)** Cmd-click / middle-click opens in a new tab; plain click navigates active tab.
- **(c)** Always opens in a new tab (Linear-style).

Recommendation: **(b)** — matches browser conventions, low surprise.

## Tentative shape (depends on decisions above)

If we land on something like (1a) + (2b) + (3 unified) + (4a) + (5 delete) + (6 sheet) + (7 keep) + (8b), the dialog is roughly:

```text
┌────────────────────────────────────────────────────────┐
│  🔍  Type to search… (#tag, /page, in:PageName)        │  ← input
├────────────────────────────────────────────────────────┤
│  Recent                                                 │  ← when query empty
│  📄 Project Alpha                                       │
│  📄 Daily 2026-05-14                                    │
│  📄 Reading list                                        │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│  🔍  alpha                                              │
├────────────────────────────────────────────────────────┤
│  Pages                                                  │
│  📄 Project Alpha                          ← ↵         │  ← exact match
│  📄 Alpha test plans                                    │
│  📄 Roadmap (mentions: alpha)                           │
│                                                         │
│  Blocks                                                 │
│  🧩 …kicked off the alpha review on Friday…             │
│     in: Daily 2026-05-12                                │
│  🧩 …alpha builds gate on this PR…                      │
│     in: Project Alpha                                   │
└────────────────────────────────────────────────────────┘
```

Note: the visual mockup uses `Pages` / `Blocks` headers for clarity in the spec, but the actual rendering proposal in (3) is **prefix glyph only, no headers** — the headers above are illustrative of the ordering, not the literal DOM. ❓ Confirm.

Component sketch:

- New `src/components/SearchDialog.tsx` — uses `useDialogOrSheet()` for desktop / mobile shape, mounts `SearchInput` + result list.
- Reuses `ResultCard` for block rows; new tiny `PageResultRow` (or just a `ResultCard` variant) for page rows.
- Lives at the App shell level; opened by a single `useSearchDialogStore.open()` call from `useAppKeyboardShortcuts.ts:221`.
- Mounted once globally; not tied to any view.

## Cost / impact / risk (pending decision)

| Dimension | Notes |
| --- | --- |
| **Cost** | M-L. Dialog UI: ~1 day. Sigil parsing (if 2b): ~half a day. Two-query merge (4a): ~2 hours. Recent-pages reuse (7): trivial. Tests: ~half a day. Deleting legacy view (5 if landed): ~half a day plus updating docs / shortcuts catalog / sidebar. **Total range: 2-3 days depending on how many sub-decisions land on the larger side.** |
| **Impact** | Closes the "Ctrl+F destroys my context" papercut and removes ~700-800 lines of dedicated UI if we delete the legacy view. Cmd+K is what users coming from Linear / Notion / VS Code already expect. Mobile becomes useable. |
| **Risk** | Medium. The functional surface (search itself) doesn't move — same `searchBlocks` IPC. The risk concentrates in (a) figuring out the right sigil syntax (or accepting we drop filters), (b) the parallel-query ranking actually behaving like users want in real vaults (might need to ship behind a flag and A/B with self), (c) anyone who relied on the persistent search view as a workspace (probably low — but the user is the only data point we have). |
| **Reversibility** | Medium. If (5) lands and we delete the view, reverting is "git revert the deletion" — fine if done quickly, painful if other work touches the surrounding files. Until the deletion lands, reversibility is high. |

## Why this is filed as DRAFT

Six of the eight numbered choices above are real forks where reasonable engineers would disagree, and all six have ripple effects on each other (1c → forces 5 → forces 2b/c → affects 8). Implementing the wrong combination is **expensive to revert** because removing a feature is socially harder than not adding it. Better to converge on the full set of answers in one sitting before anyone writes code.

**Convert this draft to a real plan only after every ❓ DISCUSS marker has a recorded answer.** The next session on this topic should start by walking through them in order; once resolved, the doc above becomes mostly the implementation walkthrough with the open questions deleted.
