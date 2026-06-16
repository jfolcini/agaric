# Session 1051 — #676: scoped tag-usage refresh instead of O(vault) RebuildTagsCache

2026-06-16. `/loop /batch-issues` run (backlog, perf).

## Problem
Every `add_tag`/`remove_tag` enqueued `MaterializeTask::RebuildTagsCache`. Although its
sort-merge diff WRITES O(diff) (#113), it COMPUTES by streaming the whole vault (all
`block_type='tag'` blocks × the full `block_tags ∪ block_tag_refs` union, plus the full
`tags_cache`). So the read/compute cost was O(vault) per tag click.

## Fix
A scoped `MaterializeTask::RefreshTagUsageCount { tag_id }` recomputes only the affected
tag's `(name, usage_count)` row via `DESIRED_TAG_USAGE_SQL` — the **identical** usage
subquery + name-dedup rule (`NOT EXISTS smaller-id same-name`) as the full rebuild, scoped
by `tag_id` — and UPSERTs that single row. A corrupt/empty payload falls back to the full
`RebuildTagsCache` (correctness over the perf win).

**Correctness (incremental == full rebuild):** an add/remove_tag edge op mutates one
`block_tags` edge; `name` (from `blocks.content`), the cached row SET, and the same-name
winner are all invariant under edge ops — only the affected tag's `usage_count` can move.
Verified equal to a full rebuild for add / remove / re-add (PK-dedupe) / remove-missing /
name-loser / inline-ref. Collateral fixes: `dedup.rs` keys the task per-`tag_id` (else two
tags' refreshes in one drain collapse) and `retry_queue.rs` persists/reconstructs it
per-`tag_id` (per-tag retryability).

## Verification
3 cache tests (each case == full rebuild, + scoping: unrelated tags untouched) + dispatch
pinning (add/remove enqueue `RefreshTagUsageCount`, not `RebuildTagsCache`; missing tag_id
falls back). Reviewer confirmed the scoped-vs-full SQL equivalence line-by-line and the
invariant. Full Rust suite 4177 passed (incl. #1269 tag conformance fixtures); clippy clean.
No SQL-macro change → no `.sqlx` regen.
