# Session 2133 — Review notes from today's merges

The reviewer left non-blocking notes on #5573, #5578, #5580, #5584 and
#5586. Each was checked against `origin/main` first.

- **#5578, an un-swept page stays off the Pages list.** Fixed.
  `apply_move_block_sql_only` now passes the ids
  `unsweep_inherited_cohort_after_move` cleared to
  `insert_missing_pages_cache_rows`, after the sweep, so a page that a
  concurrent delete-vs-move merge brings back is listed in the op's own
  transaction, as on every restore path. The call comes after the sweep so
  that a page the sweep trashes again stays unlisted.
  `an_un_sweeping_move_gives_the_page_back_its_swept_row_5371` covers it.
  With the call removed, it fails with `left: []`.
- **#5578, pages with NULL content.** No change. The schema allows a NULL,
  but no writer produces one:
  - Every production writer binds a `String` (`CreateBlockPayload.content`,
    `EditBlockPayload.to_text`, `BlockSnapshot.content`,
    `ensure_space_block`).
  - Recovery's create replay turns a missing value into `""`.
  - No op changes `block_type` alone.
  - The only writer that bound an `Option` was the CBOR snapshot restore,
    deleted in #4699. It copied a peer's rows, so it could only carry an
    existing NULL, never create one.
- **#5586, a comment names the wrong hook script.** Fixed. `append.rs` now
  names `scripts/check-raw-tx.mjs`, which is what the `check-raw-tx` hook
  runs.
- **#5584, three wording nits.** Skipped. #5586 rewrote the `prek.toml`
  comment, which removed the `# fallback — a CLI` stub. The other two nits
  are in `scripts/check-raw-tx.py` and
  `scripts/test-py-guard-file-source.sh`, which #5579 deletes.
- **#5573, the camera spec had never run.** Nothing to do. "Real-backend
  WebdriverIO smoke" ran `camera-permission.e2e.ts` and it passed, both on
  the PR head and in the e2e-tauri run at `83a31dea5`.
- **#5580, the new budget was marked provisional.** Nothing to do. The
  bench-slo run on the PR head measured
  `query_by_property_selective_value_100k` at 0.19 ms, against a 5 ms
  budget.

Ran: the new test, green and then red with the call removed;
`cargo nextest run --workspace`; `cargo clippy --workspace --all-targets
-- -D warnings`.
