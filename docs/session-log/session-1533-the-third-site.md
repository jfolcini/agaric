# Session 1533 — the third site

#4732: the same "returns before recording" shape #4707 fixed in `navigateToPage`, on a path that
issue did not touch. `switchTab` flips `currentView` to `page-editor` from a non-editor view in two
branches and writes no origin, so Journal → click a tab in the TabBar → Back lands on Pages.

The fix is the shape #4707 established: read `nextEnteredFrom(target)` before anything flips
`currentView`, write it only when it differs.

## Three instances of one bug is a question about the guard, not the third fix

#4287 established the mechanism, #4707 found a branch that skipped it, and this is a third. The
reviewer on #4707 said as much — that it "should probably be a guard rather than a review catch".
So the work here was less the fix than the audit: enumerate every site that flips the view into
the editor, and decide whether a guard earns itself.

Seven sites. Five are entries into a page stack and must record; three of those already did, and
the two `switchTab` branches were the gap. One is a render `switch` — not a write at all. And one
is genuinely different in a way that matters:

`navigation.ts`'s per-space fallback returns `'page-editor'` for a never-visited space during a
space switch. That is **not** an entry into a page stack: it is the default view for a *different
space's* slice, whose tabs and their persisted origins come from `tabsBySpace`. Recording the
pre-switch space's view there would send Back into a route belonging to the space the user just
left.

That single exception is what settles the guard question. A lint rule would have to key on "flips
to `page-editor`" — a property of an argument, not a syntactic site — and it would need an
allowlist on its first day, for a case whose correctness is the opposite of the rule's. Funnelling
every branch through one `enterEditor(tab)` helper is the better long-term shape, but the branches
differ in whether they `set()`, whether they clear `selectedBlockId`, and which tab they target, so
that is a restructure rather than a fix. The `Tab.enteredFrom` doc now enumerates its recorders,
which is the cheap version.

## Two tests that cannot fail against the bug, and saying so

Four tests. Two redden against the unfixed code. The other two — "a switch made from inside the
editor keeps the stack's original origin" and "no store write when the origin is unchanged" —
are green against it, and there is no way for them not to be: the defect is a *missing write*, and
both assert that nothing is written.

They are still worth having. Both redden against the plausible wrong fix — recording
`currentView` unconditionally instead of going through `nextEnteredFrom`, which is exactly the
implementation someone reaches for first and which breaks in-editor switches. But the honest
description is "guard against a wrong fix", not "test for this bug", and the difference is worth
writing down rather than reporting a falsification that was never obtained.

The same shape appeared on #4707 and was caught there too — a guard test whose property two
pre-existing tests already covered. The tell is identical: reverting the fix leaves it green.

## A rename the linter asked for

The helper started as `tabsWithOrigin`, which shadows a local of that name inside
`navigateToPage`'s already-on-top branch — `oxlint eslint(no-shadow)`. Renamed to
`withRecordedOrigin`. Worth noting only because the shadowed local is #4707's, three months of
context away from this change, and nothing but the linter would have connected them.
