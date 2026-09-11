# Session 1698 — backend nits from the 2026-09-10 review sweep

Seven files of small confirmed findings from the 01-store / 02-sync /
03-commands verdicts, picked up as uncommitted work from a builder that was
killed mid-way. Everything below was re-derived from the code before it was
kept: an inherited diff nobody re-read is a review that did not happen.

`agaric-sync/src/sync_files.rs` carried 02-sync F3, the receiver's
`bytes_total` pre-tally, still a `get_attachment_receive_meta` call per
requested attachment. No new helper was needed: `pretally_bytes_total` has
existed since #2200 Tier-2 for the *sender* side two hundred lines up, with
the same `Ok(None)`/`unwrap_or(0)` tolerance the loop had, and its own tests
already drive a mixed list (two present ids, one never inserted, one
zero-byte row) against a reference implementation of the very loop being
deleted. So the change is the one-line drop-in and a comment identical to
the sender's, no new test, and no `.sqlx` movement — the helper is a runtime
`sqlx::query_as` over `json_each(?1)`, which is this module's idiom for an
id list and already carries its `dynamic-sql:` marker, so no compile-time
`query!` was introduced. The receiver path is not untested either:
`protocol_run_file_transfer_emits_per_buffer_progress` asserts the first
receiving-phase tick advertises a non-zero `bytes_total`, which is exactly
the value this line now produces. The same file's 02-sync F8 nit — a comment
spliced out of two half-sentences ("we still return false-equivalent by not
suppressing the request would be safer") — now says what the code does: a
failed repoint still counts as held, because the bytes are present under the
blob path and the row keeps failing the caller's size check, so a later pass
retries the UPDATE.

`materializer/metrics.rs` and `retry_queue.rs` are 01-store F3, where the
gauge's field docs claimed a stale-LOW `pending_retry_rows` "self-heals: the
periodic sweeper re-clears any leftover rows on its next pass". The
inherited replacement was thirteen lines and, checked line by line, true:
`reindex_restored_cohort_links` passes `metrics: None` and says so itself
("the gauge can only run stale-LOW"); `resolve_referrers_of` seeds
obligations and commits them with the gauge bump skipped; `sweep_once_counted`
deletes only what it retires, so a durable success is cleared solely by the
gauge-gated `clear_on_success`; `lease_entry` leaves `attempts` alone (its
own test is named for it, #378) so `backoff_delay_for(1)` re-leases the row
at one minute; and the exits are real — another failure lifting the gauge,
`spawn_sweeper`'s boot `COUNT(*)` seed, or `GIVE_UP_AGE_DAYS = 7`, which
`ApplyOp` rows are exempt from under #621. True but long: the field doc is
now five lines and the `clear_on_success` mirror three, keeping the
reachable-and-does-not-self-heal claim, the cost (one redundant idempotent
re-run per minute, never a lost task) and the worst-case bound, and dropping
the enumeration a reader can get from the code the sentence names.

`fts/search/fetch.rs` is 01-store F2: `fts_select_prefix_for_test` was a
second hand-copied `format!` that the two tests reading it treated as
"byte-identical to the live query", which it had never been. It now calls
`build_fts_fetch` with every structural filter empty and returns
`.sql`, so the tests read production. That matters because the test doing
the pinning, `fts_cursor_predicate_uses_relative_rank_epsilon_1598`, could
not previously fail for the reason it exists.

`sync_daemon/discovery.rs` with `commands/bug_report.rs` is 02-sync F5: a
`resolve_peer_address` returning `None` was dropped silently by every caller
(`filter_map` in `peers_for_change_round`, an `else`-less `if let Some` in
the periodic-resync branch), so a paired peer with neither an mDNS record
nor a usable cached endpoint id + address is re-selected and skipped forever
with nothing in the log. One `tracing::warn!` at the single site, on one
line and byte-identical to its new `STABLE_MESSAGES` entry so a redacted bug
report keeps it. Frequency was checked rather than assumed, because a warn
inside a shared helper is a flooding risk: the periodic branch is
`RESYNC_TICK` = 30 s, and the debounced-change branch is bounded by
`DEFAULT_DEBOUNCE` = 3 s, so the worst case is one line every three seconds
per unresolvable peer while the user is actively editing. That is within
what a log can carry, and the state it reports is a real misconfiguration,
so it stays a `warn!`.

## Verified

- `cargo check --workspace --all-targets` clean; `cargo fmt --all -- --check`
  exits 0 with nothing to reformat.
- Targeted nextest: `fts_cursor_predicate_uses_relative_rank_epsilon_1598`,
  `partitioned_snippet_skipped_when_post_filter_clears_it`, the four
  `resolve_peer_address` cases, both `pretally_bytes_total` cases and
  `stable_messages_pin_real_call_sites` — 9 passed; plus
  `protocol_initiator_requests_and_receives_files` and
  `protocol_run_file_transfer_emits_per_buffer_progress` — 2 passed.
- Falsified the epsilon pin against a copy of `fetch.rs`, restored `cmp`-clean:
  reverting the production predicate to a fixed `1e-9` reddens the test with
  "cursor keyset must use the relative rank epsilon `1e-9 * MAX(1.0, ABS(?3))`
  (not a fixed 1e-9) — see #1598 (with_snippet=true)", and the SQL it dumps is
  the real one, `snippet(fts_blocks, 1, '', '', '…', 32)` and the
  `ORDER BY fts.rank, b.id LIMIT ?5` tail included. Against the old mirror the
  same revert left the test green, which is the whole finding.
- The `STABLE_MESSAGES` drift guard is non-vacuous for the new entry: it
  demands the literal appear at least twice across the app crate and every
  sibling member crate's `src/`, and the string occurs exactly twice — the
  array entry and the `discovery.rs` call site.
- No binding regeneration: `QueueMetrics` is `#[derive(Debug)]` only (the
  specta type in that file is `StatusInfo`, untouched), and the
  `bug_report.rs` edit is a `const` array entry, not a doc comment on either
  of its two `#[tauri::command]`s.
- Not run locally: the full suites, clippy and the `.sqlx` lanes; CI carries
  them, and no SQL changed.

## Not done

- 02-sync F4, the four dead address-formatting helpers in `discovery.rs`
  (`format_peer_address`, `format_peer_addresses`, `format_ip_with_port`,
  `address_family_priority`), whose ordering policy iroh replaced at the QUIC
  cutover. Deleting them also touches `sync_daemon/mod.rs`'s two `pub use`
  lines and seven tests — a dead-code removal, not a nit.
- 02-sync F6, the `SyncDaemon` shutdown/cancel API that nothing in the app
  reaches, and its now-dead `STABLE_MESSAGES` entry. The verdict's own
  correction is that the entry misleads nobody (the list is a redaction
  allow-list, not a table of contents), so removing the line alone would be
  the least useful half of that change.
- 01-store F1, `list_block_history` ordering a merged multi-device set by
  per-device `seq`. A real user-visible defect, but it needs a cursor change,
  an inverted test expectation and a mock/conformance fixture in the same PR.

## A note on this file's number

The task named session-1695. By the time the log was written `origin/main`
had advanced to `e8d1e8814` and already held 1694, 1696 and 1697, so
`check-session-log-numbering.sh` measures its max over the union of branch
and merge target as 1697 and accepts only 1698–1707. 1695 would have failed
the window check at commit time. If `origin/main` moves again before this
branch is pushed, renumber inside the window rather than rebasing around it.
