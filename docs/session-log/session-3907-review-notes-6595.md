# Session 3907 — review notes from #6595

The two non-blocking notes from #6595's review, batched as the coordinator
directed, plus tests for the mutants the diff-scoped lane left in that code.
No behaviour changes.

- `titledPath` (`vault-import.ts`) is now the one copy of a note's title once
  its text is read: an Org file's `#+TITLE`, a Logseq page's `title::`. Both
  the import dialog's `merges` and `load()` call it, so the page the dialog
  asks about is the one the import writes. A Notion export's Markdown keeps
  its path, as `load()` had it.
- `MergeRule::warning`, which no longer read `self`, is inlined into
  `import_target`, its one caller.

The `merges` test in `vault-import.test.ts`, the only test file the mutation
lane runs for this module, now pins a Markdown note's title as known before
the run and an Org file's from its `#+TITLE`, matching `load()`. That kills the
seven survivors #6595's run reported. The three left are the module's accepted
equivalents (`mutation-accepted.tsv`).
