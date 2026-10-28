# Session 2942 — vault-import mutation survivors

#3766 listed nine findings in `src/lib/vault-import.ts`. Stryker on the module at `origin/main` found ten survivors (the issue merges two Regex variants at one spot) out of 200 mutants, and no no-coverage mutant.

**Killed, all ten, by seven tests in `vault-import.test.ts`.** Each one goes through the exported functions a pick goes through:
- `skippedFiles` counts a `.jpg` as an image, and counts a file whose image extension is not its last (`pic.png.bak`). These kill the `$` anchor and `jpe?g` in `ATTACHMENT_RE`.
- `skippedFiles` leaves out a hidden file of a plain pick, which has no folder path to put a `/` before it.
- In a Notion pick, a file that is neither a page nor a table counts as other, not as a table.
- A table whose title itself ends in `_all.csv` counts once, because `_all` comes off only the end.
- A Notion pick is still recognised when its pages hold more images than pages. `isNotionPick` reads the Markdown names alone.
- A `.txt` note in a Notion pick is kept as written. Only the Markdown pages are read as Notion.
- An Org file with an empty `#+TITLE` keeps its file name.

The two `skippedFiles` tests first asserted one count over two files, which code with both bugs would also pass. Each file now has its own assertion.

**Stale entries deleted:** three vault-import lines in `mutation-accepted.tsv`, keyed to `}`, to a comment line and to `/**`. They never matched a mutant.

**Suites:**
- the vault-import tests (60 of 60, seven new);
- typecheck and oxlint;
- each new test shown red against its mutant, by a script that restores the source on exit;
- Stryker on the module after the change: 199 killed, 1 timeout, 0 survived, 0 no-coverage;
- a filer dry run over that report: no findings.
