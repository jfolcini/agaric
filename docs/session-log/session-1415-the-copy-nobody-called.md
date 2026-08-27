# Session 1415 — the copy nobody called

#4414 and #4413 in full, and a deliberately partial slice of #4411. The most useful thing
this batch produced was not a fix; it was two discoveries about verification.

## A typecheck that checked nothing

Partway through, the builder noticed that `npx tsc --noEmit` in this repo type-checks an
**empty program**. The root `tsconfig.json` is solution-style — `files: []` with only
`references` — and `--noEmit` does not follow `references`; only `--build` does. So the
command exits 0 no matter how broken the tree is.

It had been running that command and reading "clean" as verification. Switching to
`npm run typecheck` (`tsc -b --noEmit`) immediately surfaced five real call-site errors and
two genuine type errors in a new file.

Nothing broken reached a commit, because the pre-commit `tsc` hook invokes
`npm run typecheck` — the gate ran the right command even while the self-checks did not.
But the self-verification was worthless for hours, and the only reason it was caught is that
someone eventually ran the other command and saw a different answer.

The repo had already written this down: the tsconfig carries a comment naming the trap and
citing two prior incidents (#3805, and #3905, where a whole project sat outside the
references list and was checked by nothing). The failure was not missing documentation. It
was reaching for a plausible generic command instead of the project's declared one.

**A verification command is itself a claim, and it needs the same scrutiny as the thing it
verifies.** The tell is available cheaply: a command that passes instantly on a large
codebase is either fast or vacuous, and it is worth one minute to find out which.

## The copy nobody called

The batch's own subject is hand-maintained duplicates of generated types — `AttachmentRow`
had drifted from its binding by a missing `content_hash`, and five siblings had the same
shape. All six now re-export from the generated module instead of redeclaring.

Review then found that the move of `importMarkdown` into the new `ipc-helpers` module had
left a **byte-identical second copy** behind in the old wrapper file. Production imported
the old one through the barrel. The new module's copy had zero callers, and the new test
written against it therefore exercised code nothing ran.

That is the same defect the batch exists to remove, reintroduced by the batch, for a
different function, while the drift guard for the original was being written. It is worth
sitting with rather than laughing off: a duplicate is created by *copying* and then failing
to delete, and the deletion is the step with no compiler pressure behind it. Every other
function in the move (`startSync`, `readAttachment`, the abort helpers, the trash
sweepers) was moved correctly. One was not, and only a reader following the *import graph*
rather than the file list could tell.

The fix is a one-line re-export, so there is exactly one definition and no call site or
mock had to change.

## A guard that only sees one spelling

A stale comment claimed `createPageInSpace` had two entry points; this PR removed one, and
the comment still named both. Correcting it turned up something more interesting: the
citation was written as `@/lib/tauri/system.ts`, and `check-doc-code-paths.mjs` resolves
only `src/…`-form paths. The alias form escapes the guard entirely.

Confirmed by rewriting the citation into `src/` form — the guard flagged it immediately —
and then rewording to avoid a live path. So the doc-citation guard has a blind spot exactly
where this codebase's own import convention lives. Filed rather than fixed here.

## What a drift guard has to survive

The new `wrapper-type-drift.test.ts` is a compile-time `Expect<IsEqual<…>>` assertion, so it
is checked by `tsc -b` and **not** by `vitest`, which strips types without checking them.
That distinction is load-bearing enough to be written at the top of the file.

Review falsified it three ways rather than once: reverting to the drifted declaration
(red), adding an *extra* optional field to an otherwise-correct declaration (red — so the
guard catches additions, not just omissions), and an exact-match declaration (green — so it
is not trivially satisfied). The middle case is the one that matters: an object-literal
trip-wire alone would have passed it, and only the `IsEqual` line does that work.

## Saying what was not done

#4411 asked for the PURE and SCOPE wrappers to be retired. Twelve went, across five deleted
modules. Roughly thirty-eight remain, and the issue stays open.

The boundary turned out to be blurrier than the issue's two-category framing suggests —
several wrappers mix trivial `?? null` coalescing with genuine DTO-building, which is the
#4412 hazard rather than this one. Two are excluded on evidence rather than taste:
`undoPageOp` is kept alive on purpose by `undo.test.ts`'s #4328 regression guards, which
mock it and assert it is *not* called; and `createBlock` carries a page/space invariant and
the client-ULID contract and is the highest-traffic wrapper in the file.

Review corrected the remaining count upward — the deferred list had undercounted — which is
the sort of number that matters, because it is the one the next batch will size itself
against.

## What shipped

- #4414 — six hand-declared duplicates replaced by re-exports, plus a seventh the issue's
  own audit missed, behind a compile-time drift guard falsified three ways.
- #4413 — the floor has a real home in `@/lib/ipc-helpers`, and two guards were extended to
  see it: one exempted the new seam narrowly, the other would otherwise have let every
  component that moved there drop silently out of the IPC-error-path requirement.
- #4411 — twelve wrappers retired, thirty-eight named and left, the issue re-scoped rather
  than closed.
