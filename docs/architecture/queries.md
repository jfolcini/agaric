<!-- markdownlint-disable MD060 -->
# Search & Query System

How Agaric finds blocks by content, by tag, by property, and by reference.

## Full-text search (FTS5)

Backed by SQLite's FTS5 virtual table (`fts_blocks`) with a **trigram tokenizer** (`tokenize = 'trigram case_sensitive 0'`). The trigram choice is load-bearing: SQLite's default tokenizer doesn't handle CJK languages; trigrams index any 3-character sliding window regardless of language. Minimum query length is 3 characters.

The materializer maintains the FTS index incrementally on every `edit_block` / `create_block`. A full rebuild path exists for migration recovery. The optimize threshold is adaptive — runs after `max(500, block_count / 10_000)` writes, with a 60-minute ceiling so an idle-but-recently-edited vault still gets a maintenance pass.

`sanitize_fts_query` strips injection vectors (`NEAR / * / ( ) :`) while preserving quoted phrases and the `NOT` / `OR` / `AND` operators. Cursor pagination on `(rank, rowid)`.

Search responses include the matching block plus its parent path (via batched `batch_resolve` IPC — see [`data-and-events.md`](data-and-events.md) for the N+1 mitigation pattern).

## Tag queries

Boolean expressions over tags. `TagExpr` (Rust enum) supports `And / Or / Not / Tag(ulid)`:

```rust
enum TagExpr {
    Tag(BlockId),
    And(Box<TagExpr>, Box<TagExpr>),
    Or(Box<TagExpr>, Box<TagExpr>),
    Not(Box<TagExpr>),
}
```

**Evaluation strategy:** the whole boolean tree compiles to a **single id-set subquery** — `And → INTERSECT`, `Or → UNION`, `Not → b.id NOT IN (<inner>)` against the non-deleted universe — pushed down as `b.id IN (<subquery>)`, so SQLite applies the cursor / `LIMIT` keyset directly instead of materialising the full matching id-set into Rust (#1622). `include_inherited` is resolved by joining against `block_tag_inherited` (the materialised cache); soft-deleted blocks are excluded. Pathologically deep trees (depth > `MAX_PUSHDOWN_DEPTH`, never produced by the real `commands::tags` caller) fall back to the legacy materialise-then-`json_each(?)` set path, which stays byte-identical. The `NOT`-into-SQL pushdown that was once deferred here is therefore live; `eval_tag_query_pushdown_matches_oracle_for_complex_expressions` pins the pushdown against the set-based oracle.

## Property queries

`query_by_property(key, value, op)` filters by typed property column. The op enum (`CompareOp`) supports `Eq / NotEq / Lt / Lte / Gt / Gte / Contains`. Numeric / date comparisons use `value_num` / `value_date`; text comparisons use `value_text` / `value_text_in` (LIKE prefix / exact).

Property keys reserved for built-ins (`todo_state`, `due_date`, etc.) are denormalised to dedicated columns on `blocks`. Query for these is direct column comparison; non-built-in keys go through `block_properties`.

## Backlinks

Two flavours:

- **Linked references** — every block carrying a `[[ULID]]`, `((ULID))`, or `#[ULID]` pointing at the target. Backed by the `block_links` / `block_tag_refs` caches.
- **Unlinked references** — case-insensitive substring matches of the target page's title (and aliases) in other blocks' content. Backed by FTS5 with a post-filter.

### Filter dimensions

`BacklinkFilter` (in `src-tauri/src/backlink/filters.rs`) is the full discriminator. Filters compose freely; the algorithm builds a leaf-set per filter, intersects them, applies a keyset cursor, and only then fetches the `BlockRow`s. This shape (filter → set → cursor → fetch) is the same pattern as the agenda filter.

Cursor pagination uses a block-id keyset (Created sort) or a `(value, id)` composite keyset (non-Created sorts). Since #2602 the non-Created (property) sorts paginate with a real keyset — a `(value_{text,num,date}, b.id)` composite with build-time NULLS-LAST handling — pushed into SQL, replacing the former O(n) `.position()` scan over a fully materialised, Rust-sorted page. The database now seeks straight to the cursor and returns one page (`LIMIT + 1`) per request instead of the whole filtered set.

## Inline query blocks

`{{query: ...}}` blocks render a live filtered list inline. The query body is the user-editable text; the result is what renders below.

Implementation reuses the same `query_by_tags` / `query_by_property` / `list_backlinks_filtered` IPCs. Re-fetches on every materialize commit that touches the relevant tables (`block:properties-changed` event for property queries; tag-cache invalidation for tag queries).

`QueryResult` (frontend component) handles paginate / sort / group; the user-facing visual builder is `QueryBuilderModal`.

## Visual query builder

`BacklinkFilterBuilder` and `QueryBuilderModal` are the two visual surfaces. They produce the same `BacklinkFilter` / `TagExpr` shapes the inline-query and agenda surfaces consume. One model, three UI entry points.

## Pagination invariant

Every list IPC is **cursor-paginated**, never offset-paginated. The cursor is opaque (base64-encoded JSON of the sort tuple). Offset pagination was rejected because:

- It silently returns inconsistent results when the underlying set mutates between pages (concurrent edits / sync).
- It can't survive deletion of pre-cursor rows.

The one carve-out is `undo_page_op_inner OFFSET N` — used internally to walk N steps back in the op log. Not user-facing; not over IPC.

Out-of-range limits are **loudly rejected, never silently clamped** (limit-clamp-followup Phase 1): the backend surfaces `AppError::Validation` for any limit outside its cap — `PageRequest::new` accepts `[1, 200]` (`MAX_PAGE_SIZE`); `list_blocks` and `search_blocks` cap at 100 (`MAX_SEARCH_RESULTS` for the latter); `list_projected_agenda` at 500. On the frontend, the `SafeLimit` branded type (`src/lib/safe-limit.ts`, Phase 3) makes every pagination-aware IPC wrapper reject a plain `number` at compile time: literals go through `safeLimit()` / the per-IPC cap helpers, which throw at the call site on a bad value, and dynamically-derived limits go through `clampLimit()` — the one deliberate clamping path, for restored/computed values that should degrade rather than throw mid-render. The result: a bad literal fails at compile time or at its call site, never as a silently truncated result set.

## N+1 IPC mitigation

Two batched IPCs the system relies on heavily:

- **`batch_resolve(ulids: Vec<BlockId>)`** — resolves N ULIDs to titles in one call. Used everywhere chips render (page links, tag refs, block refs). Replaces what was a per-chip `get_block` fan-out.
- **`get_batch_properties(block_ids: Vec<BlockId>)`** — fetches properties for N blocks at once. Used by `BatchPropertiesProvider` to populate property chips across an agenda or backlink list.

Both are the pattern: every read surface that would have called `get_X` per row hoists the call to the parent, batches, and passes a map down via React context.
