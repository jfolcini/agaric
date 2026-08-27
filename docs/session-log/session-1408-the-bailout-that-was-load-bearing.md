# Session 1408 — the bailout that was load-bearing

#4469 and #4470, both split out of the `react(refs)` sweep in #4465. The sweep cleared 15
findings and reverted two of them, because one — destructuring `useRovingTabindex()` in
`SelectionBubbleMenu` — broke the mobile mermaid e2e and nobody could say why. This session
re-applied that fix in a form that survives, and wrote down the mechanism where the pattern
is prescribed.

## Satisfying the lint switched the compiler on

The diagnosis was already on the issue and it is worth restating, because the surprising
part is not the bug but that the two forms are indistinguishable by reading.

The first framing of this — including the one on the issue, and the one this log carried
before review — was that member access is *opaque* to `babel-plugin-react-compiler`, so it
gives up. That is not what happens, and the real answer is more useful. Attach a `logger` to
the plugin and compile the member-access form: it emits three `CompileError`s whose text is
word for word what oxlint prints — *"Cannot access refs during render."* `react/refs` **is**
the compiler's own rule, and the compiler's response to a violation is to skip the whole
function. So the edit that silences the lint is the edit that removes the reason to bail, and
the component comes out memoised. Read the other way round: an open `react/refs` finding in a
`.tsx` file marks a function the compiler is currently declining to optimise, and closing it
is what switches memoisation on. The scope limits went into the doc alongside it, because
they decide whether the remaining sweep is dangerous: babel is wired for `.tsx`/`.jsx` only,
so findings in plain `.ts` files carry no compiler consequence at all; a function already
bailing for an unrelated reason (`DaySection`, `BlockContextMenu`) will not change behaviour
when its ref finding is fixed; and an `oxlint-disable` silences the finding without un-bailing
the compiler, which makes a suppression behaviour-preserving where a code fix is not.

What the memoised form then caches is the returned `<BubbleMenu>` element, behind a guard
whose inputs reduce to `containerRef`, the two roving `useCallback`s, `editor`, `blockId`,
the i18n `t`, `isTouch`, `linkPopoverOpen`, `savedSelection`, and the `useEditorState`
snapshot. `editor` is the trap — a TipTap `Editor` is a stable object reference whose state
mutates internally, so `$[65] !== editor` can never see an edit. On its own that would not
freeze anything; the rest of the guard usually moves. The narrower question is whether some
scenario leaves the mutating instance as the only thing that changed, and here one does:
typing plain text inside a code block flips none of the snapshot's eight mark-active flags
and touches nothing else in the set. The cached element is returned unchanged, React skips
reconciling the subtree, and typed source never reaches the mermaid block, which sits at
"Empty diagram — switch to source" until the spec times out at 15s.

The compiler bailing out was doing real work in that component. Satisfying a lint rule
removed a protection nobody had written down, which is the part worth generalising: a
`react(refs)` fix is not cosmetic, and the remaining findings in #4406 cannot be treated as
mechanical.

## Why no unit test could have caught it, and why none can be added

`vite.config.ts` disables the React Compiler when `VITEST` is set. The entire unit suite
therefore runs against unoptimised output, and only the e2e production build exercises the
memoised path. This is not a coverage gap someone can close by writing a better test — it is
the harness. Any `react(refs)` or `react(set-state-in-effect)` sweep is invisible to the unit
suite by construction, and has to be validated against the mobile e2e.

That went into `docs/architecture/frontend.md` next to the latest-value-mirror pattern
#4398 established, along with the danger sign: a **mutation-behind-a-stable-reference** value
in the memoisation key set. A TipTap editor above all, but any store or instance object
passed as a prop has the same shape.

## The fix, and the option that was not taken

The issue ranked three options, preferring one that keeps memoisation but makes the key set
change when the editor's relevant state does. We took the second: destructure, satisfying the
lint, and add `'use no memo'` to the component with a comment pointing at #4469. It preserves
the behaviour that was measured to work rather than substituting a new theory of when the
element should re-render, and the cost is one component the compiler skips — which is exactly
what it was already doing before the sweep touched it.

Verified by compiling the real file with the same preset `vite.config.ts` wires in: the only
`_c` in the output belongs to `Tip`, an unrelated component in the same file. Falsified
against a copy — deleting only the directive restores `const $ = _c(75)` and the
`$[65] !== editor` guard. Two more copies pinned the directive's fragility: quote style does
not matter, but moving one statement above it makes the compiler report a plain
`CompileSuccess` for the component, with no diagnostic at all.

The lint's silence got the same treatment, because `react/refs` is configured `warn` and
silence could equally mean the rule was not running. Reconstructing the member-access form
produces 3 warnings; the fixed form produces 0.

## Two comments that asserted the thing the same commit disproved

#4470's first item is the sharpest of the three. `ImageResizeToolbar` and `EmojiPicker`'s
`SkinToneSelector` carry the identical destructuring, and both carried a comment saying the
transformation was behaviour-preserving — thirty lines from the site where that claim had
just been falsified and reverted. The bisect does measure both as passing, so this was not a
hidden break; it was prose stating a general property when what had been established was a
local one.

The first rewrite scoped the claim to each subtree — "nothing here depends on mutation behind
a stable reference" — which is true but still unfalsifiable by a reader. Review replaced it
with the actual key set in each case, so the claim can be checked instead of believed:
`ImageResizeToolbar`'s reduces to `blockId`, `currentWidth`, `currentAlignment`, two
callbacks and `t` — strings and functions, no object at all; `SkinToneSelector`'s contains
exactly one object, the `tonable` `ReadonlySet`, and `<EmojiPicker>` rebuilds it with a
`useMemo` over the loaded dataset, so its identity tracks its contents. Both now also say the
part the original comments left out: the destructuring is what turns memoisation ON here, and
that is a real change, safe for a stated reason rather than inert.

The same review pass caught a third piece of prose in the shared preamble of both comments,
inherited from #4406: that `react(refs)` is a "syntax-only check, blind to the actual property
type". It is not. A probe component that reads only `roving.onKeyDown` draws no finding; one
that reads `roving.containerRef` draws one, and thereafter every read of `roving` is flagged
too. The rule is property-aware and taints the alias, which is exactly why the pre-fix
`SelectionBubbleMenu` produced three findings for one ref.

## Two defects introduced while fixing the comments

Neither survived review, but both are worth recording because both looked finished.

The `oxlint-enable react/refs` in `src/__tests__/mocks/ui-select.tsx` sits after a `return`,
which reads as dead code — that was the reported defect, and the issue proposed either
hoisting the `enable` above the return or replacing the pair with two
`oxlint-disable-next-line` directives. Hoisting it un-suppresses the return and adds a new
finding. So does the two-directive form: **four** lines in that function trip the rule, not
two — the three conditional `ctx.x =` assignments and the `return`. (The first review pass
recorded five, counting the `const ctx` declaration; measured with both directives stripped,
that line does not fire. The taint starts at the first assignment.) The pair is the right
construct and the `enable` genuinely has to sit after the `return`. It now says so, with the
measurement, and says that hoisting it re-reds the file — more useful to the next reader than
the silence that invited the change.

The second was in `AddFilterPopover`. The reported defect was a comment wedged between `&&`
and its operand, nine lines from the guard it explained; the fix moved it above the guard —
and out of the JSX expression container into children position, where `//` is not a comment
but literal rendered text. It would have printed the comment into the popover. Converted to
`{/* … */}`.

Both were caught by reading the diff rather than by any gate, and neither would have been
caught by the lint or the type checker. The first was reported by its own author as an
expected remaining finding, which is the more instructive half: a new violation introduced at
the exact site being fixed was described as pre-existing.

## A fourth piece of prose asserting an invariant nothing enforces

`vite.config.ts` claimed, since #887, that the React Compiler eval "proved the codebase
compiler-clean (healthcheck 469/469, 0 bails)". There is no `healthcheck` script in this
repo — the word appears exactly once in the tree, in that comment — and the invariant is
false besides: run the plugin over the tree and the bails are everywhere, on ordinary things
like a destructuring default in a parameter object pattern or a `try`/`finally`, plus every
open `react/refs` violation. A bail is not a build failure, so nothing ever contradicted the
claim. The comment now says the tree is not bail-free, says nothing measures whether it is,
and flags `SelectionBubbleMenu` as a deliberate opt-out that a future bail-counting guard
would have to allow for. Deliberately without a count: a number there would be the same kind
of claim, drifting silently.

## What shipped

- #4469 — `SelectionBubbleMenu` re-applies the `react(refs)` fix with `'use no memo'`; the
  compiler hazard documented in `docs/architecture/frontend.md`, with the mechanism corrected
  from "the compiler cannot see through member access" to "`react/refs` is the compiler's own
  rule, so every open finding is a live bailout".
- #4470 — the two over-claiming comments replaced with their actual key sets; the `react(refs)`
  "syntax-only" mischaracterisation corrected in both; the `ui-select` suppression corrected,
  measured and explained; the `AddFilterPopover` comment moved into a JSX comment container.
- Drive-by — the `vite.config.ts` "healthcheck 469/469, 0 bails" claim, which cited a script
  that does not exist.
