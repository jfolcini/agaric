# Session 1659 — enex-import: 79.4% → 94.0%

Mutation findings for `src/lib/enex-import.ts` (#4815): 8 with no coverage, 89
survivors. After: **4 no-coverage, 23 survivors, score 94.03%** — re-measured
after each review round rather than adjusted by arithmetic. The 27 that remain
are exactly the set judged not worth killing; nothing is left unclassified.

## A comment wrong three times, and the defect underneath it

`normalizeInlineCell`'s comment claimed its `.trim()` was unobservable. Review
disputed it twice; the second time the argument was a concrete mechanism, so
the third round tested it instead of rewording it again. Dropping the `.trim()`
passed all 47 tests — unpinned, not unobservable.

Writing the fixture that pins it found a real defect one level over.
`flattenNestedTable` kept a row on `line.length > 0`, testing the JOINED line —
so a nested row of empty cells survived on its ` / ` separators alone and
emitted a stray ` ; / ` slot into the outer cell. It also meant a one-cell
empty row was dropped while a two-cell one was kept.

The filter now asks whether a CELL has content. Both the trim and the new
filter are pinned: reverting either reddens the nested-table test.

`mimeToExt`'s `known[mime] ?? 'bin'` behind an `in` guard was the same
unreachable-fallback shape this sweep deleted three times elsewhere; a
`const hit = known[mime]` lookup removes it, and with it one of the four
families the module doc had to argue for.

## Three of them were killed by deleting code, not by adding tests

The ladder applies to a mutation sweep as much as anywhere. A mutant that
survives because the code it mutates cannot matter is telling you about the
code, not about the tests.

- `if (clean.length === 0) return null` in `decodeResourceData` — redundant with
  the `bytes.length > 0 ? bytes : null` on the return two lines below. Deleting
  it turned three survivors into kills.
- The `dot === -1` ternaries in `uniqueResourcePath` — unreachable: every branch
  above produces `<name>.<ext>`, so the dot is always found. Three findings gone.
- `hash.length > 0 ? resources.get(hash) : undefined` — an empty hash matches
  nothing anyway, because every key is a 32-character MD5 digest. Two gone.

## The tests that were worth writing

Fixtures now look like a real export — pretty-printed, base64 wrapped — and
bodies are asserted **whole** wherever a mutant could corrupt the prose around
what the importer rewrites. That alone killed a dozen weak `toContain`
assertions, which is the finding underneath the finding: the old tests checked
that the right thing appeared, never that the wrong thing did not.

Ten behaviour groups, each one an archive shape a real Evernote export takes:
pretty-printed notes with a whitespace-only tag; a timestamp that must be the
whole value; the mime→extension table type by type (`audio/mpeg` is `.mp3`, not
`.mpeg`); resource names carrying Windows paths and `../`; an MD5 payload sized
to the block boundary where the length field forces a second block; line-wrapped
base64 and dedup by hash; embed splices whose digits run into the sentinel index
on both sides; nested tables with a `|` inside a cell; task markers, `en-crypt`
and CDATA; and `enexNoteToMarkdown` asserted as an exact document.

## The accepted gaps are argued, in the module doc

Four families, written where the next person on this issue will read them:
fallbacks the type system forces but the code cannot reach; fallbacks whose
stand-in value cannot matter; MD5's high length word, non-zero only for a
resource ≥ 512 MB; and values nothing observes.

Two sites carry their own comment because the argument is local —
`media.remove()` (Turndown renders the leftover element as nothing either way)
and `normalizeInlineCell` (Turndown re-collapses the text, so the run width and
the trim are invisible, though the `|` substitution is not).

A third started as a site comment and ended as a deletion. `if (enNote == null)
return ''` is unreachable by the same argument as the three above, and the
comment written to excuse it was worse than the line: it said "no input reaches
this" and then claimed the line stops a rootless `<content>` throwing away the
whole import — but `return ''` IS throwing it away. The `?? doc.documentElement`
before it is what saves that case. Caught in review.

The figures at the top are the only ones in this log, deliberately: the lane was
re-measured after every review round (93.39% at the sweep's own last run, then
93.78%, then 94.03%), and quoting the intermediate ones in a file that is
immutable once merged leaves a reader unable to tell which run was final.

## Falsification, and the seven that came back

Every kill was hand-applied to a backed-up copy, run, seen red, restored,
`cmp`-verified. Seven mutants survived the first attempt and were re-worked
rather than declared equivalent: the two embed sentinels needed a fixture where
a digit sits adjacent to the delimiter, and five turned out to be genuinely
equivalent — those became the site comments above rather than tests.

One test written during the sweep was deleted after probing showed it took the
same `parsererror` branch as an existing one.

Full suite: 826 files, 19018 passed. Typecheck and `oxlint --type-aware` clean.
