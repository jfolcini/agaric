# Session 4281 — restore from a daily snapshot without breaking sync

#6744's restore, the second slice of the plan decided on #6524 (2026-11-18). The spike (#6888) had shown that a restore converges if the database's Loro peer-id epoch is changed before any engine loads. The device's old PeerID is then just another peer, and the paired device gives back the edits the snapshot lost. Without the bump the loss is silent.

What shipped:

- **Settings › Data › *Restore…*:** picks a daily snapshot, writes `notes.db.restore-pending`, and relaunches.
- **`db::snapshot_restore::restore_pending`**, at the top of `init_persistence`, before the pools open:
  - copies the snapshot, then in one transaction writes a random non-zero epoch, every device's high-water mark (carried from the live vault when it is readable), `mirror.restored` and read-back off;
  - keeps the old vault with its `-wal`/`-shm` as `notes.db.pre-restore-<ts>`, renames the copy in, and moves the attachment files only the old vault refers to into `notes.db.pre-restore-<ts>.attachments/`;
  - drops the mirror's folder states through `mirror::store::forget_everything`, and removes the marker last.
- **Interrupted swaps:** a swap interrupted before the old vault moves is abandoned; one interrupted after is finished at the next boot.
- **`prune_replaced_vaults`:** runs on the daily-snapshot tick and deletes a replaced vault and its attachments 30 days after the restore, reading the time from the file name.

Maintainer decisions taken in this session: move the attachments aside rather than exempt them from the orphan GC, and let the kept vault and its attachments share the 30 days.

Traps:

- **The Markdown mirror (#6887 A, B).** With the database rewound and its folder states kept, the first pass would have removed the files of pages made since the snapshot. Dropping the states alone was not enough: with read-back on, resuming reads those files in as new pages, and the peer's sync then duplicates them. So the restore pauses the mirror, drops its states and turns read-back off. Turning it back on goes through the consent gate.
- **Pairings.** A device paired after the snapshot is unpaired by the restore; the docs say "keeps the pairings it had when the snapshot was taken".

Docs corrected wherever they said nothing restores a snapshot, or that a restored device's failed sync says so: `import-export.md`, `TROUBLESHOOTING.md`, `sync.md`, `FEATURE-MAP.md`, and the Logseq and Obsidian comparisons.

## What ran

- `cargo nextest run -p agaric --lib -E 'test(snapshot_restore::) | test(daily_snapshot::) | test(mirror::) | test(ts_bindings_up_to_date) | test(boot)'`, then `cargo clippy --workspace --all-targets -- -D warnings` and `SQLX_OFFLINE=true cargo check --workspace --all-targets`.
- vitest on the settings, tauri-mock, i18n and e2e-tauri suites; `npm run typecheck` and `npm run lint`.
- Each new test was shown red against a stub, and each load-bearing behaviour was falsified once: epoch, marks, `-wal` move, finished-swap branch, attachments set aside, the 30-day boundary, the tick calling the sweep, read-back left on, and the states dropped. A second reviewer falsified the epoch and mirror tests again.
- `e2e-tauri/snapshot-restore.e2e.ts` has not run locally: there is no WebDriver here. CI's real-backend lane is its first run.
