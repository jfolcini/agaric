# Session 1758 — four notes from two merged PRs

Non-blocking notes from #5024 and #5025, collected at the sweep boundary as
AGENTS.md prescribes: merge the approved PR as it stands, then act on its notes
once, across the PRs merged together.

## The derivation that was still two derivations

#5024 set out to remove "two sources for one number" and removed the
*parameter* instead: `fetch_group_buckets` stopped being passed the slot and
started computing `ctx.next_pos + usize::from(key.bind.is_some())` itself —
which is character for character what `fetch_member_preview` already computed
as `in_start`. One producer plus one copy became two copies. The comment added
in that PR argued against exactly the shape it left in place.

`GroupKeySql::first_free_pos(&self, ctx)` is the derivation, once, for the
reason `QueryCtx::has_fulltext` is a method. Both helpers call it.

Falsified both ways, because a bind-numbering change is the class that has
produced a surviving mutant in three of the last four slices: drop the key's
own slot and **7** tests red; add it unconditionally and **8** red, a nearly
disjoint set (the first set is the keys that HAVE a bind, the second the keys
that do not). Restored and `cmp`-verified.

## A comment that was false about the code under it

`SNAPSHOT_OPS_INERT` said "Empty today, but NOT because the sweep found
nothing" and "This map is empty because those two were REPAIRED" — directly
above a map with one entry. #5022 added that entry; #5024 deleted the newer
paragraph that had reconciled the two, leaving the older text flatly
contradicting the code two lines below it.

The #3966 point worth keeping is that a waiver is the last resort and the two
fixtures the sweep found were repaired rather than waived. That survives in
four lines, without claiming the map is empty.

## Two stale pointers in the fresh split

- `query_by_property`'s routing doc still told a future maintainer to update
  "the `match col { … }` arm below". #5025 moved that match into
  `reserved_column`, where it matches on `key`, so the instruction pointed at
  nothing.
- `col = col` in the reserved-path `format!` is a redundant named argument;
  implicit capture already works, as the sibling `{text_pred}` / `{date_pred}`
  demonstrate.
