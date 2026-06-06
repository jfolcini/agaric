# Schema lessons

The migration log is append-only. Every column or table we add ships forever,
even after we delete it: the `ADD` migration stays in the history, and removing
it requires a second `DROP` migration that itself becomes permanent. Schema
churn is therefore not free — it leaves a permanent trail of dead migrations,
back-compat handling, and code that read or wrote the now-defunct fields.

This document records three real cases of churn (columns/tables added and then
removed) and the forward-looking rule each one teaches. The goal is not
migration archaeology; it is to avoid repeating the same mistakes the next time
we are tempted to extend the schema.

Related reading: [`AGENTS.md`](../../AGENTS.md) and
[data and events](./data-and-events.md).

## Case 1: Conflict-tracking columns (#549)

### What happened

The `blocks` table carried explicit convergence/conflict state for most of the
project's life:

- `is_conflict` — added in `0001_initial.sql`
- `conflict_source` — added in `0001_initial.sql`
- `conflict_type` — added in `0007_add_conflict_type.sql`
- `idx_blocks_conflict` — added in `0049_index_blocks_conflict.sql`

When Loro (CRDT) replaced the hand-rolled 3-way merge, all of this became dead
weight. It was torn down across `0058_pend_09_drop_is_conflict.sql`,
`0059_pend_09_drop_conflict_type.sql`, and
`0060_pend_09_drop_conflict_source.sql` (the index went with its column).

### Lesson

Before adding a column or table to `blocks`, ask: **"will Loro/CRDT make this
obsolete?"** Convergence state — whether two replicas disagree, how they
disagreed, which side won — is almost always redundant under the CRDT model,
because the CRDT *is* the merge. Persisting derived conflict state alongside it
duplicates the source of truth and guarantees a future teardown.

## Case 2: `archived_at` (#550)

### What happened

`archived_at` was added to the schema in `0001_initial.sql` as a
"we'll need soft-archive later" column. It was never populated — its value was
always `NULL` — and it was removed in `0018_remove_archived_at.sql` without ever
having been used.

### Lesson

**Do not add speculative "we'll need it later" columns.** Add a column only for
a concrete, imminent use. Schema added on spec costs migrations, query noise,
and back-compat surface, and — as here — frequently gets deleted before it ever
holds a value. If the need is real but not yet here, add the column when the
feature lands, in the same change set that reads and writes it.

## Case 3: `merge_parity_log` table (#551)

### What happened

`merge_parity_log` was a diagnostic table used to validate the Loro cutover. Its
entire lifecycle was build-up and tear-down inside the migration log:

- created in `0051_pend_09_merge_parity_log.sql`
- extended in `0054_pend_09_classifier_partial_index.sql`,
  `0055_pend_09_parity_log_authoritative_column.sql`, and
  `0056_pend_09_cutover_default_on.sql`
- dropped in `0057_pend_09_drop_merge_parity_log.sql`

Seven migrations, start to finish, for a table that was only ever an
observability scratchpad.

### Lesson

**Diagnostic and observability tables should not be shipped as permanent
schema.** Prefer a `_diag_*` prefix (so they are obviously throwaway), or keep
them as temporary/untracked tables created at runtime, and clean them up before
the work merges. A diagnostic that lands in the production schema and is later
removed pays the full append-only churn cost for something that was never meant
to outlive the investigation.

## Checklist before adding schema

- **CRDT check:** Will Loro/CRDT make this obsolete? Convergence/conflict state
  on `blocks` is almost always redundant under the CRDT model — do not persist
  it.
- **No speculation:** Add the column or table only for concrete, imminent use,
  in the same change set that reads and writes it. No "we'll need it later"
  fields.
- **Diagnostics stay out of prod schema:** Observability/diagnostic tables get a
  `_diag_*` prefix or stay temporary/untracked, and are cleaned up before merge
  — never shipped and then dropped.
