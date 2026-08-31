# Session 1474 — one honest locale

Phase 0 of #4555. No Spanish, no `language` preference, no `es` bundle, and `src/lib/i18n/index.ts`
still pinned to `en`. What ships is the removal of a set of defects that are live *today* for anyone
on a non-English OS.

## The bug is disagreement, not English

It is tempting to read "the app renders dates in the wrong language" as the problem. It is not. The
problem is that the app rendered dates in **two** languages at once: `Intl` sites followed the OS
(`toLocaleDateString(undefined, …)`), while every `date-fns` `format()` call was implicitly `en-US`
— there was no `date-fns/locale` import anywhere in `src/`. A Spanish-OS user saw "17 jun 2026" in
the page metadata bar and "Mon, Jun 15" in the agenda group header, in one view.

This distinction decided the fix, and the first attempt got it backwards. Resolving the date locale
from `navigator.languages` makes `date-fns` agree with `Intl` — and leaves both disagreeing with the
**UI catalog**, which is pinned to English. That is the same two-languages-in-one-view defect,
relocated from (Intl vs date-fns) to (dates vs interface). The issue says so directly: return *the
app locale's* locale and switch the `Intl` sites **from** `undefined` **to** the app locale, "so UI
language and date language can never disagree again."

So `getAppLocaleTag()` reads `i18n.language`, `getDateLocale()` looks that up, and the five
`Intl`/`toLocaleDateString(undefined, …)` sites now pass it explicitly. Today every one of them
resolves `en`, which is the correct Phase 0 end state: *one* locale, honestly applied, in every
surface.

A consequence worth stating because it looked like a judgement call and was not: with the app locale
pinned to `en`, a `date-fns` `es` import can never be selected. Shipping it would have been ~1KB of
unreachable Spanish calendar vocabulary. `DATE_LOCALES` registers exactly `en`, and tests reach the
other branch through `__registerDateLocaleForTests`, mirroring the existing
`__resetPriorityLevelsForTests` seam rather than inventing one.

## Vacuity was the whole risk here

"Route this string through i18n" is satisfiable by adding a key whose value is the same English
string, with nothing proving the call site reads it. Every converted site's test overrides the
English catalog value via `i18n.addResource` and asserts the override appears — so a call site that
reverted to a hardcoded literal fails, even though the literal and the catalog value are identical
in the shipped app.

The same trap applies to the date work in a sharper form. Asserting English output when English is
the only reachable value proves nothing at all. The tests drive a real `changeLanguage()` — to a
synthetic registered tag for the `date-fns` sites, and to a real tag for the `Intl` sites, whose ICU
data the runtime already has — and assert that dates **track** the app locale rather than that they
equal any particular string.

## Two sites the issue's own audit missed

`src/editor/template-variables.ts` and `src/lib/template-utils.ts` resolve `{{date:FORMAT}}` and
`<% weekday %>`-style tokens, and both were English-only regardless of OS. The issue's §1.7 table
calls itself exhaustive and does not list them. They are the same bug, they are fixed here, and the
audit being incomplete is worth recording — the next phase should not treat that table as a
finished inventory.

`src/lib/format.ts`'s docblock claimed "the app is pinned to English, so `toLocaleDateString(undefined,
…)` resolves consistently." That was already false before this branch: `undefined` follows the OS,
which is precisely the divergence. Rewritten rather than left as a comment that argues against the
code beneath it.

## Deferred on purpose

Phases 1-3 — the parity guard, the `language` preference, the `es` catalog, the Rust `ValidationCode`
work — are untouched. The issue gates Phases 2-3 on a fluent Spanish reviewer existing and says
plainly that shipping an unreviewed locale is the one outcome worse than shipping none. That is a
maintainer call, and Phase 0 stands on its own without it.

Also deferred: the ~12 concatenation sites (`GraphFilterBar`, `AgendaFilterBuilder` and friends) that
the full Phase 0 description lists. They are real and they are not here.

## The test that passed for the wrong reason

`detectColumns` originally reached its labels through a module-scope `import { t }`. That is not
reactive: the call site is `useMemo(() => detectColumns(results, customProps), [results, customProps])`,
so on a language change nothing in the dependency list changes, the memo does not recompute, and the
column headers keep the old language. The docblock above it claimed the design existed to avoid
exactly that freeze — it moved the freeze out one level rather than removing it. `t` is now a
parameter and a dependency, so the hook's `t`, whose identity changes on `changeLanguage`, drives
the memo.

The interesting part is that the first test written for this **passed identically against the fixed
and the reverted code**.

The cause is worth recording because it is invisible from the test: `QueryResult` has an unrelated
effect — the `customProps` / `getBatchProperties` fetch — that *also* lists `t` in its own
dependencies and calls `setCustomProps` whenever `t` changes. So every language switch produced a
fresh `customProps` reference, which invalidated the `columns` memo on its own, with or without the
fix. The assertion was true for two reasons and could not tell them apart.

An intermediate attempt was also wrong in a different way: an isolated harness component exercised
its *own* `useMemo` rather than `QueryResult`'s, so it could not discriminate the real wiring either.
Both were discarded rather than kept as "extra coverage" — a test that cannot fail is worse than no
test, because it reads as evidence.

What works: pin `get_batch_properties` to resolve once on mount and hang on every later call, so
`customProps` stays referentially stable across the round trip (`results` is already stable —
`useQueryExecution`'s query key has no language dependency). With the one variable isolated, the
reverted version goes red with the header stuck on English.

The warning counts were checked the same way rather than eyeballed — each file overwritten with its
`origin/main` version, oxlint run, then restored and `cmp`-verified. All five
`react(set-state-in-effect)` / `react(rule-suppression)` warnings across these files are
pre-existing; the diff adds none and fixes none.
