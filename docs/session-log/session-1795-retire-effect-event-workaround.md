# Session 1795 — retiring a workaround, and the guarantee that was not one

Two removals, both of things that stopped earning their keep the moment
something upstream changed.

## The `useEffectEvent` fiber-owner workaround (#4377)

Through React 19.2, `commitBeforeMutationEffectsOnFiber` drained
`updateQueue.events` for `FunctionComponent` and fell through `ForwardRef` and
`SimpleMemoComponent` without draining anything, so an effect event owned by a
`memo(Fn)` or `forwardRef(Fn)` component dispatched to its mount-time closure
forever. The repo carried three things because of that: a whole-tree guard
(`effect-event-fiber-owner.test.ts`) that failed if any effect-event owner became
wrapped, a ref-plus-layout-effect mirror in `DaySection`, and a paragraph of
`frontend.md` explaining the trap.

React 19.3 republishes on all four tags and `package.json` requires `^19.3.0`,
so all three are gone. Net −171 lines, and `DaySection`'s
`useControlledViewportEntry` is three lines where it was nineteen.

What stays is `effect-event-fiber-tags.test.tsx`, and its role inverts. It used
to be a curiosity pinning a bug; now that effect events are allowed back inside
memo'd components, it is the only thing between a React regression and a
silently frozen callback. Its header says so.

The removal is safe because `DaySection.test.tsx` already pins the property the
workaround protected — "reports intersection to the LATEST onVisible after a
re-render, without re-observing" — through the real `memo(DaySectionInner)`.
Falsified against a copy: replacing `reportEntered` with a mount-frozen ref
reddens it, restore verified with `cmp`.

## `cancel-in-progress: false` is not a per-commit verdict

`ci.yml` claimed that excluding `main` from cancellation "buys a completed
verdict per merged commit, which is what makes a red main attributable to the
merge that caused it". It does not. The setting protects the *running* run; a
concurrency group holds at most one *pending* run, and a third push evicts the
second before it dispatches a job.

This session produced an instance of it. On `main`: `e26dc1ae` started 08:48:18
and was still running, `5090cb91b` queued at 09:15:20, `d49aaa59d` arrived at
09:22:33, and `5090cb91b` concluded `cancelled` with zero jobs. A merged commit
with no verdict, looking from the run list exactly like a cancellation for
cause. That is #3672 again, one layer below where it was last fixed.

The fix is that runs which share no group cannot evict each other, so `main`'s
group is now keyed by `github.sha`. PR refs keep the per-ref group, where
superseding is the whole point. The cost is the one the original note already
accepted — N back-to-back merges burn N full main runs — except they now run
rather than queue behind a single slot.

`check-workflow-liveness.mjs` had the correct semantics written down all along
("GitHub keeps one pending run per concurrency group and cancels the older
pending one"), and cited main CI as its example. The skip logic it guards is
still right for every ref-keyed lane; main is no longer one of them, so the
comment says that instead.

This change cannot be falsified locally — its effect is only observable when two
merges land on `main` inside one CI run. What was checked is that the expression
yields a distinct group per main commit and a shared group per PR ref, which is
what a typo (`github.ref` for `github.sha`) would break invisibly.
