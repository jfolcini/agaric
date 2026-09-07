# Session 1590 — conformance query steps compare in order by default (#4670)

## What

`run_query_steps` and its TS twin compared a step's `rows` as a canonically
sorted SET unless the step opted IN with `"ordered": true`. 72 of the 119 query
steps opted in; the other 47 compared nothing about sequence, and the Rust
module doc called this out as "a DELIBERATELY WEAKENED comparison".

The default is now the other way round. Comparisons are ordered; a step opts OUT
with `"unordered": "<reason>"`, and the reason is mandatory — a bare `true`, or a
whitespace-only string, is refused by both runners. Three of the 119 steps opt
out. The other 116 now pin a sequence.

## Why a bare `true` is refused

`expect_empty` and `expect_error` already established the shape: an escape hatch
from an assertion has to say which negative it is claiming, or a fixture author
waves off a step that is broken by mistake as cheaply as one that is deliberate.
`unordered` is the same hatch over the same kind of assertion, so it takes the
same gate — enforced at authoring time in the Rust runner (before
`CONFORMANCE_UPDATE=1` can record anything) and again in the TS twin, which is
what a hand-edit with no Rust toolchain meets.

The TS side re-reads the key as `unknown` rather than through the declared
`unordered?: string`. Its input is `JSON.parse` output, so a fixture spelling
`"unordered": true` arrives typed as a string and would buy the weaker
comparison for free.

## The three steps that stayed unordered, and why they are not divergences

All three call a command with **no `ORDER BY`**. The backend's sequence is the
query plan's, the mock's is its own iteration order, and the command promises
neither, so there is nothing for the two stacks to agree about. The rows still
compare.

- `query_point_reads_blocks` / `batch_resolve_flags_tombstone` —
  `batch_resolve_inner` is `FROM blocks b WHERE b.id IN (SELECT value FROM
  json_each(?1))` with no ordering. The backend answered `B2, B3` (index-scan
  order); the mock answers in REQUEST order, which for this step's
  `["S3", "S2", …]` args is `B3, B2`.
- `query_point_reads_properties` / `get_properties_excludes_column_routed_key`
  and `get_batch_properties_groups_by_block` — `get_properties_inner` and
  `get_batch_properties_inner` both select from `block_properties` with no
  ordering. The backend comes back in primary-key order (`block_id, key`), the
  mock in property-insertion order.

These are worth writing down as an observation rather than a defect: the
backend's order is *deterministic* in practice (it falls out of the index the
plan picks), so the mock could be aligned to it — but aligning it would pin an
order no command guarantees, and the alignment is not what #4670 asked for.
Anyone who later decides the property list's order is user-visible enough to
matter should add the `ORDER BY` to the command first, and then delete the
opt-out here.

## What the flip found

One fixture's recorded rows changed, and that is the payoff. `search_blocks`'s
FTS-ranked steps were being recorded sorted, so their RANK order — the whole
point of the command — was never compared:

| step | was recorded | is recorded |
|---|---|---|
| `query_search_blocks_modes` / `search_fts_widget` | `B2, B3, B4, B6` | `B6, B2, B3, B4` |
| `query_search_blocks_modes` / `search_case_sensitive_widget` | `B2, B6` | `B6, B2` |
| `query_search_blocks_modes` / `advanced_fulltext_widget` | `B2, B3, B4, B6` | `B6, B3, B2, B4` |

`search_blocks_partitioned`'s two `has_more` marker rows likewise now record the
projection's real partition order (`pages` before `blocks`) instead of the
alphabetical one.

`conformance-query-groups.test.ts`'s flat `run_advanced_query` case asserted
`['C1', 'P1']`; the mock returns `['P1', 'C1']`, which is correct —
`resolve_sort` appends a `b.id DESC` terminal tiebreaker when the request names
no sort. The old expectation was the sorted projection, not the query's answer,
and its comment said "in canonical order" without noticing the difference.

## Falsification

- TS: forced `rows` back to always-sorted → 12 failures across `conformance.test.ts`
  and the new `conformance-query-ordering.test.ts`. Restored from a copy, `cmp` clean.
- Rust: forced the sort branch to always taken (`if true || unordered.is_some()`)
  → `conformance_fixtures_match_backend` red. Restored from a copy, `cmp` clean.
- The three surviving `unordered` steps were red *before* their opt-out was
  added, which is the evidence that each one is load-bearing rather than
  decorative.
- The reason gate has both arms on both sides: `unordered: true` and a blank
  string each rejected (`a_reasonless_unordered_opt_out_is_rejected` /
  `a_blank_unordered_reason_is_rejected` in Rust, the matching pair in
  `conformance-query-ordering.test.ts`), paired with a step that carries no key
  and one that carries a real reason, so the gate cannot pass by rejecting
  everything.

## Result

`cargo nextest run --workspace -E 'test(conformance)'` — 92 passed.
`npx vitest run src/lib/tauri-mock/__tests__/` — 39 files, 806 tests, all passed.
