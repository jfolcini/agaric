## Session 912 — Editor structural blocks (#215), CI path-gating (#266), flaky de-flake (#254) (2026-05-31)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-31 |
| **Subagents** | orchestrator + one Explore (table architecture map) |
| **Items closed** | #266, #254; #215 substantially advanced; #217 A1 |
| **Items modified** | #215, #217 |
| **Tests added** | view-mode table render (unit + e2e), table-ops (unit + e2e), editor-table styling (e2e), SearchPanel de-flake (3 tests hardened), context-menu order guard |
| **PRs** | #267, #268, #269, #270, #271 (merged); #272, #273 (open) |

**Summary:** A `/loop /batch-issues` run advancing the editor structural-blocks
work (#215), tightening CI, and fixing a flaky test, all behind the
pre-commit/pre-push gate (no `--no-verify`), every commit DCO-signed.

**Tables (#215), the headline thread:**
- **View-mode rendering bug** (#269) — discovered via the table-ops design pass
  that `renderBlock` had no `table` case, so a block whose content parsed to a
  table rendered as **nothing**: you could type a table, blur the block, and
  watch it vanish. Added `renderTableBlock` (thead/tbody, inline content in
  cells). The grounded issue assumed tables rendered; they didn't.
- **Row/column operations** (#270) — the headline #215 item. TipTap's table
  commands had zero UI; added a "Table" toolbar popover that appears only when
  the selection is inside a cell (insert/delete row/column, delete table).
- **Edit↔view styling** (#272, open) — edit-mode tables had no CSS (raw browser
  defaults) and the highlight `<mark>` used UA-default yellow (illegible in dark
  mode); aligned both to the view-mode look.

**CI (#266 → #268):** path-gated the ~24 min Linux `build` and ~28 min
`android-build` jobs so frontend-only / docs-only PRs skip them — `detect-changes`
now emits `desktop`/`android` booleans from path regexes. Validated live: every
frontend PR opened afterward skipped `build`. Rebased the in-flight table PRs
onto the gate so they merged in ~12 min (cargo-tests) instead of ~24 min.

**Templates (#215):** #267 surfaced the four dynamic template variables
(`<% today %>` etc.) as a discoverability hint in `TemplatesView`. Scope-badge
sub-item deferred (needs a backend child-count signal; would otherwise invent a
taxonomy).

**Flaky test (#254 → #271):** `SearchPanel` parent-navigation tests used an
order-sensitive `mockResolvedValueOnce` queue on the global (shared, never
reset) `invoke` mock; the breadcrumb `batch_resolve` effect could steal a queued
`get_block` response under batch timing → title resolved to "Untitled".
Converted the three affected tests to command-aware `mockImplementation`
(mirroring the recent-pages test), making them hermetic.

**Block context menu (#217 A1, #273 open):** destructive **Delete** rendered
*first* (mis-click / on-open-Enter footgun); reordered to
Tasks · Block-ops · View · History/Props · **Delete last**.

**Notes / deferrals respected:** table column alignment (#215, issue says defer),
compile-time SQL macros (#235, explicitly parked), #153 perf items
(blocked-on-measurement / already-fixed). Inline query hints deemed low-value
post visual-builder.
