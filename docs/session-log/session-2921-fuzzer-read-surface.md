# Session 2921 — the differential fuzzer compares reads

Item B4 of #6054 (mock parity), plus the B1 leftover (limit refusals).

**Why:** the fuzzer compared only the final snapshot. That snapshot holds no tag refs, inherited tags, caches or space ids, so every derived view the mock computes for itself was invisible to it.

**What changed:**
- **A fixed read set after every chain.** It runs on both stacks through the existing query runners (`run_query_steps` / `runQuerySteps`):
  - page listings, tags, backlinks and tag queries;
  - agenda counts, unfinished tasks, search and advanced query;
  - page links, unlinked references, trash and the page subtree;
  - per-block tag reads.

  Created blocks are addressable as `Cn` in both query twins.
- **Unordered reads:** a read that tie-breaks on raw ids is compared unordered, each with its reason. Raw ids differ between the stacks.
- **Limit refusals:** each capped read also gets limit 0 and cap+1, and the refusals are compared.

**Divergences found and fixed,** each pinned by a backend-authored fixture:
- **Limits:**
  - `run_advanced_query`, `query_by_tags`, `query_by_tag_expr` and `list_unfinished_tasks` took an out-of-range limit;
  - `query_by_tags` with no tags checked the limit, where the backend answers an empty page first;
  - `list_unfinished_tasks` defaulted to 200, not 50. No fixture can show a default without 51 rows, so that one is not pinned.
  - Left alone: the mock's grouped `run_advanced_query` still takes any limit. Its grouped path is a stub that makes up one bucket, and the coverage ratchet waives it until it computes real groups. A refusal step there would count as coverage it does not give.
- **The mock's space stamp** missed seeded root tags.
- **The Rust harness:**
  - a seeded tag never reached `tags_cache`, so `rebuild_tags_cache` now runs after the seed;
  - the post-op stamp left `pages_cache.space_id` behind `blocks.space_id`.

**Harness decisions:**
- **The `pages_cache` copy fills only rows whose `space_id` is null.** A blanket update would hide a real backend bug: a command that moves `blocks.space_id` but leaves the cache row naming the old space.
- **A `create_space` block is listed as a page of the test space** on both stacks, unlike production. `query_space_block_pages_cache.json` therefore pins agreement between the harnesses, not production behaviour.

**What the read tally shows:** with 256 cases, the backlink, unlinked-reference, page-link and unfinished-task reads never answer a row. The generator has no link tokens yet (item B2) and no `todo_state` key. The tally skips the zero-count envelopes that grouped reads and `count_trash` always carry, so it no longer reports those reads as answering.

**Reds:**
- reverting the tag widening in `stampMockSpace` turns the fuzzer red. It shrinks to one op whose `run_advanced_query` read diverges;
- restoring the 200 default reddens `query_read_limit_refusals` on both `unfinished_limit` steps.

**Suites:**
- the fuzzer at `PROPTEST_CASES=256`;
- `cargo nextest run --workspace -E 'test(conformance)'`;
- clippy, `SQLX_OFFLINE` check and fmt;
- vitest over `src/lib/tauri-mock`, typecheck and lint;
- Playwright over the advanced-query, tag and search specs.
