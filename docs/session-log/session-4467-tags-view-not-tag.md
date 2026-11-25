# Session 4467 — the Tags view drops its tag-filter panel, and Search gains `not-tag:`

The maintainer asked whether the Tags view's tag-filter panel, which filters blocks, belonged there when Search covers tags as well or better. The panel had AND/OR/NOT over selected tags, tag-name prefix pills, a nested composer and an include-nested switch.

Search's filter-only queries already covered:
- AND (`tag:#a tag:#b`);
- OR, with parentheses (`tag:#a OR tag:#b`);
- inline and inherited matches (`under:#tag`);
- the tag hierarchy;
- combining with text, state, dates, properties and pages.

Only NOT and name-prefix matching were missing. The maintainer chose to remove the panel and add `not-tag:`.

**Removed.**
- The Tags view renders only the tag list. TagList's `children` slot, which only held the panel, goes too.
- `TagFilterPanel`, `TagComposer` and `src/lib/tagExpr.ts`, which only those two used, are deleted with their tests, the 59 `tagFilter.*` keys in five locales, and their stryker entry.
- The `query_by_tag_expr` IPC lost its last caller and is gone end to end: the command, its registration, bindings, the mock handler, the `WIRE` entry, the conformance arm and its fixture steps.
- `query_by_tags` stays: older query blocks call it.
- e2e: `tags-query-modes.spec.ts` and the panel tests in three other specs covered only the panel, as did `tag-management.spec.ts`'s check that a space with no tags offers no filter (#7040). Their AND and OR scenarios now live in `e2e/search-filters.spec.ts` on the bridge.

**`not-tag:`.**
- `not-tag:#x` drops blocks carrying x, or a tag nested under it, attached to the block. That is exactly what `tag:#x` keeps.
- It is never widened by `under:`, so `under:#a not-tag:#b` keeps meaning "under a, minus what carries b".
- Backend: `SearchFilter.excluded_tag_ids` (`#[serde(default)]`), compiled once in `add_metadata` as a `Not(Or[Tag])` projection. So FTS, regex, filter-only and partitioned search all apply it. A `not-tag:`-only query runs as filter-only.
- Frontend: the token is registered through `registerTokenPrefix`, with serializer, autocomplete and the name-resolution hold. A `Not` node is used inside OR queries, and query blocks support it.
- The mock's search stays a thin stub (#6529); two backend-authored conformance steps pin the semantics.

**Review.**
- No blocking defect.
- Four comment and doc fixes:
  - a stale "conformance ratchet" comment;
  - the `TagExpr` IPC doc;
  - the Obsidian matrix row;
  - the precise `not-tag:` rule for a name that is not itself a tag.
- Left for follow-up: unknown `not-tag:` names are silent in Search, as unknown `tag:` names already are. `TagExpr` still derives serde and specta that nothing uses.

**Ran.**
- `cargo nextest run --workspace` over search, fts, filter, conformance, tag, metadata and the bindings test: 1711 passed.
- `cargo clippy --workspace --all-targets -- -D warnings`, `SQLX_OFFLINE=true cargo check --workspace --all-targets`, `cargo fmt --all --check`.
- `just check-fe`: 27357 passed.
- Bridge `e2e/search-filters.spec.ts`: 24 passed.
- The new Rust, frontend and bridge tests were each shown red under a mutation of the code they cover.
