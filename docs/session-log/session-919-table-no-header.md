## Session 919 — #215: `/table-no-header` slash command (header-row opt-out) (2026-05-30)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-30 |
| **Subagents** | orchestrator-direct |
| **Items closed** | — (partial: #215 table header opt-out only) |
| **Items modified** | #215 |
| **Tests added** | +2 structural (`withHeaderRow` true/false) + BlockTree id-list (28→29) |
| **Files touched** | 4 |

**Summary:** `/table` (and `/table NxM`) hardcoded `withHeaderRow: true` with no opt-out. Added a `/table-no-header` slash command that inserts a table without the header row. `handleTable` now takes a `withHeaderRow` parameter (default `true`, preserving existing behaviour) and its dimension regex accepts both `table:N:M` and `table-no-header:N:M`.

**Files touched:** `src/lib/slash-commands.ts` (new `table-no-header` entry, structure category), `src/hooks/useBlockSlashCommands/useSlashCommandStructural.ts` (`handleTable` param + exact handler), plus tests (`useSlashCommandStructural.test.ts` +2 asserting `insertTable` is called with `withHeaderRow:true` for `/table` and `false` for `/table-no-header`; `BlockTree.test.tsx` searchSlashCommands id-list 28→29). The dispatcher-coverage test ("every SLASH_COMMANDS id resolves to a handler") covers the new exact id automatically.

**Verification:** 284 tests across the affected suites green; tsc + oxlint + oxfmt clean.

**Process notes:**
- This is the small, pure, fully-testable slice of #215 sub-issue 1 (Tables). The larger **row/column ops** (cell-aware context menu + hover mini-toolbar) are deferred — they're interaction-heavy UI that warrants runtime verification, not jsdom-only unit tests.
- #215 progress: P2-10 (custom code-block language, PR #255) + this header opt-out shipped. Remaining sub-issues: tables row/col ops, callout type picker (blocked on #253 — the toolbar callout button has no consumer), query builder at insertion, P2-8 persistent labels.

**Commit plan:** single commit / pushed.
