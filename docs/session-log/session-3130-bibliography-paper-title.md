# Session 3130 — Bibliography entries keep their paper title

One item of #6032: a BibTeX or CSL-JSON import parsed each entry's `title` into `BibEntry.title` and never stored it, so every reference page lost its paper title with no warning.

- **Key:** `title`, text, beside `doi`, `url`, `journal` and `abstract` in `BIB_PROPERTY_DEFS` and `entry_property_values`. It is not a built-in or an `INTERNAL_PROPERTY_KEYS` key. Markdown import already keeps a front-matter `title:` as a page property of that name, so the two agree; the page title stays the citation display name.
- **Trap:** the conformance writer (`CONFORMANCE_UPDATE=1`) rewrites every fixture in its own JSON layout. Keep only the fixture that changed (`markdown_imports.json`) and run `oxfmt` on it.
- **Tests:** the BibTeX and CSL-JSON happy paths assert the stored title and the new `properties_set` totals. A new test checks that an entry with no title, or a blank one, stores none. Deleting the title row reddened both happy paths; pushing a title unconditionally reddened the new test. The backend-authored `markdown_imports` fixture was regenerated.
- **Ran:** the `commands` bibliography tests, `conformance_fixtures_match_backend`, the tauri-mock vitest suite, clippy over the workspace and all targets, and `SQLX_OFFLINE` check.
