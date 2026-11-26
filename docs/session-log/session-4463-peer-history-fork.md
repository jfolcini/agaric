# Session 4463 — the healthy side of a forked pair is told, keeps no refused snapshots, and stops redialling

#7065 step 1, plus two things the build found on the same path. Since Loro 1.16.4, an import that reuses op ids is refused with `LoroError::UsedOpID`. The rewound device already reported `own_history_fork`, but its peer only showed "Sync failed: …".

- **The report.**
  - `snapshot.rs` maps `UsedOpID` to a constant prefix that `is_used_op_id` reads back. Detection is typed, not text matching.
  - Only the catch-up (`merge_one_snapshot`) turns that refusal into `SyncErrorCode::PeerHistoryFork` / `peer_history_fork`. Its sentence names the other device and the recovery: export, set up fresh, pair, import. It is translated in all five locales and mapped in `codedSyncErrorKeys`.
  - The constant log text also makes the repeat-report suppression hold across retries.
- **No refused snapshot is kept.** `apply_remote` writes the blob to `loro_sync_inbox` before importing. A `UsedOpID` refusal now deletes that slot, because the refusal is deterministic, so no replay can import it, and the peer sends it again anyway. Without this, every retry left another full snapshot, and boot replay then moved it to quarantine with its bytes. Other import failures keep their slot for boot replay.
- **The hold.** After a failure coded `own_history_fork` or `peer_history_fork`, the scheduler's backoff no longer lets that peer be dialled automatically: not by mDNS events, change rounds, the resync tick or the frontend's scheduled sync. Before, a forked pair re-ran the whole session, snapshot included, about every minute while both were online.
  - The hold lifts on a press on Sync, a pairing, or a restart.
  - A network rebind no longer clears it (`clear_backoff_for_new_network`).
  - Inbound sessions from a held peer are still answered.

**Not built: detecting the shape that corrupts silently.** A rewound device that has written past its peer's counter for it is not detected. The pull completes, and the healthy device's copy of a lost block is overwritten.
- No message today separates it from a healthy in-app restore: both show differing op-log hashes at the same seq.
- A shorter rewrite fails as an uncoded Loro decode error instead.

The options (a `HeadExchange` field after a spike, or a partial check on the rewound side) went to the maintainer. The docs now say this shape also overwrites the other device's copy, not only that the lost edits never come back.

**Ran:**
- Each new or changed test was shown red before its change, and each falsification went red on its predicted assertion:
  - the report's classification and text;
  - the slot dropped and the slot kept;
  - fork codes held and other codes retried;
  - the rebind keeping a hold;
  - the frontend sentence.
- `cargo nextest run --workspace` over `agaric-sync`, `agaric-engine`, sync, inbox, snapshot and the bindings test: 2660 passed.
- `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all --check`, the `useSyncEvents` and i18n vitest files, `npm run typecheck`, and the pre-commit hooks on the changed files.
