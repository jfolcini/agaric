# Session 1526 — the option the library ignores

#4708: the page/tag/block pickers appended a space after the token they inserted, so
`[[Page` → Enter → `,` gave `]] ,` and the user had to backspace.

The fix is four deletions. Getting there mattered more than the fix, because the issue I wrote to
describe it contained a confident, wrong explanation of why the deletion was dangerous.

## What I claimed, and why it was believable

I wrote that the trailing space was load-bearing: the pickers declare
`allowedPrefixes: [' ', ' ', '\n']`, so a following `[[` or `#` typed straight against a chip
would be treated as mid-word and the picker would not open. Delete the space naively and you break
inserting two links in a row.

Every part of that is checkable and I checked none of it. The option exists. Its values are
whitespace. The name says what it does. The story explained the code's shape.

## What the library does

`@tiptap/suggestion` v3.30.2, `findSuggestionMatch.ts`:

```js
40:  const text = $position.nodeBefore?.isText && $position.nodeBefore.text
55:  const matchPrefix = match.input.slice(Math.max(0, match.index - 1), match.index)
56:  const matchPrefixIsAllowed = new RegExp(`^[${allowedPrefixes?.join('')}\0]?$`).test(matchPrefix)
58:  if (allowedPrefixes !== null && !matchPrefixIsAllowed) return null
```

A new text node always begins after an inline atom, so typing the trigger directly against a chip
gives a match prefix of `''` — and the `?` on line 56 makes the empty string match
**unconditionally**. `test("")` is true for the whitespace list, for `[' ']`, and for `[]`. No
value of `allowedPrefixes` can reject it.

Worse for the claim: two of the four call sites — the `[[` and `((` pickers, which are what the
report was actually about — pass `allowedPrefixes: null`, so line 58 short-circuits and the check
never runs at all. I cited three files for the mechanism; one was not among the four being fixed.

Shipped code already depended on this. `toolbar-config.ts:233` computes `doc.textBetween(from-1, from)`,
gets `''` right after an inline atom, concludes `needsSpace === false`, and inserts a bare `@` —
the picker opening on an empty prefix next to a chip, in production, today.

## The shape of the mistake

I read a call site's *options* and inferred the library's behaviour from them. The inference was
coherent, matched the visible evidence, and was contradicted by four lines of the dependency I
never opened. This is the same failure as blaming an unmeasured magnitude: the explanation fit
every fact I had, and fitting the facts is necessary, not sufficient.

The instruction that caught it was worth more than the analysis: the builder was told to verify the
premise, not to work around it. It refuted the premise and said so; the reviewer then re-derived
the same conclusion independently, by driving `findSuggestionMatch` against a real schema with
controls. A hypothesis handed down as a constraint gets tested only if someone is explicitly asked
to test it.

## The falsification that could not exist

The obvious guard here is "prove the back-to-back-insert test goes red against a naive space
deletion" — except the naive deletion *is* the correct fix, so nothing to falsify against. The
honest substitute was to make the insert append `'x'` instead of nothing, putting a non-empty
prefix between chip and trigger. For `@` that reddens (the gate rejects `'x'`); for `[[` it does
not, because `allowedPrefixes: null` skips the gate entirely — so that test guards adjacency there,
not the prefix mechanism. Two different properties under one test name, and only the report that
said so made it visible.

## Nine tests, not five

Removing the space reddened eleven pre-existing tests that pinned it. Each was checked
individually for whether it was pinning the trailing space *or* something else that happened to be
asserted nearby: chain order, `insertContentAt` position, hard-break counts, caret offset, the
stale-range property in `picker-lifecycle`. All eleven were the former. One test had also been
manually reproducing the old chain with its own `insertContent(' ')` call, which is a fixture
encoding the bug as the expected shape.

## One consequence worth paying for

With the space gone, two chips inserted back to back now touch. Same-type chips share a background
colour and carry no margin, so `[[Alpha]][[Bravo]]` renders as two pills whose backgrounds abut and
can read as one. The review reported it and argued against fixing it here, on the grounds that a
chip margin would re-introduce a gap before the comma — the very thing this change removes.

That reasoning does not hold for an adjacent-sibling selector. `chip + chip` matches only a chip
directly following another chip; a comma is a text node, so `[[Alpha]],` stays tight. One rule with
`:is()` covers all nine type combinations, and the regression it fixes is one this change
introduced.
