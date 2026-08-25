# Session 1398 — a node view that never re-synced its outer element

#4012 and #4356. Three of #4012's four items were **not** fixed, which is the useful half of
this log.

## What was left alone, and why

| Item | Disposition |
|---|---|
| #4012.1 — table-merge junk row | Behaviour left; the decision recorded in the parser docblock |
| #4012.2 — dropped `DOMParser` fallback | Already shipped in #4067; verified in-tree, nothing to do |
| #4012.3 — render-time ref write | Already shipped in #4067, and it went further than asked |
| #4356 — `<pre>` attributes never re-synced | Fixed |

**Item 1** asked that the merged result carry no literal `---` data row. That is the one thing
#3274 exists to prevent — silently dropping the absorbed row. The maintainer's preferred
alternative (split) was refuted by his own later analysis: on a same-width run the two
readings are isomorphic.

The argument that settles it was in neither the issue nor the code: **this is not a
table-specific wart.** `markdown-roundtrip-fidelity.test.ts` already pins two sibling
blockquotes reparsing as one blockquote with two paragraphs, and a callout absorbing the
plain quote beneath it. Same rule, same file, deliberately pinned. Sibling blocks of one kind
written with no blank line come back as one block. So the only lever that changes the table
case is how the **serializer** separates sibling blocks *in general* — a decision about all
those shapes, not a parser heuristic. Under "named victim and stated harm" there is no victim
here beyond aesthetics, and every alternative has a strictly worse stated harm.

## #4356: the issue's own acceptance criterion was insufficient

The issue asked for "an allowlist of attribute names captured at mount, so prosemirror-view's
own attributes are never touched."

A **name** allowlist is not enough, and this was proved against the installed
`prosemirror-view@1.42.1` rather than argued from memory — this repo has a standing footgun
about reasoning from assumptions regarding ProseMirror internals:

- `patchAttributes` (dist/index.js:1717) explicitly **excludes `class` and `style`** from its
  name loops and merges them token-wise (`classList.remove/add` per token) and property-wise
  (`style.removeProperty` then `cssText +=`). They are shared namespaces, not owned attributes.
- `selectNode` (:1492) adds `ProseMirror-selectednode` as a single class token.
- `updateOuterDeco` (:1479) opens with `if (sameOuterDeco(...)) return`, and even when it runs
  the class branch is gated on `prev.class != cur.class`. Decoration classes are **never
  re-applied** while the decoration set is unchanged.

So a blanket `setAttribute('class', …)` from a name allowlist drops `ProseMirror-selectednode`
and every decoration class **permanently**, with no second chance. Both are diffed at
token/property level instead.

The allowlist also **rolls forward** rather than freezing at mount, so an attribute the spec
only starts producing later is also removable later. That cannot capture a foreign attribute:
`specAttrs` is only ever assigned from a *throwaway* `renderFromSpec` render, and the
mount-time capture reads `dom` before `applyOuterDeco` touches it (`NodeViewDesc.create`
:1301-1325).

## Two load-bearing decisions had no coverage at all

Review constructed two reverts the author had not, and **both left all six shipped tests
green**:

- **Sweeping the live element** instead of `specAttrs` — a real `Decoration.node`'s
  `data-deco` is destroyed on every attribute-only edit and never restored. That is the entire
  reason `specAttrs` exists for plain attributes.
- **Freezing `specAttrs` at mount** — the literal reading of the issue — leaves an attribute
  the spec only starts producing later stale for ever.

Both now have a test, each verified to redden against exactly its own variant. The
decoration test uses a real `Plugin` and `Decoration.node` driving the production writer,
rather than a hand-written class token.

## A real bug in the removal sweep

`if (!(name in next))` walks `Object.prototype`, so `'constructor' in {}` is `true`: a
`<pre constructor="C">` whose spec stops producing it keeps the attribute while its siblings
are correctly removed. Fixed to `Object.hasOwn`. Deliberately **not** tested — an attribute
literally named `constructor` is representable but has no production writer, and a test for it
would itself be the "unreachable condition" failure mode this repo rejects.

## An overstated claim, falsified

The docblock asserted "anything another writer contributed is left alone." A probe falsified
it: a token or property that **both** writers contribute is removed when the spec drops it,
because there is no refcount. The comment now states the limitation, and notes
prosemirror-view has the identical hole in the other direction.

## Carried forward to #4377

The transferable rule from item 3 is **not** "reads are safe, writes aren't." It is: *a
render-time ref reuse is safe iff the gate compares every input the cached value closes over.*
Here it does — `prev.listStyles === listStyles` (reference identity, stronger than content)
plus `ordinalsEqual` (full content equality).

One correction for that sweep: `useListStyles.ts:57` **still writes `prevRef.current` during
render** — the same pattern #4012 item 3 was filed about, one hop upstream, and the source of
the `listStyles` reference stability the verified gate depends on. It is safe by the same
argument, but if "#4012 item 3 was fixed" is cited as precedent, *this* instance was not.
Flagged so the #4377 triage does not record it as already-handled.

## Verification

`src/editor/__tests__/` — 46 files, 1960 passed (was 1952 at the `main` merge base — this diff
adds eight `it()` blocks and removes none, a +8 delta, not the +2 an earlier "was 1958" figure
implied; that number was an intermediate state of this branch, not the merge base). `tsc -b`,
`oxlint` and `oxfmt --check` clean on all changed files.
