# Session 1420 — a shared edge is not a shared alignment

A one-class fix, from a screenshot. The scheduled-date chip under a journal task sat a few
pixels to the left of the task's first character, so it read as belonging to the checkbox
gutter rather than to the title.

## The layout was already right, and that is why it was wrong

`SortableBlock` stacks the editor text and `BlockMetadataRow` as siblings inside one
`flex flex-col` content column, with a comment saying the chips are "left-aligned with the
text (user feedback 2026-06-20)". `BlockMetadataRow`'s own docblock says the same thing.
Both were accurate about the intent and both were describing something the markup did not
produce.

Siblings in one column share a left **edge**. That is not the same as sharing an
**alignment**: the text is inset from that edge by its own horizontal padding, and the row
had none. The gap was exactly the text's padding — `px-3`, 12px — which is small enough to
look like a rounding artifact and consistent enough to be a real one.

The fix is `px-3` on the row. `px-3` rather than `pl-3` so the chips also wrap against the
same right boundary the text wraps against, which matters more on a narrow viewport than
the left alignment does.

## Why one value covers both render states

A block renders through two different paths, and an alignment fix that only matched one of
them would have shifted the chips every time a block gained or lost focus — a worse defect
than the static misalignment, and one a screenshot would not show.

They inset by the same amount, from different places:

- unfocused — `block-static` in `StaticBlock.tsx` carries `px-3 py-1`
- focused — `.ProseMirror` in `index.css` carries `@apply px-3 py-1`

So one value matches both. That coupling is now load-bearing and was not written down
anywhere, so it is written at the row.

## The test pins the relationship, not the number

The obvious test asserts the row has `px-3`. It would be green in the exact scenario that
causes this bug: someone changes the **text's** inset and leaves the row alone. The row
would still be "correct" against a value nothing else uses.

So the test reads the inset off the rendered text container and requires the row to carry
the same one, with a guard that the text's inset is non-empty — otherwise a text container
that stopped carrying an explicit class would make the comparison `[] === []`, green and
vacuous.

Falsified in both directions:

- remove the fix → `expected [] to deeply equal [ 'px-3' ]`
- leave the fix, drift the **text** to `px-4` → `expected [ 'px-3' ] to deeply equal [ 'px-4' ]`

The second is the one worth having. The first would have passed against a literal
assertion too.

It lives in its own file because no existing suite renders both components:
`SortableBlock.test.tsx` mocks `EditableBlock` away, so there is no real text container to
measure there — the first attempt at this test was written in that suite and failed on a
null query rather than on an assertion, which is how the mock surfaced. `StaticBlock.test.tsx`
never renders the metadata row.

## A gap that stays open, stated rather than implied

The test covers the unfocused path only. The focused path gets its inset from a CSS rule,
and happy-dom applies no stylesheet, so there is no rendered value to read. Changing
`.ProseMirror`'s padding alone would misalign the focused state with nothing going red.

That is recorded in the test's own header rather than left for someone to discover, because
the file otherwise reads as if it covers "the alignment", and it covers half of it.

## Not done here

The same screenshot showed the task title truncated to "transfe…" while the chip row below
occupied a full line — vertical space spent on metadata while the text the user needs is
clipped. That is the more substantial issue and a separate decision about wrapping, so it
was deliberately left out of this change rather than folded in.

Also left alone: the scheduled chip's static green. It looks like a colour that should
encode urgency, and it deliberately does not — `BlockInlineControls.tsx` already explains
that the *due* date colour-codes overdue/today/future while SCHEDULED, in Org-mode
semantics, is future-only and has no such distinction to surface. Worth reading before
anyone "fixes" it.

## Verification

Whole frontend suite green. `tsc -b` clean, `oxlint` and `oxfmt --check` clean on both
changed files. `tsc` caught four missing required props on the new test's component and
oxlint caught a mutating `sort()` — both after vitest was already green, which is the usual
reminder that a passing suite is not the whole gate.
