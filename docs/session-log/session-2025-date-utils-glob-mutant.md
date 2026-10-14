# Session 2025 — date-utils mutant: wire the glob conformance test into its scope

#3752 reported one surviving mutant in `date-utils`, a `StringLiteral` on
`JOURNAL_PAGE_GLOB`. The line number was from before #5474 moved the file.

The constant is pinned, but only by `glob-conformance.test.ts`, which checks
that the shared PathGlob vectors cover the journal-page exclude. Stryker's
`date-utils` module ran only the two `date-utils` test files, so it never saw
that test. Blanking the constant on a copy failed exactly that test and none of
the `date-utils` ones, so the fix is adding it to the module's test list, as
`tree-utils` did for its own stray tests.

Suites run: the three scoped test files, with the mutation applied by hand
and then restored.
