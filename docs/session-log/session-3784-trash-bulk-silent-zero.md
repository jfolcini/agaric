# Session 3784 — Trash bulk actions that match nothing stay silent

The maintainer reported that on the 0.23.0 desktop app, Trash's "Empty trash" and "Restore all" left the list unchanged. Their follow-up made it precise: the confirm dialog closed, no toast of any kind followed, and the items were still in the trash after a view change. Nothing had happened, and nothing said so.

A real-backend spec of the plain flow passed: 2 pages, 60 pages across list pages with and without Load more, trashed pages with children, content blocks. So did every shape tried, until the ids changed. `list_trash` returns each id as stored. `purge_blocks_by_ids` / `restore_blocks_by_ids` take `Vec<BlockId>`, whose deserializer uppercases, and match by `json_each` byte comparison. A trashed row stored under a non-canonical (lowercase) id is therefore listed but never matched. The call resolves `{ affected_count: 0 }`, and `TrashView` toasted only on a positive count. Seeding two trashed pages with `lower(id)` in `notes.db` reproduced the symptom exactly.

Shipped: a confirmed Empty trash / Restore all / batch purge / batch restore that affects 0 while rows are listed now logs a warning (which reaches the Rust log) and shows the action's existing failure toast and announcement. `e2e-tauri/trash-bulk-noncanonical-ids.e2e.ts` seeds the shape and was shown red, then green, with `scripts/e2e-tauri-local.sh`. `src/components/__tests__/TrashView.nothing-changed.test.tsx` covers the four handlers, each falsified separately. Single-row restore/purge were already loud: the canonicalised id finds no row and the IPC errors. The Trash count badge (`useTrashCount`) only polls every 30 s and on focus; it wasn't the reported defect and was left alone.

Open, a maintainer decision: which writer stored non-canonical ids in that vault. No current `BlockId` constructor can, and repairing stored ids touches FKs, the op log and Loro. Diagnostic: `SELECT id FROM blocks WHERE id <> upper(id)`.

Suites run: the new spec on the real backend, vitest on both TrashView files, `npm run typecheck`, `npm run lint`.
