# Session 4292 — four advanced-query spec files join the real-backend project

Stage 2 of #6529, the advanced-query area. Six files were tried on a locally built `bridge`, and 27 of their 30 tests passed. Four files join `REAL_BACKEND_SPECS`: `advanced-query-board`, `advanced-query-group`, `advanced-query-happy-paths` and `query-table-cell-edit`. Two stay off because each exposed a real frontend bug, now filed.

- **`advanced-query-group`** (one of the six untriaged failures from 14 Nov). The spec asserted the mock's fabricated bucket label (`Property` / `DateBucket`, from the mock's single synthetic bucket). The real backend labels a bucket by its value, `(none)` for the seed. Not a backend bug: the spec now asserts that a grouped result renders for a property key, which both backends do, and its header says why. A second such check after the switch to a date bucket was dropped on review: the property grouping's section was still on screen, so it could not fail. Real bucket labels stay pinned by the engine tests.
- **`query-blocks`** › backlinks sort and Load more: failed 5 of 6 on the bridge. Timestamps showed a background `queryExecution` invalidation landing about 100 ms after the Load more click, while `fetchNextPage` is in flight. The invalidation cancels the fetch and refetches only the first page, so the loaded page is lost. Called directly, the backend's paging is correct. Filed as #6911; the file stays off the list.
- **`query-table-list-filter`** › the list editor: failed 3 of 3 on the bridge. The item is saved, but the editor closes within 300 ms of Enter. The mock also refetches and keeps it open, so the root cause is not established. Filed as #6912; the file stays off the list.

Neither filed bug is papered over: no wait was added and no test was tagged.

Ran: the four joining files on the bridge (12 passed) and on the mock (12 passed).
