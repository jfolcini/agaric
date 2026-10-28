# Session 2920 — the mock's add_tag refuses a non-tag target

Part of #6054 (mock parity). The backend's `add_tag_in_tx` and `add_tags_by_ids_inner` refuse a tag target that is not a live `tag` block, and `add_tag` refuses a block tagging itself. The mock accepted both.

**Why the mock was lenient:** nine conformance fixtures tagged with pages or content blocks. They passed on the backend only because fixture ops replay through the materializer, which applies a payload without the command's validation. The mock had to stay lenient to match them.

**What changed:**
- **The fixtures tag with real `tag` blocks.** A page used only as a tag was retyped. A page the fixture also reads as a page (`query_trash_and_page_listings`, `purge_subtree_with_satellites`) keeps its type beside a new tag block, so its listing assertions still mean what they did.
- **The mock refuses in the backend's order**, with its kinds and messages: self-tag, then block exists, then the tag exists and is a `tag` block, then cross-space, then already applied. Bulk validates the tag first, then skips bad blocks leniently, as the backend does. `remove_tag` keeps no type check, matching the backend.
- **`tag_add_remove` and `batch_writes` pin each refusal on both stacks.** All ten changed fixtures were re-authored by the backend (`CONFORMANCE_UPDATE=1`).

**Reds:**
- replacing `liveTagBlock(tagId)` with `liveBlock(tagId)` reddens both `tag_add_remove` conformance checks and the unit test;
- dropping the self-tag check does the same;
- dropping the bulk tag check reddens both `batch_writes` checks.

**Suites:**
- vitest over `src/lib`, `src/components/tags` and `src/stores` (6748 passed);
- typecheck and lint;
- the backend conformance run over the authored fixtures;
- Playwright over the tag, query, reference and graph specs (73 passed). `references-filters` failed once under a contended lock and then passed 3/3 alone. It tags with a seed tag block, so this change cannot reach it.
