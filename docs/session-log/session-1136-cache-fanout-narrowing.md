## Session 1136 — narrow single-block cache fan-out (#2037, part 1) (2026-06-30)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-30 |
| **Subagents** | orchestrator-only |
| **Items closed** | partial progress on `#2037` (issue stays open for the delete/restore/purge arm) |
| **Files touched** | `src-tauri/src/materializer/dispatch.rs` |
| **Tests added** | 5 dispatch pinning tests; 3 existing create tests updated |

**Summary:** `#2037` — single-block ops enqueue full-vault cache rebuilds regardless of block
type/key. This lands the two narrowings that are provably correct from the op **payload alone**
(no dispatch-signature threading), each pinned by a `materializer::dispatch` test:

- **CreateBlock no longer enqueues `RebuildProjectedAgendaCache`.** A freshly created block carries
  no properties (those arrive via later `SetProperty` ops), so it cannot yet have a `repeat`
  property and therefore can never be a row in `projected_agenda_cache` (the rebuild joins
  `key = 'repeat'`). The `SetProperty('repeat', …)` that later makes it repeating enqueues the
  projected rebuild itself. (`RebuildTagInheritanceCache` is intentionally KEPT on create —
  narrowing it needs a create-under-tagged-parent audit; conservative = correct.)
- **SetProperty/DeleteProperty narrow the two agenda rebuilds by key/value.** `agenda_cache`
  depends on date-VALUED properties + the `template`/`due`/`scheduled` keys; `projected_agenda_cache`
  depends on the recurrence keys (`repeat`/`repeat-until`/`repeat-count`/`repeat-seq`) + date columns
  + `template`. A plain `SetProperty` (status/colour/text/ref…) now enqueues NEITHER rebuild. A
  `delete_property` keeps its agenda rebuild (the deleted value's date-ness is unknown) and narrows
  only the projected one by key. A corrupt payload falls back to both.

These dependency sets were read directly from `cache/agenda.rs` (`DESIRED_AGENDA_SQL`) and
`cache/projected_agenda.rs` to avoid missing a key (a miss = stale cache).

**Verification:** `materializer::dispatch` 33/33 (5 new: plain-key skips both, repeat→projected-only,
date-value→both, delete plain-key→agenda-only, corrupt→both; + 3 create tests updated). The 3 broader
create/apply tests that the full single-process `cargo test materializer::` run flagged were confirmed
**pre-existing flakes** — clean `main` aborts the same suite (SIGABRT, a *different* failing set each
run) via a loro-internal richtext/sync panic under parallel single-process load; CI runs nextest
(per-test process isolation), and the three pass deterministically in isolation both on main and with
this change. `cargo clippy -p agaric --lib -- -D warnings` + `cargo fmt --check` clean.

**Remaining (#2037, part 2 — follow-up):** the Delete/Restore/Purge arms still
`extend(FULL_CACHE_REBUILD_TASKS)` unconditionally. Narrowing them needs the affected block's
`block_type` threaded into the dispatch call (production passes `block_type_hint: None`) plus a
confirmation of whether soft-delete/restore can shift inherited tags (does the inheritance CTE filter
`deleted_at`?). Deferred to keep this change payload-only and provably correct.

**Observation for the maintainer:** the loro-1.13.6 richtext/sync panic under heavy parallel
single-process `cargo test` is reproducible on `main` and may surface as CI flakiness on the
materializer proptests; worth a separate look (possibly a nextest retry policy or a loro bump).

**Commit plan:** part-1 commit on `claude/issue-2037-cache-fanout`, draft PR referencing #2037
(does NOT close it).
