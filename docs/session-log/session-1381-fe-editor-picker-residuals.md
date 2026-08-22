# Session 1381 — editor serializer and picker-cache residuals

| | |
|---|---|
| **Issues** | #4221, #4055 |
| **Branch** | `claude/fe-editor-picker-residuals` |
| **Files touched** | see the PR's file list |

Two independent frontend residuals, both filed off earlier reviews, both
reachable without the user doing anything unusual.

## #4221 — an empty italic node defeats the bullet-collision defuse

`isVulnerableItalicOpen` required ONE `TextNode` to simultaneously carry only
the italic mark and have text starting with a space. A zero-length italic
`TextNode` followed by a space-leading italic one defeats that: the empty node
opens the `*` delimiter — a real byte, so neither `isEmptyAtom` nor
`isPlainSpaces` catches it — while the leading-space trigger sits on the next
node. `paragraph(text('', [italic]), italic(' y'))` serialized to `'* y*'` and
reparsed as a `bulletList`, the #4156 collision.

The fix generalises the predicate from a single-node check to a forward walk:
step past zero-length italic-only text nodes, and let the first node with
actual text decide. `defuseLeadingItalicMarker`'s replacement loop needed no
change — it already handled zero-length nodes correctly once the entry gate
stopped rejecting the run.

The walk terminates on any node that is not italic-only text. That is safe
because a mark-set change always closes and reopens the delimiter, so the
output carries two or more stars and cannot collide with a bullet marker. This
was the load-bearing claim, so it was verified by running the serializer rather
than by inspection, on the three shapes most likely to break it: an interposed
zero-length italic+bold node (`*****`), an interposed zero-length bold-only
node (`*******`), and an interposed empty atom of a different node type
(`***`). All three reparse as paragraphs; all three are now pinned as
regression tests.

There is no closing-side twin. Only a line-start open can collide with a bullet
marker, and a hard-break continuation line round-trips correctly because
block-level bullet dispatch fires on a block's first line only.

## #4055 — an in-flight picker fill clobbers an invalidation

Both cache-fill sites persisted a lazily-fetched list behind a guard that
checked only that the active SPACE was unchanged. That guard was written for
#732, a space switch mid-flight. It did not notice an INVALIDATION mid-flight,
which #4042 made a routine background event: a `[[` keystroke starts the fetch,
`sync:complete` lands and clears the ref, the pre-sync response then resolves
and is written over the just-cleared ref.

Fixed with a generation counter bumped unconditionally in the existing
name-change bus listener, captured before each IPC and compared before each
write, alongside the existing space check. The alternative — reconciling
against `useResolveStore` at read time — was weighed and rejected on inspection
of the store: it is a flat LRU map with no ordering concept and no
"complete set for this space" semantics, while the refs are ordered lists
sliced to the first 20 rows, so the pull-based shape would mean building that
machinery into the store.

**Review caught a real hole in the first attempt.** The guard gated the
persisted ref write but not the racing call's own return value: when the guard
rejected a fetch, the local list feeding the function's result was never reset,
so the stale rows were still returned to the caller. For pages those rows flow
into `populatePageResolveCache`, whose only guard is the space check — so a
stale title reached the shared `useResolveStore`, which every chip in the app
reads and which, unlike the refs, has no re-fetch-on-empty self-heal. Both
sites now fall back to the corrected cache state on a rejected fetch.

## Recorded, not fixed

- The issue's `renamed`/`removed` description is imprecise: both fill sites
  only dispatch when the ref is already empty, so the patch is a no-op on an
  empty list and the "patch a populated list, then get overwritten" sequence is
  unreachable. The tests pin the shape that is actually reachable.
- Two concurrent fills in the same generation are last-resolved-wins, so an
  older snapshot can overwrite a newer one. Out of scope for #4055, filed as
  #4270 with the interleaving pinned as a documenting test.
- #4221's body cites PR #4195, which does not exist; the real PR is #4189.
  Corrected in an issue comment.
