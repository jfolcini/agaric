# Session 3803 — Trash rows say when they were deleted, in the browser mock

On the mock backend (`npm run dev`, the e2e lane), every trashed row read "Deleted: NaNd ago".

- Cause: `nextCohortMarker()` stamped `deleted_at` as an ISO string with a `#000001` sequence suffix, which no date parser reads. The backend stamps the delete op's `created_at`, an epoch-ms integer (`blocks.deleted_at` is INTEGER since migration 0080).
- Fix: the marker is an epoch-ms number, at least one past the last so two deletes in one millisecond still get distinct cohorts. `list_trash` keys its order and cursor on the number, as the backend's `Cursor.deleted_at: Option<i64>` does.
- Why conformance missed it: the snapshot normalizer turned any non-null `deleted_at` into `'DELETED'`, so the type never reached the comparison. It now maps only a number to the sentinel and passes anything else through raw. With the old marker, the conformance test fails on every fixture that deletes.
- Test: `e2e/trash-deleted-time.spec.ts` deletes a block and requires its Trash row to read "Deleted: just now". It went red on the old marker with "Deleted: NaNd ago".
- Test edit: `revert.test.ts` pinned the marker as a string. It now pins a positive number, the backend's type.
