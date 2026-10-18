# Session 2502 — a backlinks query lists the blocks that link to its target

The #5736 sweep found that `{{query type:backlinks target:X}}` listed X's
direct children, not the blocks linking to X.
- **The cause:** the resolver mapped it to `ChildOf { parent: X }`, keeping
  the legacy `list_blocks(parent_id=…)` path.
- **What the product promises:** the docs and the query builder's helper
  text promise referrers.
- **Who it hurt:** a user who inserted a backlinks query saw the page's own
  blocks and never who referenced it.

**Changed:**
- **The resolver** maps a backlinks query to the existing `LinksTo { target }`
  primitive. The Advanced Query surface already allows it, so no Rust change
  was needed. The result is the set `get_backlinks` serves. Unlike the
  References panel, it keeps referrers on X's own page.
- **Deleted:** the `list_blocks` fallback. A backlinks query with a target
  always compiles, so the fallback was dead.
- **The mock** evaluated `LinksTo` as match-all. It now scans for the link
  the way its `get_backlinks` does. This also fixes the Advanced Query
  view's links-to chip in the mock.
- **Copy:** the builder's preview reads "Blocks that link to …" (it said
  "Pages"), and the stale "legacy backlinks" wording around `ChildOf` is
  gone, including the bindings copy.

**Tests:**
- **The resolver mapping:** a vitest.
- **A referrer test through the real mock:** a referrer on another page is
  the query's only result.
- **A mock-lane spec in `e2e/query-blocks.spec.ts`:** a backlinks query on a
  page with children and one referrer lists only the referrer.
- **A conformance step in `query_backlinks.json`:** `run_advanced_query`
  with `LinksTo` returns the live referrers, with the expected rows written
  by the backend. That pins the mock's `LinksTo`.

**Shown red:**
- **The resolver back to `ChildOf`:** the vitests and the spec fail (the
  spec reads the page's children instead of one result).
- **The mock `LinksTo` matching everything:** the equivalence test and the
  conformance step fail.

**Ran:**
- vitest over `src/hooks`, `src/lib`, `src/components/query` and the query
  builder;
- the inline-query specs;
- the backend conformance test with `CONFORMANCE_UPDATE=1`, and the specta
  bindings test;
- `npm run typecheck`, `npm run lint` and oxfmt.
