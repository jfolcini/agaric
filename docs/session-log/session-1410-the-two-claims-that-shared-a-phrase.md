# Session 1410 — the two claims that shared a phrase

Follow-up work on the three actionable non-blocking notes from the `agaric-reviewer`
review of #4471. The interesting part was note 1, which turned out to be over-broad —
and establishing that took more work than acting on it would have.

## Two claims wearing the same words

Note 1 said four sites still assert a "syntax-only" claim that #4469's bisect disproved,
and named them: `AddFilterPopover.tsx:572`, `HasParentMatchingEditor.tsx:121`,
`BlockContextMenu.tsx:960`, `useRovingTabindex.test.tsx:32`. Acting on that as written
means four comment rewrites.

The phrase "syntax-only" is doing double duty in this codebase, and the two claims it
names have opposite truth values:

- **(a) oxlint's react(refs) *analysis* is syntax-only** — it cannot see through a
  render-prop boundary, cannot prove a callback is not invoked synchronously during
  render, and cannot tell that a ref mutation is deferred until React attaches the node.
  So it flags conservatively. This is true, and it is the claim the three *component*
  sites make.
- **(b) the *transformation* the rule prescribes is behaviour-preserving** — that
  rewriting `roving.containerRef` into a destructured `containerRef` is a wash. This is
  the claim #4469 falsified by compiling both forms through
  `babel-plugin-react-compiler`: member access makes the compiler bail out, destructuring
  gives it provable bindings and it memoises. That is what froze the mermaid block and
  reddened the mobile e2e.

Only one of the four named sites makes claim (b). The three component sites were never
part of #4465's mechanical destructuring at all — that commit's own body enumerates the
18 findings it touched (`SelectionBubbleMenu`, `ImageResizeToolbar`, `SkinToneSelector`,
and the roving-tabindex test harnesses), and lists these three separately in an explicit
"Left open" bucket with a different rationale. `9357165c1` did touch `AddFilterPopover`,
but only to move a comment out of JSX-children position; it copied the render-prop
wording across verbatim, and its own message names the three claims it corrected —
"blind to the actual property type", "behaviour-preserving", "healthcheck 469/469" —
none of which is the render-prop framing.

So three of the four were already correct and were left alone. `useRovingTabindex.test.tsx`
was the real one: its comment is a textual descendant of the same discredited template
("flags any member expression ... whether or not the property is a ref"), and it sat at
the one site of the 18-finding group that #4471 never revisited. It now states the
measured mechanism — property-aware taint propagation — cites #4469, and says why *this*
site is nonetheless safe (the compiler is disabled under `VITEST`) rather than asserting
anything universal.

The lesson is not that the review was careless. It is that a shared phrase is enough to
make two unrelated claims look like one finding, and the only way to tell is to read each
site against the history of the commit that wrote it. A grep for `syntax-only` returns all
four and distinguishes none of them.

## Correcting an overstatement without creating one

Note 2 was straightforward: `SelectionBubbleMenu.tsx` claimed the Playwright suite runs
"on every PR ... enforced, not merely requested", but the job carries
`if: needs.detect-changes.outputs.frontend == 'true'`. The temptation with a correction
like this is to swing to "CI might not run this", which is worse — it invites a reader to
discount the gate entirely. The guarantee does hold for every diff that could break the
directive, because `frontend_re` matches anything under `src/`, and any edit capable of
removing the directive is a `.tsx` there. The comment now says exactly that: conditional
in general, unconditional for the diffs that matter.

## A guard that was true for the wrong reason

Note 3 asked for enforcement of the `'use no memo'` position, which currently fails
silently — a statement placed above it deactivates it, the compiler still reports
`CompileSuccess`, oxlint and tsc stay green, and the sole symptom is a 15-second Playwright
timeout with an unrelated-looking message.

The new test scans the component source and, as first written here, asserts the directive
is the first non-trivia content of the function body. That rule turns out to be stricter
than the compiler's own — "The guard needed a guard" below finds it a misreading of the
requirement and loosens it to accept the directive anywhere in the leading directive
prologue, which is the rule the code asserts by the end of this log. There is no parser
available to do this properly: this repo's `typescript` is v7, the Go port, and
`Object.keys(require('typescript'))` from Node returns `['version', 'versionMajorMinor']`
— no compiler API. `@babel/parser` is only a transitive dependency. So it is a hand-rolled
brace/quote-aware scanner, matching the convention the repo already uses for its other
source-reading guards.

Review found a real bug in it. `findFunctionBodyStart` located the declaration with a bare
`indexOf('function SelectionBubbleMenu')`, which also matches
`function SelectionBubbleMenuHeader` — so a file with such a sibling would silently scan
the *wrong* function's body and report `false` for the wrong reason. The guard would have
been red for a component that was perfectly correct. It now requires the character after
the matched name not to continue an identifier.

That is the fourth failure mode in the review checklist — an assertion true (or in this
case false) for a reason other than the intended one — and it is worth noting that it was
found by *attacking the guard with adversarial fixtures*, not by reading it. The five
planned attacks all passed; the sixth, improvised one is what failed.

One limit is left open deliberately and recorded at the code: a comment earlier in the
file containing the literal text `function SelectionBubbleMenu` could still seed a bogus
match. Closing it needs trivia tracking from offset zero, which is disproportionate for a
guard that reads one known file — and crucially the failure mode is loud, a thrown error
or a red assertion, never a silent pass. A guard that fails closed is allowed to be
approximate.

## The guard needed a guard

Review of the PR found four more things in that scanner, and the first is the sharpest:
**the identifier-boundary fix from the previous round had no regression test.** Stripping
it back to a bare `indexOf` left all four assertions green, because the live component has
no sibling `SelectionBubbleMenu*` declaration and every inline fixture declared only
`function SelectionBubbleMenu(`. The fix was correct and completely unpinned — one edit
away from silently reverting. A fixture declaring `function SelectionBubbleMenuHeader`
ahead of the real component now locks it in.

Two more scanner assumptions were doing unearned work. `indexOf('{', parenEnd)` took the
first brace after the parameter list, which is the body brace only because
`React.ReactElement` happens to contain no brace — an inline object return type would send
the scan into the annotation. And the paren-matching loop was quote-aware but not
comment-aware, so an apostrophe inside a parameter comment (`// the block we don't own`,
entirely idiomatic here) would latch the quote state and swallow every `)` until the next
apostrophe anywhere in the file. Both fail closed, which is why they were notes rather than
blockers, and both are fixed with fixtures — disabled one at a time *and together*, since
three fixes to one scanner can mask each other.

The fourth was a real false-positive rather than a fragility. `isDirectiveFirstStatement`
demanded the directive be literally the first token, but a JS directive prologue may hold
several entries and the compiler reads the whole run — so adding `'use client'` above
`'use no memo'` would have reddened an opt-out that still works. The rule now accepts a
directive anywhere in the leading prologue and still rejects a real statement between two
directives. The stricter version was not a deliberate house rule; it was a misreading of
the requirement, stated in a docstring as if it were the compiler's.

And the phrase collision was retired rather than documented: all three surviving
"syntax-only" sites now say what they actually mean — render-prop opacity, flow-insensitive
analysis — so `grep -rn "syntax-only" src/` returns exactly one line, the one that denies
the claim. Leaving the phrase in place would have preserved the ambiguity that generated
the over-broad note in the first place, which is a strange thing for a PR about that
ambiguity to do.

## And then the guard's name lied too

A second review round found five more, and the one worth recording is the name.
`isDirectiveFirstStatement` had just been corrected to accept a directive anywhere in the
prologue — its docstring said so — while the name went on asserting the rule the same
change had disproved. A reader who greps the name and does not read the body reproduces
exactly the misreading this PR exists to correct, inside the file written to correct it.
It is now `isDirectiveInPrologue`.

The rest were the scanner's remaining unearned assumptions: `matchBracket` was quote-aware
but not comment-aware, sixty lines above the parameter-list loop that had just been fixed
for precisely that; the directive-literal scan ignored backslash escapes while its sibling
handled them; the return-type skip covers a type that opens with a bracket but not a
generic-wrapped one like `Promise<{ node: X }>`; and both helpers were exported from a test
file with no importers — an invitation to exactly the reuse the documented limitation says
is unsafe.

The generic case was left unhandled and the docstring narrowed to what is actually covered,
which is the honest version of the same fix. The exports were dropped.

Three rounds on a fifty-line scanner is worth a note. None of it was gold-plating: every
round found a case where the guard would have been red for a correct component, or green
for a broken one. The pattern is that a hand-rolled scanner accumulates assumptions faster
than its author notices, and the only reliable way to find them is to attack it with
fixtures rather than to read it.

## What shipped

- The `useRovingTabindex.test.tsx` comment, restated against what was measured.
- The `SelectionBubbleMenu.tsx` CI-gate wording, corrected without over-correcting.
- `SelectionBubbleMenu.use-no-memo-directive.test.ts`, a falsified positional guard for
  the directive, plus the identifier-boundary fix review found in it.
- Three sites deliberately left untouched on the (a)/(b) grounds, then reworded anyway so
  the collided phrase stops existing.
- Four review-round fixes to the guard itself: the untested boundary fix now pinned, the
  return-type and parameter-comment assumptions closed, and the directive-prologue rule
  corrected from a misread requirement to the real one.
