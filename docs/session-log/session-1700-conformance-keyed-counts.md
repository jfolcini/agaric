# Session 1700 — the keyed-count read waivers (#3830)

Three read commands were waived from the #763 read differential for one
shared reason: "returns a keyed count map, not the canonical block-id rows the
query projection binds" — `count_backlinks_batch`, `trash_descendant_counts`
and `count_agenda_batch_by_source`. This session lifts all three, plus two
owed notes from earlier reviews.

## The shape

`count_trash` answered the same objection for a BARE scalar in the previous
slice: the whole answer IS the token (`count_trash#value=5`), rendered through
`attr_value` so the count crosses the same Rust/JS number-rendering guard every
other numeric attribute does. The generalisation to a map is one token per
entry, `<key>#count=<n>`, and for the nested `date -> source -> count` map
`<date>-><source>#count=<n>`.

Three decisions are worth naming:

* **The key is the token HEAD, not an attribute name.** `relabel_token` /
  `relabelToken` rewrite heads (and both sides of an `->` head) through the
  canonical `Bn` map and never touch an attribute NAME. `count_backlinks_batch`
  and `trash_descendant_counts` are keyed by block ids, which are stack-local
  until they are relabeled, so a `<command>#<key>=<count>` spelling would have
  compared raw ids.
* **The nested level reuses `->`** rather than inventing a separator. It is
  already the map-key separator in the grammar (`map_row_tokens`,
  `map_rows_tokens`), it is already relabeled on both sides, and both segments
  go through `token_head`, so a key carrying `#` or `->` is REFUSED rather than
  aliasing. The alternative considered — a `/` path join — has no such guard,
  and `property:<key>` sources carry user-authored text.
* **Sorted in the projector.** A `HashMap` has no order on either stack, so the
  projection imposes one instead of making every step buy the `unordered`
  opt-out. The sort runs before relabeling, which is a real limit and is
  documented on both helpers: a fixture whose map keys were OP-CREATED ids
  would still need `unordered`. Every key used today is a seed id or a
  fixture-authored date.

One new rows shape on each side (`count_map_tokens` / `count_map_result` in
`conformance_query.rs`, the `count-map` `RowsLocation` and `countMapTokens` in
`conformance-query.ts`), three wiring arms, no per-command special casing. The
existing `value` shape is untouched. `countMapTokens` is module-local, unlike
its two exported neighbours: those are exported because no fixture drives them,
and this one is driven by four steps.

## Per-command steps

`count_backlinks_batch` folded into `query_backlinks.json`, whose seed already
holds everything the counts need:

* `backlink_counts_per_page` — `pageIds: [S1, S9, S6]`. S1 counts three
  (S3, S4, S7: S5 unlinked, and S8's edge survives its tombstone in
  `page_links` but its source is dropped by `b.deleted_at IS NULL`); S9 counts
  one even though S9 itself is deleted, because the filter is on the SOURCE
  block (#4853); S6 is ABSENT rather than zero.
* `backlink_counts_global_scope` — the `Global` twin. NOT an `expect_error`
  one: unlike `count_trash`, this command SERVES `Global` unscoped
  (`?2 IS NULL`) rather than refusing it through `require_active`. The same is
  true of `count_agenda_batch_by_source`, so neither got the refusal twin
  `count_trash` has; the one refusal available in this group is the agenda
  date validator, and it is pinned below.

`trash_descendant_counts` and `count_agenda_batch_by_source` in a new
`query_keyed_counts.json`. Neither existing fixture's seed fit: the trash
fixture has a single cascade cohort of depth one (no second key to differ
against) and `agenda_basic` has one dated block, so folding either in would
have meant re-authoring a carefully narrated fixture's `expected` and its
comments for a reason unrelated to what it pins.

* `trash_descendant_cohort_counts` — `rootIds: [S2, S7, S5, S1]`. S2 counts
  two, S7 counts one (so a mock answering the same number for every key differs
  on one of them); S5 is absent because its only child was deleted by an
  EARLIER op and sits in a different `deleted_at` cohort; S1 is absent because
  it is LIVE and `rb.deleted_at IS NOT NULL` never seeds the walk from it.
* `agenda_counts_by_date_and_source` — `dates: [2026-07-01, -02, -03]`.
  2026-07-01 holds two `column:due_date` and one `column:scheduled_date`;
  2026-07-02 holds ONE, because S12 is both due and scheduled that day and
  `agenda_cache`'s PK is `(date, block_id)`, so `DESIRED_AGENDA_SQL`'s priority
  order keeps only the higher-precedence source; 2026-07-03 is absent.
* `agenda_counts_global_scope` — the served-`Global` twin.
* `agenda_rejects_malformed_date` — `expect_error: "validation"`, the group's
  one refusal: `validate_date_format` runs over every date before the query.

The dates arrive through OPS, not the seed: `agenda_cache` is materialized, and
`set_due_date` / `set_scheduled_date` are what enqueue `RebuildAgendaCache`.

## Mock divergences the waivers were covering

Five, all found by the new steps, all fixed in the mock:

1. `count_backlinks_batch` seeded EVERY requested id with its count, including
   zero, where the backend's `GROUP BY bl.target_id` never emits an empty
   group. Red line: `+ "B6#count=0"`.
2. `trash_descendant_counts` counted every tombstone in a root's subtree
   instead of the root's own `deleted_at` COHORT, so a root whose child had
   been deleted earlier claimed a descendant the backend puts elsewhere. Red
   line: `+ "B5#count=1"`.
3. The same handler answered for a LIVE root by walking its subtree for
   tombstones; the backend's CTE is seeded only from a tombstoned root. Red
   line: `+ "B1#count=7"`.
4. `count_agenda_batch_by_source` counted `due_date` and `scheduled_date`
   independently for the same block on the same date, inventing a source the
   `(date, block_id)` PK cannot hold. Red line:
   `+ "2026-07-02->column:scheduled_date#count=1"`.
5. The same handler did not validate its dates, so a malformed date answered an
   empty map where the backend refuses. Red line: `- "error": "validation"` /
   `+ "error": null`.

The mock still does not model the other two agenda sources (`property:<key>`
for a `value_date` property, `tag:<id>` for a `date/YYYY-MM-DD` tag). Both
OUTRANK the two column sources, so neither can be shadowed by what is modelled;
no step exercises them, and the gap is recorded in the handler.

Two `tauri-mock.test.ts` unit tests were pinning the old behaviour and had to
move with it — the obligation a tightened invariant creates. `count_backlinks_batch`'s
asserted `result[TAG_IDEA] === 0` (now `toBeUndefined`), and the trash test
deleted the child FIRST and expected 1; it now deletes the parent only, so the
cohort is real and the assertion still says 1. Those two files are outside the
slice's stated blast radius and are named here for that reason.

## Falsification

Each of the three counts was broken against a `cp` copy, run red, restored, and
`cmp`-verified:

* drop the `!b['deleted_at']` filter in `count_backlinks_batch` →
  `query_backlinks` red, `- "B1#count=3"` / `+ "B1#count=4"`.
* stop the trash walk at direct children → `query_keyed_counts` red,
  `- "B2#count=2"` / `+ "B2#count=1"`.
* invert the agenda source precedence → `query_keyed_counts` red,
  `- "2026-07-02->column:due_date#count=1"` /
  `+ "2026-07-02->column:scheduled_date#count=1"`.

The five divergences above are their own falsification: each was observed RED
before the fix and is quoted with its step above.

## The ratchet

`NOT_YET_PINNED_READ` is down to 17 entries from 20 (line-based count of the
array). The three lifted entries' prose in `READ_NO_QUERY_ALLOWLIST` was
rewritten rather than deleted, in the shape #3826 set: the section now says
which fixture drives each command and which divergence the waiver had been
covering. `SWEPT_ARM_COUNT` in `reader_delegation_tests` moved 38 → 41 with the
write-sweep note for the three new arms: all three are `GROUP BY` SELECTs, and
the agenda one READS the materialized cache without rebuilding it, so
`derived_cache_digest`'s three-table scope is unchanged.

## The two owed notes

* `resolve_peer_address`'s doc (`sync_daemon/discovery.rs`) said "every call
  site drops it silently". The review note asking for the singular named one
  call site; re-checking found TWO production ones — the periodic round's
  `if let Some(peer)` in `session_supervisor.rs` and
  `peers_for_change_round`'s `filter_map` in the same file as the function. The
  doc now names both rather than asserting a number, since the singular would
  have been a fresh false claim.
* `batch_ops_for_wire_partitions_under_cap_2481` (`sync_protocol/tests.rs`) had
  a `one * 2 - 1` → 5 assertion beside its `one * 2` → 3 one. It kills no
  mutant: a `>` implementation answers 5 for both, so only the inclusive-cap
  assertion discriminates. Deleted, with the comment rewritten to say why the
  remaining one IS the boundary (#4954).

## Not done

* No `expect_error` twin for the `Global` scope of the two scoped commands —
  `Global` is a legal, served answer for both, and the harness has one space, so
  those twins pin only that the command is not refused.
* The batch-size caps (`ensure_batch_within_cap`) are not pinned on any of the
  three; a step would need more ids than a fixture seeds.
* The agenda `template`-page exclusion and the two unmodelled agenda sources
  are unexercised, as above.
