## Session 969 — Journal single-date lookup index seek (2026-06-05)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-05 |
| **Subagents** | orchestrator build + 1 review |
| **Items closed** | `#427` |
| **Items modified** | — |
| **Tests added** | +0 (existing journal suite covers the lookups) |
| **Files touched** | 1 |

**Summary:** Third batch of the 2026-06-05 SQL backend audit. The single-date
journal lookups filtered `content = ?` but omitted the partial index's WHERE
predicate, so SQLite could not use `idx_blocks_journal_date` and fell back to
scanning every alive page index entry with `content` as a residual filter.
Repeating the redundant `content LIKE '____-__-__'` predicate (the `date` arg is
already format-validated, so it never changes the result) makes both lookups true
index seeks.

**Files touched (this session):**
- `src-tauri/src/commands/journal.rs` — added `AND content LIKE '____-__-__'` to both single-date lookups (`get_journal_page_by_date_inner` and `resolve_or_create_journal_page`); corrected the doc comment that overstated the plan.
- `src-tauri/.sqlx/*` (regenerated: the two byte-identical journal queries share one cache entry).

**Verification:**
- `EXPLAIN QUERY PLAN`: before → `SEARCH b USING INDEX idx_blocks_type (block_type=? AND deleted_at=?)` (content residual); after → `SEARCH b USING INDEX idx_blocks_journal_date (content=?)`.
- `cargo nextest run -E 'test(journal)'` — 33 tests run, 33 passed.
- Review subagent: confirmed `validate_date_format` enforces the exact `____-__-__` shape, so the added predicate is provably result-preserving; no bind-param change.

**Process notes:** The audit cited only `get_journal_page_by_date_inner`, but
`resolve_or_create_journal_page` carried the identical anti-pattern (the
journal-render write path), so both were fixed.

**Commit plan:** single commit; pushed; PR against `main`.
