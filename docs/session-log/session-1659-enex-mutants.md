# Session 1659 — enex-import: 79.4% → 93.4%

Mutation findings for `src/lib/enex-import.ts` (#4815): 8 with no coverage, 89
survivors. After: **6 no-coverage, 24 survivors, score 93.39%** — 65 survivors
killed, all 8 no-coverage findings resolved, and the 30 that remain are exactly
the set judged not worth killing. Nothing is left unclassified.

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

Three sites carry their own comment because the argument is local — `media.remove()`
(Turndown renders the leftover element as nothing either way), `normalizeInlineCell`
(Turndown re-collapses the text, so run width and trim are invisible), and the
rootless-`<content>` guard behind the `parsererror` check.

## Falsification, and the seven that came back

Every kill was hand-applied to a backed-up copy, run, seen red, restored,
`cmp`-verified. Seven mutants survived the first attempt and were re-worked
rather than declared equivalent: the two embed sentinels needed a fixture where
a digit sits adjacent to the delimiter, and five turned out to be genuinely
equivalent — those became the site comments above rather than tests.

One test written during the sweep was deleted after probing showed it took the
same `parsererror` branch as an existing one.

Full suite: 826 files, 19018 passed. Typecheck and `oxlint --type-aware` clean.
