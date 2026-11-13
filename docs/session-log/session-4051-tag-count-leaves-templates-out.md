# Session 4051 — The Tags list count leaves out template pages and their blocks

#6659, decided by the maintainer on the issue: the count leaves templates out, so the badge matches what the tag's page lists. Since #6643 that page's two `run_advanced_query` panels skip a template page and the blocks on it, while `tags_cache.usage_count` still counted them.

Built on #6689's branch, which rewrote the same rebuild, and opened after it merged.

## What changed

- **The count.** Both forms of the rule, the rebuild's `DESIRED_TAGS_SQL` and the one-tag `DESIRED_TAG_USAGE_SQL`, carry the agenda's guard: no holder whose page has a `template` property, attached or inline.
- **When it moves.** Setting or deleting `template` on a page now enqueues `RebuildTagsCache`: it changes the count of every tag the page's blocks hold. Deletes, restores, cross-page moves and inbound sync already ran that rebuild.
- **Existing vaults.** The count is a versioned derivation, `Derivation::TagUsage`. The whole-vault tags rebuild records it, and boot runs that rebuild once for a vault that has not recorded it, which is every vault on its first boot with this change.
- **The second implementations.** The reconciliation oracle's fold and the browser mock's `tagCacheRows` leave the same holders out. A new fixture, `tag_count_excludes_templates`, authored by the backend, pins the count and the two tag-page queries side by side.

## Traps

- `CONFORMANCE_UPDATE=1` rewrites every fixture file in a looser JSON layout. None of the other 160 changed in value (checked by parsing both sides); they were restored, and the new one was formatted with `oxfmt`.
- A fixture query that returns no rows needs `"expect_empty": true`, or the coverage ratchet fails it.
- Killing `cargo sqlx prepare` mid-run leaves `.sqlx` entries deleted. `git checkout -- src-tauri/.sqlx` restores them.

## Verified

- Red first, each on its predicted assertion: the store test (count 4, not 1), the oracle test, the dispatch matrix, the mock against the fixture (4, not 1), the Playwright case (`idea3`, not `idea1`), the backend fixture with the dispatch arm removed, the one-tag refresh with its guard removed, the rebuild not recording the rule, and boot with an empty arm.
- The suites that ran are listed on the PR.
