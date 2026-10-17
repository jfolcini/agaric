# Session 2483 — a search result for an indented block opens its page

The #5738 sweep found that clicking a search result for a block nested
under another block navigated to its `parent_id` as if it were the page.
- **On the real backend:** `load_page_subtree` accepts a content block,
  because content blocks carry a `space_id`, and returns an empty subtree.
  The user saw a "page" titled with the parent block's text, and the editor
  then created a stray blank block under it.
- **In the mock:** the click bounced back to Search with "This page was
  moved to another space".

**Changed:**
- **Search results** open `block.page_id` with the block focused. A row
  with no page shows the existing no-parent-page notice and never falls
  back to `parent_id`.
- **The same parent-as-page shape** is fixed in three twins:
  - the tag filter's results;
  - the query table's Page link;
  - `((block ref))` / `[[ULID]]` chip navigation, where an indented target
    on the same page is now focused in place.
- **Two `BlockTree` test fixtures** gave a content block a parent but no
  `page_id`, a shape the backend never produces. Review gave them their page
  id.

**Specs:**
- **`e2e-tauri/search-nested-result.e2e.ts`** builds a page with a parent
  and a Tab-indented child through the UI, then searches and clicks the hit.
  - The page opens with exactly its two rows and the editor in the child.
  - The page is unchanged after Journal and back.
- **`e2e/search-nested-result.spec.ts`** covers the same flow in the mock
  lane.

**Shown red:**
- **The real-lane spec:** on the unfixed binary, and on a binary rebuilt
  with the navigation mutated.
- **The mock spec:** with `page_id` back to `parent_id`. The focus assertion
  is the kill; the title alone survives, because the heal returns to the
  previous page.
- **Each twin's unit test,** with its own line reverted.

**Left open:**
- **The mock rejects a block id in `load_page_subtree`,** while the backend
  returns an empty subtree. That divergence needs a fixture and a decision
  on whether the backend should refuse a non-page root.

**Ran:**
- the real-lane spec on the fixed binary;
- the mock spec with `--repeat-each=3`, plus the link, peek, search, tag and
  tab specs;
- the full vitest suite;
- `npm run typecheck`, `npm run typecheck:e2e-tauri`, oxlint and oxfmt.
