# Session 990 — Backend Audit Batch 11–12 + Attachment UX (#218)

**Date:** 2026-06-05 / 2026-06-06
**Branch(es):** `fix/backend-audit-batch12` (PR #529 — merged), `fix/codeql-unused-device-id` (PR #530 — merged), `feat/attachment-ux-218` (PR #531 — in CI)

## What shipped

### Batch 12 — PR #529 (merged)
Issues: #460 #462 #464

- **#460** `materializer/`: New `SetBlockPageId` incremental task replaces O(N) `RebuildPageIds` on every `create_block`. The materializer now updates only the new block's `page_id` by querying its parent. Bug found during testing: `SetBlockPageId` was dispatched for page-type blocks too; root pages have `parent_id = NULL` → UPDATE sets `page_id = NULL` → violates `page_id_self_for_pages` CHECK constraint → space membership check fails. Fixed by guarding dispatch with `if hint.block_type != "page"`.
- **#462** `gcal_push/connector.rs`: OAuth access token now refreshes when expired (was silently failing with 401 on stale tokens).
- **#464** `rmcp/spike.rs` → `rmcp/examples/spike.rs`: module moved to examples/ so it doesn't ship in production; item-level docs added.

Post-push fix: `.sqlx` cache regenerated with `-- --tests` flag (CI runs `cargo sqlx prepare --check -- --tests`; without the flag, test-only `query!` macros were absent from the cache).

### CodeQL fix — PR #530 (merged)
- `sync_cmds.rs`: Renamed `device_id: &str` → `_device_id` in `confirm_pairing_inner` to fix CodeQL alert #150 (unused variable).
- Dismissed 4 CodeQL false positives: `build-mode: none` doesn't parse tracing `%var` field syntax → variables used via `error = %e` appear unused.

### Attachment UX — PR #531 (in CI)
Issues: #218 items 1, 2, 4, 7

- **Item 2** — Richer rejection toasts: `isAttachmentAllowed` returns `i18nContext` so toasts name the problem:
  "video/mp4 cannot be attached — allowed: images, text, PDF, JSON, ZIP, TAR"
  "File is 112.0 MB — max is 50 MB"
- **Item 4** — Upload progress: files ≥ 1 MB show an indeterminate "Attaching 'name'…" toast through the `readFileBytes` + IPC round-trip, dismissed before the success/error toast.
- **Item 7** — Total size header: `AttachmentList` shows "3 files · 14.2 MB" above the list using i18next plural keys.
- **Item 1** — Empty-block paperclip: empty blocks (no content, no attachments) show a faint Paperclip icon at the trailing edge on hover/focus. Drag-over caption: "Drop to attach — images, text, PDF, JSON, ZIP (max 50 MB)".

Note: Items 3 (rename), 5 (text hover preview), 6 (image resize hint — already implemented) remain open. Item 8 deferred.

## Test fixes

- 4 failing `mcp::tools_rw` tests (`delete_block_happy_path`, etc.) — root cause was the page-block dispatch bug in #460 (see above).
- `materializer_processes_background_tasks_after_page_create` — updated expected task count from 7→6 (no `SetBlockPageId` for pages).
- `file-utils.test.ts` — updated `toEqual` assertions to include new `i18nContext` field.
- `useSlashCommandProperty.test.ts` — updated expected toast string to include interpolation context.
- `StaticBlock.test.tsx` — wrapped empty-content render tests with `TooltipProvider`.

## Open PRs
- **#531** (attachment UX #218 items 1, 2, 4, 7): CI running
