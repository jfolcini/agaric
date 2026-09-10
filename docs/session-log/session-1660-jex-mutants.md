# Session 1660 — jex-import: 75.7% → 86.3%

Mutation findings for `src/lib/jex-import.ts` (#4816): 8 with no coverage, 105
survivors. After: **7 no-coverage, 57 survivors, score 86.25%** — 49 of the 113
findings removed, and none introduced (the fresh report was diffed against the
issue's list; the "present now, absent from the issue" set is empty).

## The eight no-coverage mutants were mostly not tests' to fix

#4843 had already worked this half down from 73 to 8, and its analysis holds —
each was re-derived independently rather than taken on trust:

- **five** are the right operand of a `??` the type system demands and the code
  cannot reach: `lines.at(-1) ?? ''` under `lines.length > 0`, two indexed reads
  provably in range, `known[mime] ?? 'bin'` under `mime in known`, and
  `.split('/').pop() ?? ''`. Removing the fallback breaks
  `noUncheckedIndexedAccess`; there is nothing to test.
- **two** are reachable but unobservable: the mutated value only ever becomes a
  `Map` key nothing looks up, so the parse result is byte-identical. A test
  reaching them would demote them to survivors, which is worse.
- **one** was killed by deleting the code: the `dot === -1` ternaries in
  `indexResources` are dead, because every branch above produces
  `<stem>.<ext>`. That also removed two survivors. It is the only production
  change in this PR — three lines.

## What the survivors were actually hiding

Fourteen behaviour groups, each an archive shape a real Joplin export takes.
Three of them are worth naming because the mutant was a live defect, not a
weak assertion:

- **The end-of-archive marker bounds the scan.** The whole `allZero` block was
  untested. Without it, an appended-to `.jex` imports phantom notes.
- **`user_created_time` beats `created_time`.** Otherwise every synced note is
  dated the day it synced rather than the day it was written.
- **A notebook cycle is walked once.** The mutant produced a 64-deep repeated
  path; the guard that stops it had nothing watching it.

Also pinned: a note whose notebook is missing from the archive lands at the
root rather than aborting the import with a `TypeError`; truncation boundaries
on both sides; and `jexNoteToMarkdown`'s exact bytes, where the old `toContain`
assertions passed with an unclosed `---` fence that swallows the whole body.

## The accepted gaps, and one that was checked rather than argued

The remaining 57 are recorded as five recurring shapes rather than 57 ids, in
the test file's header — the copy a future reader on this issue will actually
hit.

One was verified empirically instead of by argument: `normalizeBody`'s
`start < lines.length` → `<=` **survived** the hand-applied mutant, as
predicted, because both paths return `''`. An argued gap that turns out to be
killable is a test you owe; this one is not.

**One of them was.** The list claimed `resolveFolderPath`'s `depth < 64` sits
behind the `seen` set "that already bounds the walk". `seen` bounds *cycles*.
A long enough ACYCLIC chain reaches the cap, so the mutants on it are killable
— which makes the entry a test owed, not a gap.

The review independently reached the opposite conclusion, that the counter is
dead code and the three lines should go. Both `depth <= 64` and deleting the
condition outright now redden the new 65-deep-chain test, so the counter is
live and the suggested deletion would have been a silent behaviour change. The
entry is gone from the accepted list and the test stands in its place.

## Falsification

45 mutants, each applied to a copy of the source, suite run, restored and
`cmp`-verified. All 45 red, each on the test written for it — including one
killed by timeout, because the mutant `lines.length > 0` → `true` is an
infinite loop.

Full suite: 826 files, 19021 passed. Typecheck, oxlint and oxfmt clean.
