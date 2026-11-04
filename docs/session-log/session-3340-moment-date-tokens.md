# Session 3340 — Templates read Moment date tokens (#6277 C6)

Set out to build #6277 C6: an Obsidian template's `{{date:dddd, MMMM Do}}` gave `0004, November 308th` on the `/template` path (date-fns reads `dddd` as a padded day and `Do` as an ordinal day of the year) and the default form in journal templates.

**What shipped.** Moment's `dddd`, `ddd`, `Do` and `D` mean what Moment means in all three formatters: `toDateFnsPattern` (TS `/template` and `<% %>` paths, now one copy: `template-utils.ts`'s `legacyToDateFnsPattern` is gone), Rust `format_date_fns` (journal templates; the ordinal is computed, 11th–13th take "th") and the mock's `formatDateFnsSubset`. `toDateFnsPattern` now skips single-quoted text, as date-fns does; the old copy rewrote `'YYYY'` inside quotes. Moment's `dd` keeps its date-fns meaning (padded day), so existing templates do not change.

**Coordination.** `expand_journal_template_variables`, which #5364's template slice edits, is untouched; the Rust change is inside `format_date_fns` and its tests.

**Tests.** A vitest per TS path, the mock's journal-template table and a Rust ordinal table, each shown red first and falsified. Gates: vitest in shards (one unrelated `PagePropertyTable` redo test failed under load and passed alone), typecheck, lint, manual-stage hooks, `nextest -p agaric` for the journal and conformance tests (the change is in the app crate only), clippy over the workspace, and the template Playwright specs; the rest of the Playwright and WebdriverIO lanes run in CI.
