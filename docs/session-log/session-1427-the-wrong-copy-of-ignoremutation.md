# Session 1427 — the wrong copy of ignoreMutation

#4353 asked for a sweep: every React node view that can mount on mobile is exposed to the
tiptap `ignoreMutation` branch that froze the code block, so find them and add overrides. The
sweep found one exposed node view, and it was already fixed. The issue's premise was quoting
the wrong function.

## Two functions with the same name and different bodies

`@tiptap/core` defines `ignoreMutation` twice. The issue quoted `MarkView`'s copy. React node
views run `NodeView`'s, and the difference is the whole answer:

| | `MarkView` | `NodeView` |
| --- | --- | --- |
| `if (!this.dom \|\| !this.contentDOM) return true` | yes | yes |
| `options.ignoreMutation` consultation | next | next |
| `if (this.node.isLeaf \|\| this.node.isAtom) return true` | **absent** | **present** |
| the mobile branch | below | below |

`ReactNodeView` extends `NodeView` and defines no `ignoreMutation` of its own, so it inherits the
two-guard version. And `@tiptap/react`'s `contentDOM` getter returns `null` for a leaf, with the
backing element only constructed when the node is not a leaf.

So for a leaf node view the first guard answers `true` on the first statement. `image`,
`math_inline` and `math_block` are all leaf atoms, checked against a real schema built from the
actual extensions rather than a transcription of their specs. `codeBlock` is the only React node
view in this app with a real text hole, and #4315 already gave it an override.

The exposed set was `{codeBlock}` the whole time.

## The override the issue asked for would have been dead code

The first guard sits **above** the options consultation. Handing a leaf node view an
`ignoreMutation` override therefore does not add a layer — the option is never read. That is
asserted directly rather than argued: the test invokes the real `NodeView.prototype.ignoreMutation`
against a leaf-shaped `this` and records that the override mock was called zero times.

This matters more than the wasted effort it avoids. Four call sites each carrying an override,
three of which can never fire, would look like protection and teach the next reader a rule that
is not true — and it would make the one real guard indistinguishable from three decorations.

## So the deliverable is the enumeration, not the overrides

What actually prevents the next node view from silently missing this is not a helper. It is a
ratchet: every `ReactNodeViewRenderer` call site must appear in a classification table with its
leaf/atom status and a reason, the classification is asserted against the real schema, and the
override is required at exposed sites and required *absent* at protected ones. A new call site
fails the suite until someone classifies it.

Both vendored guards are pinned against the real `NodeView.prototype` — runtime behaviour, not a
source string a bundler could reshape — so a `@tiptap/core` bump that drops either one reddens
the suite instead of silently re-arming the freeze for the atoms. That was verified by replaying
the same inputs against reconstructed guard-less bodies and confirming both assertions invert.

## The ratchet had a hole, and review found it by building the escape

The docblock claimed a new node view "cannot be added without landing in the table here". Review
tested that claim rather than reading it, by writing the escape:

```ts
import { ReactNodeViewRenderer as Aliased } from '@tiptap/react'
export const aliasedRenderer = Aliased(ImageNodeView)
```

All 22 tests stayed green. A new, unclassified React node view had mounted with the table
untouched.

The scan now requires every occurrence of the identifier under `src/` to be either a call or a
plain unaliased import specifier, which closes aliasing, captured references, and destructuring
off a dynamic import. Prose mentions are excluded so a doc comment cannot false-alarm. The
docblock now states what remains open and accepted — a computed property access, a local
re-export under another name, or hand-constructing the node view instead of calling the renderer.

The general lesson is the one this repo keeps relearning: a guard's docblock is a claim, and the
cheapest way to check a claim of the form "X cannot happen" is to make X happen.

## Two restraints worth recording

**Serena could not answer the enumeration question directly.** Its indexer ignores `node_modules`,
so a reference search on `ReactNodeViewRenderer`'s own declaration is refused. Exhaustiveness came
instead from `find_symbol("addNodeView")` across the project — a superset, since it finds every
ProseMirror node view whether React or not — cross-checked against a reference search on each
React component from the side Serena can index.

**The freeze was not falsified by patching the library.** Removing tiptap's guards to watch
image and math freeze would have meant editing `node_modules`, which here is a symlink into the
main checkout shared with three sibling worktrees. Any sibling building during that window would
have consumed a deliberately-broken dependency. The guards are pinned against the real prototype
instead, and the freeze itself was falsified where it is reachable: removing the override from
the code block reproduces it, with ~30 `Minified React error #185` (maximum update depth) — the
#4315 signature.

## What the mobile tests had to prove before they proved anything

A node view that never mounts also never freezes, which is exactly how the code block escaped
notice before #4315. So each "does not freeze" case asserts its own preconditions were live at
that moment: the UA read as mobile through tiptap's own predicates evaluated in-page, and the
ProseMirror contenteditable held focus. Both were falsified — a desktop UA and a blur each make
the tests fail *at the gate*, before reaching any node-view assertion.

Transcribing those predicates mattered. Under Playwright's iPhone emulation on Linux,
`navigator.platform` is `Linux x86_64`; what actually fires is the iPad-13 fallback clause. A
naive platform check would have been a silent false gate — a test that passes while testing
desktop.

## Verification

Playwright `mobile-editor.spec.ts`: 9 passed. Vitest across the touched editor and node-view
files: 114 passed, with the ratchet suite at 23. `tsc -b` clean; `oxlint` and `oxfmt --check`
clean.

Every falsification ran against a copied backup with the restore proven byte-identical, and the
sibling worktrees were checked clean afterwards.
