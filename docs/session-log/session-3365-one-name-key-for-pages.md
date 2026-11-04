# Session 3365 — One folded name key for page titles and aliases (#6278 I1)

Item I1 of #6278: page titles, page aliases and tag names are unique per space under one fold, `agaric_core::tag_norm::name_key` (trim, Unicode lowercase, NFC). The key is compared, never stored; `normalize_tag_name` and `page_alias_key` key Loro maps and are unchanged.

- A create resolves to the folded holder (`find_live_page_by_name`, title matches before alias matches, lowest id first); a create naming another page's alias is refused rather than resolved, so a template or welcome flow never stamps a page the user did not name.
- Rename, restore, undo and move into a space refuse a folded clash with another page's title or alias, the page itself excluded. Batch paths (`reject_taken_names`) read each space's names once (`SpacePageNames`), after the batch's writes, so names a batch brings in see each other; a restored or moved page's aliases are checked too.
- No migration: the scan reads the space's titles and aliases as one aggregated row and folds in Rust. The committed `#[ignore]`d harness `page_name_check_cost_at_10k_pages` measures it; a release-build scratch run put a create or rename at roughly 10 ms at 10K pages, which the orchestrator accepted (comment on #6278).
- The mock folds the same way (`src/lib/tauri-mock/page-names.ts`, `nameKey` in `src/lib/name-tokens.ts`), pinned by `nameKeyCases` in `conformance/reference-tokens.vectors.json` and the fixtures `page_title_one_name_key` and `tag_name_one_name_key`. Frontend pre-checks (TemplatesView, WelcomeModal, usePageCreation, untitled-page) fold too.
- Eight existing tests built a case tie through the create path, which now resolves to the first page; they seed the twin below the name check instead (`dup_twin_page`), assertions unchanged.
- Review found the tag create lookup asymmetric (stored names folded without trim): fixed in Rust and the mock, both orders tested.
- Left for later items: journal day creation and bibliography import compare exact titles (I3's pass repairs any tie they make); import link-target creation and front-matter aliases read the space's names per alias (#6277 G5 / I2).

Suites run: `cargo nextest run --workspace` (all passed), clippy, `SQLX_OFFLINE` check, vitest on the touched and mock files plus a full run, typecheck, lint, `prek run --all-files` and the manual stage, the whole Playwright lane.
