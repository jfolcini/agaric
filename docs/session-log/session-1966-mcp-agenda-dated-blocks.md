# Session 1966 — get_agenda returns dated blocks as well as repeats

Issue #5393: MCP `get_agenda` promised "repeating tasks + due/scheduled blocks", but `list_projected_agenda_inner` projects repeating blocks only. A one-off TODO due this week never came back.

The new `agenda_range_inner` (`commands/agenda.rs`) is MCP-only, so the app and `list_projected_agenda_inner` are unchanged.
- **Dated half:** one SQL statement, a `UNION ALL` over `due_date` and `scheduled_date`. It uses the projection's filters: soft-delete, template pages, space. Like the Due panel, it excludes DONE and keeps blocks with no `todo_state`.
- **Merge:** the dated half is merged with the projected repeats on the projection's own keyset `(date, block_id, source)`, so one cursor serves both halves. Each half fetches only up to the limit, because any row in the true first page sits within the first page of its own half.
- **Row shape:** `{ block, date, source, projected }`.

The trap: the issue assumed a projected date never equals the block's own date. A `.+1w` repeat whose base is a week out projects onto its own base, so the merge keeps the dated row on a key tie.

The first builder was cut off by the session limit with four falsification mutations still live in `agenda.rs`. Its clean copy sat beside them in the scratchpad. A continuation agent restored the file, confirmed it with `cmp`, and re-ran every red itself. Inherited claims of a red run don't count.

Empty-content blocks stay in both halves. Filtering only the dated half would hide an empty repeat's own date while still showing its future ones.

Suites that ran:
- nextest over the agenda, `tools_ro` and `summarise` tests;
- `SQLX_OFFLINE` check of every target;
- clippy over every target;
- `just gen-sqlx`, which added one root-crate query.
