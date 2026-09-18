# Session 1778 — deleting two guards tiptap 3.31.3 made moot

`ignoreReactNodeViewChrome` and the `REACT_MARK_VIEWS` ratchet both existed to
keep React chrome out of a `@tiptap/core` mobile branch that treated any
mutation inside `dom` as content. 3.31.3 narrowed that branch to
`contentDOM.contains(target)`. #5059 asked whether either still earns its
keep. Neither does.

## The enumeration was re-run, not inherited

The issue carried a 96-combination result. Repeating someone else's claim is
not evidence, so it was re-run against the installed prototypes, and then
widened: 1008 rows over seven mutation targets, three mutation types,
`contentEditable`, four node classes, three user agents and focus state — and
the same space again on `MarkView`.

No combination is user-agent or focus sensitive. The mobile branch's guard is
now the same predicate as the trailing rule, so its `return false` is only
reachable where the trailing rule already answers `false`; the UA and focus
tests cannot change an answer. In the one configuration the override was
actually installed on — mermaid's `codeBlock` — it differs from the narrowed
default in zero of 252 inputs.

The combinations that do differ are node classes that either never carried the
override or cannot exist under `@tiptap/react` at all: its `ReactNodeView` only
builds a content host when the node is not a leaf, so a leaf's `contentDOM` is
`null` and the first guard answers before the option is ever consulted.

## The mark-view ratchet is deleted on its premise, not on tidiness

"It costs nothing to keep" would not have been sufficient. The ratchet guarded
something real: `MarkView` has no leaf/atom guard, so every React mark view
reached the `dom`-wide branch. The same narrowing closed it — `ReactMarkView`
builds its content host as a separate element ProseMirror owns, so React's
re-render writes land outside `contentDOM`.

What remains of the ratchet is a requirement to pass `ignoreMutation` at every
mark view call site, which would now force a redundant override onto the first
mark view anyone adds. A guard that mandates dead code is worse than no guard.
Nothing in the feature map, the architecture docs or the tracker calls for a
mark view.

## An inherited claim that was wrong

The deleted module asserted that no React node view has editable text outside
`contentDOM`. The math views do contain a plain `<input>` for the LaTeX source.
The conclusion survives — an input's value edits are not DOM mutations, and
both math nodes are leaf atoms whose `contentDOM` is `null` — but the blanket
claim was false as written, and was corrected rather than carried forward into
the next docblock.

## What was deleted from the tests, and why the count moved

The file goes from 31 cases to 10. The brief said 23, counting `it(` calls and
missing that one `it.each` covers four entries; the reviewer's count is the
right one. Each removal was adjudicated rather than tallied: tests of the
deleted function, tests of an option that no longer exists, and the mark-view
ratchet whose premise is now false.

One is worth recording. A test of the vendored guard that returns early on a
null `contentDOM` stayed green when that guard was removed. It had been pinning
the *ordering* between the guard and an override, and with no override left to
order against, the leaf/atom guard answers every input identically. It could no
longer redden on correct code, so it was deleted rather than trimmed.

The vendored-contract tests that pin the upstream body survive and still
discriminate: restoring the pre-3.31.3 `dom`-wide body reddens one, removing
the leaf/atom guard reddens the other.

## Verified

Full vitest, 836 files and 19242 tests; typecheck clean; eleven Playwright
tests including mobile mermaid, image, inline math and block math. The mobile
lane is the falsified instrument for this exact deletion — session 1427
recorded it reproducing the freeze before 3.31.3 under the same removal — and
it is green without the override.

Shipped as #5095.
