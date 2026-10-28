# Session 3012 — Link tokens in the differential fuzzer (#6054 B2)

Set out to put `[[…]]`, `((…))` and `#[…]` tokens in the differential fuzzer's content alphabet (#6054 B2). Then the fuzzer compares the link, tag-ref and backlink derivations between the mock and the backend, not just content.

**Shipped.**
- **Generated content carries tokens.** Create and edit texts hold tokens with `Cn`/`Sn` labels. Each side resolves the labels against its own created ids (`expand_content_labels` / `expandContentLabels`). Op-created ids in returned and snapshot content are written back as labels, so the two stacks compare equal.
- **Escaping.** `attr_value` / `attrValue` percent-escape `%`, `#` and `->` instead of panicking.
- **The mock's link index** moved out of `handlers/shared.ts` into `link-scan.ts` (pure) and `link-index.ts` (over the mock's state). Moving it breaks an import cycle: `shared.ts` imports `revert.ts`.

**Divergences the fuzzer found,** each fixed and pinned by a backend-authored fixture:
- **Backlinks of a purged target:** `link_to_purged_target`.
- **An edge to a trashed target.** The backend writes an edge only to a live target, and owes the rest in `block_links_unresolved`, relinked on restore and on undo. The mock now keeps the same owed set: `link_to_tombstoned_target`, `link_relinked_on_restore`, `link_index_on_undo`.
- **A cross-space token accepted on create and edit:** `cross_space_link_refused`.
- **A page's link to itself in `list_page_links`:** `page_link_self_loop`.

Review added two fixtures for what the fuzzer cannot reach:
- `cross_space_link_kept_after_move`: a page that already holds a cross-space token may keep it on edit;
- `token_separators_escaped`: the TS escape, one leg per separator.

**Decisions and traps:**
- **CrossSpace exclusion.** The fuzzer still excludes cross-space targets. The backend's link insert declines a target in another space or in none, and the mock does not model that decline. B3, which adds space moves to the fuzzer, has to model it and lift the exclusion.
- **Rebase onto D2 (#6149).** D2's new `LinkedFrom` leaf called the old `contentLinksTo`. It now asks `linksTo`, the same `block_links` model as `LinksTo`. No active row can tell the two apart: an owed link points only at a trashed target, and a restore relinks it.
- **The fuzzer misses one case.** Its rare chain-level purge does not catch the target-exists defect in a 256-case run; the fixture is what pins it.
- **Left for later (pre-existing, not B2's):**
  - The mock's `list_page_links` counts only a page's direct children and always answers `ref_count: 1`, where the backend rolls up nested blocks with edge weights.
  - Paste, batch create, draft flush, import and duplicate record no owed links in the mock.

**Suites, after the rebase:**
- Rust: `conformance` (97 tests), the fuzzer (`--run-ignored all`, 256 cases), and `cargo clippy --workspace --all-targets -- -D warnings`;
- vitest over `src/lib/tauri-mock` and `src/lib/__tests__` (4,888 tests);
- typecheck;
- in review, 33 Playwright specs over links, spaces, undo, trash, history, graph and pages (215 tests).
