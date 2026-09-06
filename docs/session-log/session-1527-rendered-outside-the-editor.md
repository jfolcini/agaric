# Session 1527 — rendered outside the editor

#4705 and #4706 are the same defect on two surfaces: a block's raw markdown rendered somewhere
that is not the editor, so `[[ULID]]` page links show as truncated ULIDs. The agenda panel's
Upcoming and Overdue sections ran `truncateContent(block.content, 120, …)`; the drag ghost ran
`{activeBlock.content?.trim() || …}`.

The tool for this already existed — `renderRichContent` with the `inline: true` mode added in
#1533 — and `DuePanel`, in the *same panel*, already used it. The bug was two surfaces that never
adopted it, not a missing capability.

## Two claims in the first pass, both wrong in instructive ways

**"AlertSection does not need memoising."** The stated reason was that its rows re-render on data
change rather than per pointer move. `focusedIndex` is `DuePanel`'s own state, and
`OverdueSection`/`UpcomingSection` are rendered inline, unmemoized and unvirtualized, over a
200-row page — so every arrow keypress re-rendered all of them. The diff had just replaced a cheap
regex with a per-row React element build. That is exactly the churn #2193 memoized away for the
projected rows *in the same file*, which is the tell: when a sibling in the same component solved
this, "it doesn't need it here" needs the difference named, not asserted.

**"The empty-content tests don't discriminate."** True, and the conclusion drawn from it — falsify
against a broken version of the fix instead — was right. But it is worth being precise about why
they still earn their place: they pin a branch the fix *introduced*. `truncateContent`'s third
argument supplied the fallback and was deleted; `renderRichContent('')` returns `null`, which
would blank the row and collapse the ghost box. A test that cannot fail against the *old* code can
still be the only thing standing between you and a new failure.

## The test that passed for the wrong reason

The memo test written to cover the first finding passed without any memo at all. It re-rendered
with the *same element object*, and React bails out on identical element identity — so the
assertion held whether or not `memo()` was there. An assertion true for two reasons, caught only
by removing `memo()` and finding the test still green. Rewritten to re-render a fresh element with
equal props.

## Three things deleted

- An inner `useMemo` on the now-memoized row that could never hit: `content` is its only prop, and
  its only other re-render trigger is the resolve-store subscription, which fires exactly when the
  tree must be rebuilt. Its dep array and `oxlint-disable` went with it.
- `expect(chip).not.toHaveAttribute('role', 'link')` — the role is unset for *either* value of
  `interactive`, because `clickable` also needs an `onNavigate` that AlertSection never passes.
  Only `tabindex` discriminates.
- The 120-character pre-truncation, which CSS `truncate` was already doing visibly.

And one asymmetry closed: AlertSection pinned `interactive: false`; the ghost left it open. That is
not cosmetic — the ghost is `aria-hidden="true"`, so an interactive chip's `tabIndex=0` would be a
focusable node inside hidden content (axe `aria-hidden-focus`), and the existing axe test uses
plain text, so it would not have caught it.

## What was deliberately not fixed

`query-result-utils.ts` returns a `string` consumed as an accessible name in a `role="option"` row
and as a table cell. Making it rich means splitting the a11y string from the display nodes in two
components that were out of scope. Left alone — but filed (#4719), and the reason matters: the
fallback is the *normal* path for cross-page query rows, and #4705/#4706 were its only trackers.
Closing both without filing would have dropped the third site silently.

`DuePanel.tsx:99` has the same latent `inline` gap in an untouched file — same issue.

## A generalisation

Both surfaces had been passing `block.content` around as a `string` for so long that the string
had become the interface. The fix is not "call the renderer" but noticing that a field whose
producer emits markdown has no business being typed as display text. `query-result-utils` is the
same shape one layer down, which is why it could not be fixed in the same diff.
