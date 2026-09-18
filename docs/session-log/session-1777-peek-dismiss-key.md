# Session 1777 — the ref peek joins the overlay dismiss protocol

A block-reference peek opened from the keyboard could not be closed with the
dismiss key. #5086 offered three fixes and leaned toward the first while saying
plainly that the lean was a reading, not a measurement. It was measured here,
and the reading held.

## Why the key did nothing

The app's `closeOverlays` shortcut is a `window` keydown listener mounted in
`App`. It fires whenever the key is pressed outside a typing field, calls
`preventDefault`, and broadcasts `CLOSE_ALL_OVERLAYS_EVENT`. A keyboard-opened
peek holds focus outside any input, which is exactly that condition, so the
peek's own listener hit its `defaultPrevented` guard and returned. Nothing
closed it. A pointer-opened peek was never affected, because focus stays in the
editor, `isTypingInField` is true, and the shortcut bows out before
preventing anything — which is why the bug reads as "only the keyboard path".

## What the sweep of the protocol found

One dispatcher: the shortcut handler, plus `back-handlers.ts` synthesising a
keydown that feeds the same handler. Three subscribers — the shortcuts sheet's
state owner, the sheet itself, and the welcome modal — each a bare "close
myself if open", none reading another's state, none order-dependent. The peek
is that same shape and simply was not on the protocol.

That settled the choice. Moving the peek to the capture phase would have put it
ahead of Radix's own `DismissableLayer`, letting a peek steal the key from a
dialog stacked over it. Special-casing the peek inside the shortcut handler
would have put knowledge of one overlay into the thing that is meant not to
have any.

The fix does not depend on which listener runs first. Peek-first closes via the
raw path; app-first closes via the broadcast. An early comment asserted the
mount order as though it were the reason, and was rewritten: React runs child
effects before parent effects, so the asserted order is not even reliably true.

## The raw branch stays, and both paths now share one rule

The two are complementary and never both fire for one key. The held-focus test
moved into `dismissHoldingFocus`, used by both, because the neighbouring bugs in
this area all have the same shape: two paths doing one job, one of them
maintained.

## A falsification that had not actually been run

The first attempt to redden the e2e test reverted only the broadcast
subscription. That leaves the import unused, so `tsc -b` fails, the Playwright
preview server never starts, and every test dies on a refused connection — a
red that says nothing about the peek. The reported assertion failure could not
have come from that run. Reverting the import as well produced the genuine red:
the peek stays open while its sibling test passes against the same server.

Worth recording because the run *looked* like a pass of the falsification
discipline. A red is only evidence when it is the red you predicted.

## Verified

Full vitest, 835 files and 19263 tests; typecheck clean; the three Playwright
peek specs green. One unrelated backlinks failure in the full run passes 7/7 in
isolation and is CPU contention from a concurrent suite, not this diff.

Shipped as #5094.
