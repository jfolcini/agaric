# Session 2943 — jex-import mutation survivors

#4816 listed four findings in `src/lib/jex-import.ts`: the `.trim()` on a note's first line, the `firstLine.length > 0` check (two variants) that picks the placeholder title, and the `?? []` for a note with no tag links. Stryker on the module at `origin/main`: 510 killed, 9 timeout, 12 survived, 3 no-coverage. The filer reported exactly those four ids.

**Why they survived:** the page title goes through `sanitizeNoteTitleToFilename`, which trims and falls back to the placeholder itself. Two outputs read the raw title line without it: a to-do's task block (`todoBlock` uses `raw.title`) and a tag's name (`tagTitles.set(id, firstLine)`).

**Killed by two tests through `parseJex`:**
- a to-do titled `  Spaced task  ` writes `- [ ] Spaced task`, and a tag titled `  work  ` is named `work`;
- a to-do with an empty or all-space title line writes the placeholder.

**Accepted:** the `?? []` stand-in at the tags lookup. Every tag id is lowercased as it is read, so Stryker's `'Stryker was here'` names no tag and `flatMap` yields nothing, as `[]` does. It is the only variant at that spot, and the same pattern at the note-tag lookup was already accepted.

**Corrected:** the test file's "ACCEPTED GAPS … Eight mutants survive" header carried a count that had rotted. It also said three fallbacks "stay tracked", while `mutation-accepted.tsv` already accepts them. It now names the file as the record and drops the count.

**Suites:**
- the jex-import tests (70 of 70);
- typecheck and oxlint;
- each new test shown red against its mutant, with the source restored on exit;
- Stryker on the module after the change, on a box busy with other runs: 510 killed, 14 timeout, 7 survived, 3 no-coverage, all ten matched by accepted entries. Against the before-run, the extra timeouts are three accepted mutants and three the baseline killed. No reportable mutant is behind one;
- a filer dry run over that report: nothing new.
