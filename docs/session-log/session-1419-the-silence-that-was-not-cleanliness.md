# Session 1419 — the silence that was not cleanliness

#4339 and a residual the maintainer flagged by hand in #4012's comments. Both are the same
question in different clothes: when a check says nothing, does that mean there is nothing to
say, or that nothing was asked? The session ended by filing #4493, which is that question
about the linter itself.

## A default that applied everywhere and was pinned nowhere

`PopoverContent` defaults `collisionPadding` to `4` where Radix's own default is `0`. The
issue described it as roughly 45 call sites; the real figure, measured rather than repeated,
is **31 production call sites — 22 direct and 9 through the `MenuPopoverContent` wrapper that
passes the prop straight through — plus 8 in tests, 39 in total**, and *none* of them passes
the prop explicitly. Git archaeology confirms the default is genuinely new rather than
long-standing: before the commit that introduced it, the primitive never set `collisionPadding`
at all.

`collisionPadding` never reaches the DOM in a happy-dom test, because Radix only consumes it
once floating-ui actually measures layout. So the test calls the component directly as a plain
function and reads the element tree it returns. That is a real pass-through pin rather than a
rendering test in disguise, and the docblock says plainly that the *geometry* remains untested
— the honest scope of what a test can claim here.

The interesting part is what review changed. The first version pinned only that the default is
applied, and **a defaulting implementation and a hardcoding implementation both satisfy that**.
Replacing `collisionPadding={collisionPadding}` with `collisionPadding={EDGE_PADDING_PX}` — so
a caller's value is ignored entirely — left the original test green. Only the override arm added
in review went red, with `expected 4 to be 12`. A test pinning a default needs the override arm
or it does not distinguish a default from a constant.

The issue also asked whether any popover now flips to a side it did not before, since 4px is
enough to move a marginal decision. That one is recorded as unresolved rather than answered: no
test in the repo asserts `data-side` for any popover, so there is no "before" to diff against,
and settling it needs a real browser at real viewport sizes. The comment says that it is
reasoning rather than measurement, which is the only defensible thing to write down.

## The invariant held; the evidence offered for it did not

`useListStyles` writes `prevRef.current` during render, inside a `useMemo` — the same shape
`BlockListRenderer.tsx` had before it moved the write into a `useLayoutEffect`. The maintainer
flagged this one in #4012's comments as still unfixed and explicitly warned that the closed
sweep should not record it as handled.

Mirroring the downstream fix looked like the obvious move and would have been a regression.
`BlockListRenderer.tsx`'s own reuse gate is a `===` reference check against this hook's return
value, so deferring the write would hand back a fresh Map during the mount-to-first-flush window
even when content is unchanged — breaking the gate here and cascading the very extra render that
was already fixed one hop downstream. Documenting the invariant was the correct disposition, and
the reason is specific to this call graph rather than a general preference for comments.

The invariant itself survived scrutiny. The load-bearing claim is that a stale reuse would
require the map comparison to return true for maps that differ. The classic hole in that shape
is comparing entries without comparing sizes, under which a subset compares equal — so the
comparison was read rather than assumed, and run against adversarial inputs: different sizes,
same size with disjoint keys, same size with overlapping-but-not-identical keys, an explicit
`undefined` value against a missing key. It has the size check. The claim holds.

Two things did not survive.

The **pre-existing "no-op re-render" test passed for a reason unrelated to what it appeared to
cover**. It recreates the block array each render, but the memo's dependency is a joined
*string*, so the callback never re-invoked at all — the test could not have failed even with the
reuse logic deleted. This was settled with an instrumented compute counter rather than by
reading: zero invocations on a no-op rerender, exactly one on a reorder. The replacement test
reorders so the signature genuinely changes while content stays equal, and asserts reference
identity.

The second is the session's real find, below.

## A linter's silence, and what it was actually saying

The first draft of the invariant comment cited oxlint as corroboration: the `react(refs)` rule
promoted to error does not flag this site, unlike the sibling hook that needed suppressions.
The raw fact was true — the file reports zero findings. The inference was not.

Deleting a single comment from a copy of the file — an unrelated
`oxlint-disable-next-line react-hooks/exhaustive-deps` — makes **four `react(refs)` errors
appear**, at positions *above* the directive. A comment cannot change the AST, so removing one
cannot make a rule newly applicable; the only available mechanism is that the suppression reaches
further than `next-line`. Reproduced independently before it was believed.

So "not flagged" here meant "not scanned", which is a different fact from "judged safe", and the
comment now rests solely on the map-comparison argument rather than borrowing authority from a
silence that was not evidence.

The consequence is larger than one file, which is why it is filed as #4493 rather than fixed in
passing. The `react(refs)` promotion to error and the sweep that triaged findings across the
frontend both rest on the linter's output being complete. If any disable directive can mask
another rule's findings in the same file, a zero-finding reading cannot be distinguished from an
unscanned one — the fail-open shape this repo keeps closing in its own guards, this time in the
tool the guards defer to. The blast radius is deliberately left unmeasured in the issue rather
than guessed at; establishing it is the first step and doubles as the fix's test corpus.

## An issue that was already finished

#4012 was picked up as a batch item and turned out to need no code at all. Items 2 and 3 shipped
in an earlier PR — `src/editor/extensions/html-paste.ts` already carries its
"deliberately not carried over" block, and the ref write in `BlockListRenderer.tsx` had already
moved to a layout effect, going further than the comment the issue asked for. Item 1's product
decision had been taken and recorded exactly where the maintainer said it would be, in
`src/editor/markdown-parse/parser.ts`. The issue is closed with that evidence, and explicitly
does not sweep in the `useListStyles` residual, which is the work above.

All of this was in the issue's **comments**, and the batch dispatched a subagent before reading
them. The body alone was stale in a way the thread was not. Reading comments before acting is a
standing rule here; it was skipped, and it cost a build agent. Recorded because the failure is
procedural rather than technical, and procedural failures are the ones that recur silently.

## Verification

Whole frontend suite: **792 files, 18142 passed**, 1 expected fail, 37 skipped — three more
tests than the base, which is exactly what this session added (the popover default and override
arms, and the map-reuse reorder). `tsc -b` clean, `oxfmt --check` clean on all four changed
files. `oxlint` clean on the touched files, including under
`--report-unused-disable-directives-severity=error` — with the caveat that #4493 is precisely
about how much that clean reading is worth on a file carrying directives.

Both changes were falsified against copied backups with `cmp`-proven restores: the popover
override arm by hardcoding the padding, and the map-reuse test by returning a fresh reference
unconditionally. In each case only the intended test reddened and its siblings stayed green,
which is what distinguishes a test that covers something from a test that merely passes.
