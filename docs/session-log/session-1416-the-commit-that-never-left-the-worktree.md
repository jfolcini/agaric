# Session 1416 — the commit that never left the worktree

#4406 is closed. `react/refs` went from 76 findings to 0 and from `warn` to `error`, so the
next violation fails CI instead of joining a pile nobody reads.

The work itself had already been done. It just never reached anywhere anyone could see it.

## A commit is not shipped until it is pushed

The change existed as `5bc7fedab` on a branch in a stale worktree — written, verified,
falsified twice, complete, and never pushed. From the outside that state is indistinguishable
from the work not existing: the issue was open, main had none of it, and nothing in the repo
pointed at the branch. It survived only because the worktree happened not to be pruned.

There is a real lesson under that, and it is not "remember to push". It is that **a verified
commit is the most expensive thing to lose**, because the verification is what cost the time,
and the verification is exactly what does not survive in anyone's head. Re-deriving *what* the
change was took minutes; re-deriving *why suppression rather than rewriting* would have taken
the whole of #4469 again.

## The ground moved underneath it

Between the commit being written and being recovered, #4475 landed and rewrote three of the
same files. `git rebase` conflicted; `git cherry-pick` conflicted; both were abandoned rather
than resolved hunk by hunk, because a conflict marker in a *comment* is the worst possible
place to guess. Comments do not fail tests. A merge that silently keeps the older, wronger
sentence produces a green build and a false record.

So the old commit was read as a **reference**, not replayed as a patch. Each site was
re-derived against the current file, and where the two wordings collided, #4475's won:

- `SelectionBubbleMenu.tsx` — the old commit kept member access under three disables. #4475
  took the opposite route: destructure, and add `'use no memo'` to opt the component out of
  the React Compiler explicitly. That is strictly better (it states the constraint in the
  compiler's vocabulary, and survives a later tidy-up of the lint suppressions), and it
  already draws zero findings. Nothing was re-applied here. The old commit's three disables
  would have been *unused directives* — which, under
  `--report-unused-disable-directives-severity=error`, is itself an error. A blind replay
  would have failed the very gate this change installs.
- `AddFilterPopover.tsx` / `HasParentMatchingEditor.tsx` — kept #4475's prose, deleted only
  the now-false "Left open", and grafted the directive on.
- `useRovingTabindex.ts`'s docblock — still prescribes destructuring with no warning attached,
  which is what led a previous sweep into #4469. It now carries a CAUTION, written against
  #4475's world (`'use no memo'` as the escape hatch) rather than the old commit's.

## The wording that was wrong in both versions

#4475 replaced "syntax-only" in `BlockContextMenu.tsx` with "flow-insensitive". Review flagged
that this is also wrong, and it is worth being precise about why, because both phrasings are
claims about an analysis nobody measured.

Flow-insensitivity means ignoring the *order* of statements. That is not what happens here.
The rule sees `itemRefs` — a ref object — passed as an argument, and counts passing it as an
access. It cannot follow the object to the callee that turns it into a ref callback, so it
cannot know the write is deferred to attach time. That is conservative aliasing, not
statement-order blindness. It now reads as "counts passing the ref object along as an access
and is conservative about where a handed-off ref ends up" — which describes the observed
behaviour without asserting an unverified property of the implementation. (#4484 note 6.)

The distinction #4475 drew survives intact and is the whole load-bearing claim of this change:
the rule's **analysis** is conservative (true), but the **transformation** it prescribes is
not behaviour-preserving (false, disproven by #4469 through compiled output). `grep -rn
"syntax-only" src/` still returns exactly one line — the test comment that denies the claim.

Two more reasons did not survive review, both because they named the wrong cause.

`AddFilterPopover.tsx` inherited a comment blaming the render-prop boundary: oxlint "can't see
through" it "to know the callbacks below don't touch a ref themselves". Measured on a copy:
the callbacks *do* touch a ref. `onApply` calls `emit`, `emit` calls `close`, and `close`
reads `triggerRef.current` to restore focus. Delete that one read and the finding disappears
with the render prop untouched; strip only the directive and it returns as an error at
`576:35`. The site is still safe — the read is event-time — but for a local reason, not an
inherited one, and the comment now says which.

`use-editor-event-dispatch.ts` claimed "`.on()` writes and `refs.current` reads both happen
outside render". `BlockTree.tsx:858` calls `dispatch.on('flush', …)` in its component body,
and the file's own line 106 says handlers are registered "during the current render". The
`.on()` half was simply false. The real safety argument — nothing reads `staged.current`
until the post-commit `useLayoutEffect` publishes it, so an abandoned render leaves only a
slot the next render overwrites — is the one the directive now makes.

## Why 40 suppressions and not 40 rewrites

Because the rewrite is the dangerous move, and the suppression is the safe one — the reverse
of the intuition.

`react/refs` is a port of the React Compiler's own validation, so a finding is usually the
compiler *refusing to optimise that function*. Silencing the finding leaves the function
uncompiled: behaviour-preserving by construction. Fixing the code removes the compiler's
reason to bail, and the component comes out the other side memoised — which is a runtime
change, and in `SelectionBubbleMenu` was a freeze, because every dependency of the new cache
was identity-stable and a TipTap `editor` mutates behind a stable reference. `vite.config.ts`
disables the compiler under Vitest, so no unit test can see this class at all.

**That argument has a scope limit, and review made it explicit rather than leaving it
implied.** `vite.config.ts` runs babel over `.tsx`/`.jsx` only, so a finding in a plain `.ts`
file — nine of the thirteen touched files, and the majority of the directives — is never seen
by the compiler, and neither suppressing nor rewriting has any memoisation consequence there.
Those sites are suppressed on their own semantics, and the reasons now say so instead of
borrowing #4469's authority. `useUnlinkedReferences.ts` had cited #4469 directly; it no
longer does.

Each of the forty directives names what the rule flagged and why the code is nonetheless
correct. **A directive without a reason is worse than a warning**: it is permanent, silent,
and unreviewable. They fall in five buckets — a ref written and read within the same render,
a render-phase write whose read is deferred to commit, React's documented lazy-ref-init
idiom, a ref handed to a consumer that defers the mutation, and one deliberate re-render
avoidance. Per-line only; the sole block-level `react/refs` disable in the tree is the
pre-existing pair in `src/__tests__/mocks/ui-select.tsx`, whose own comment records why
per-line directives cannot express its taint. `frontend.md` names it rather than stating an
absolute a grep falsifies.

One site got the real fix instead. `useLocalStoragePreference` read `failedWriteRef.current`
during render to produce its **returned value** — rendering output derived from a mutation
React does not track, so any consumer that skips a re-render holds the pre-failure value, and
the read is unsafe under concurrent rendering. (It is a `.ts` file; the compiler is not the
mechanism, and the reason no longer claims it is.) No honest reason could be written for
suppressing that,
so it was not suppressed: the render-facing read now comes from state, and the ref keeps only
its synchronous job feeding the functional updater's `prev` inside `setPreference`. Falsified
against a copy by neutering the state write — `expected 'initial' to be 'unpersisted'` — and
restored `cmp`-clean.

## What made the promotion safe to assert

Zero findings is not the same claim as "the rule is now enforced", and the difference is
testable. On a **copy** of `usePrimaryFocus.tsx` with its directive stripped, oxlint reports
`error react(refs)` — not `warning`. The control (same copy, directive intact) is silent. That
is the evidence that `warn` → `error` actually took effect, rather than the count reaching
zero for some unrelated reason.

## Verification

- `npx oxlint --report-unused-disable-directives-severity=error` (the prek hook's exact
  invocation): `react(refs)` **76 → 0**, zero errors, zero unused disable directives. Total
  warnings 194 → 118, the difference being exactly the 76 suppressed findings.
- `npm run typecheck` clean. (Note for the next person: a bare `npx tsc --noEmit` here
  type-checks an *empty program* — the root tsconfig is solution-style and `--noEmit` does not
  follow `references`.)
- `npx vitest run`: 791 files, 18158 passed, 1 expected fail, 37 skipped.
- The gate that actually covers the memoisation class is `e2e/mobile-editor.spec.ts`, not
  vitest. This change adds no rewrite of the kind that broke it — the one behavioural edit is
  in a plain `.ts` file the compiler never sees — but the constraint is now written down in
  `docs/architecture/frontend.md` and in the hook docblock that prescribed the dangerous form.
