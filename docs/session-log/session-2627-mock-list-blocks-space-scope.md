# Session 2627 — the mock's `list_blocks` scopes its tag, agenda and children branches to the space

A leftover of #5903, which scoped the by-type branch: the backend filters
every `list_blocks` branch on `b.space_id`, and the mock's tag, agenda-date,
agenda-range and children branches did not.

- **Pinned first:** `conformance/fixtures/query_list_blocks_space_scope.json`
  seeds a block in the harness space and its twin moved to a second space,
  tagged and dated alike, and asks each branch for the harness space. The
  backend answers with the harness block alone (no rows for the moved
  page's children); today's mock returned the twin too, on all four.
- **The mock** filters each branch on `ownerSpaceOf(b)`, as the by-type
  branch does. The `list_blocks::agenda-date` coverage waiver is gone,
  since a step now covers it.
- **Callers** that relied on the unscoped listing put their rows in the
  asked space instead: `seedAgendaListBlocks` takes a space, and the
  seeds of five mock tests carry the `space` property. No e2e spec needed a
  change.

Ran: `vitest run src/lib/tauri-mock` (1145); the eight failures the
caller fixes cleared, re-run with the mock suites (1544); the backend
conformance check; the due-panel, agenda, duplicate, paste, clipboard,
spaces, journal, boot-IPC, onboarding and import-export Playwright specs.
The new steps were red on the old mock, row for row.
