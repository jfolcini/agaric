# Session 1292 — a search that worked differently depending on your locale (2026-08-12)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-12 |
| **Subagents** | 1 build |
| **Items closed** | `#3800` |
| **Items modified** | — |
| **Tests added** | 8 (frontend) / 0 (backend) |
| **Files touched** | 3 |

**Summary:** In-page find folded case with `toLocaleLowerCase()` and no locale argument, so matching followed the host's locale. Under `tr`/`az` a search for `i` stops matching `I`; under `lt` folds grow combining dots. All three fold sites now use `toLowerCase()`. The issue that described the bug was wrong in three ways — one of which would have produced a *worse* bug if implemented as written.

**Files touched (this session):**
- `src/lib/in-page-find/matcher.ts`
- `src/lib/in-page-find/__tests__/matcher.test.ts`
- `docs/session-log/session-1292-locale-independent-folding.md` (new)

**Verification:**
- `npx vitest run src/lib/in-page-find/__tests__/matcher.test.ts` — green under the default locale, and under `LC_ALL=tr_TR.UTF-8`, `az_AZ`, `lt_LT`.
- `npx tsc -p tsconfig.app.json --noEmit` — clean (the bare `tsc --noEmit` is vacuous here, #3805).
- `node scripts/run-mutation.mjs in-page-find-matcher` — **91.32% before and after**, with all 29 not-killed mutants mapped 1:1 onto the baseline under the expected line shift. Zero new survivor locations, zero lost kills.
- `prek run --files <both>` — all hooks pass.

**Follow-up filed:** #3809 (four ledger-documented dead fragments in `matcher.ts`, one of which this change promoted from *empirically* to *provably* dead).

**Process notes:**

**The issue was wrong three times, and one error was dangerous.**

1. **It named two fold sites; there are three.** `scanLiteral`'s haystack fold was missed. Implementing the issue as written would have folded the needle one way and the haystack another — **strictly worse than the bug it fixes**, and the kind of half-application that produces a much more confusing symptom than the original. This is the first time in this cluster that following my own analysis would have made things worse rather than merely wasted effort.
2. **`'I'.toLocaleLowerCase()` is not `'ı'` in V8.** Latin-1-representable strings take a fast path that ignores the default locale entirely, so `'Istanbul'` folds identically everywhere and the issue's headline example — "plain ASCII search misses plain ASCII text" — is false as stated. **But the correction cuts the other way:** a single non-Latin-1 character anywhere in the text node flips the whole node onto the ICU path, so `It’s Istanbul` searched for `i` returns nothing under `tr`. Real prose is saturated with curly apostrophes, em dashes and emoji, so the practical blast radius is *larger* than the issue claimed, via a mechanism it did not describe.
3. **Two of the four `lt` expansions are inert in practice** for the same fast-path reason; `U+0128` is the only reliable tripwire there.

**The fast path is also a test-design trap.** Every new fixture appends U+2014 deliberately, because without a non-Latin-1 character the tests pass regardless of the fix — silently vacuous in exactly the way this cluster has been hunting all day. That is documented in the test block rather than left as folklore.

**The tests are demonstrated tripwires.** With the three fold sites reverted they fail 5 under `tr_TR` and 1 under `lt_LT`; the pre-existing suite stayed green under the default locale, which is precisely why the bug shipped and survived a mutation-testing pass. A bug reachable only under a locale nobody runs CI in is invisible to both tests and mutants.

**An obsolete guard removed.** Session 1290 added a `beforeAll` asserting `'İ'.toLocaleLowerCase()` has length 2, to stop the U+0130 tests from silently depending on the ambient locale. That guard existed only to *name* the dependence this commit deletes, so it is gone. The inline assertion inside the folded-path test is kept but rewritten to `toLowerCase()` — it still pins that test to the slow path, which is a different and still-live coupling. Worth noting the sequence: a guard added two sessions ago to make a latent dependence visible has now been retired by fixing the dependence. That is the guard working as intended, not churn.
