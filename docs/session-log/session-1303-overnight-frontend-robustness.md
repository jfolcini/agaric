# Session 1303 — Overnight frontend robustness batch (2026-08-14)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-14 |
| **Subagents** | 4 build + 4 review |
| **Items closed** | `#3791`, `#3793`, `#3799`, `#3860` |
| **Items modified** | filed `#3881`, `#3882` |
| **Tests added** | +40 (frontend) / +0 (backend) |
| **Files touched** | 10 |

**Summary:** Four independent frontend items shipped as one PR — a real validator at the
graph-filter localStorage boundary, dead-guard removal in `tree-utils` and
`page-blocks-move`, and plural forms plus a regression guard for the `trash.*` i18n
namespace. Every item was built and reviewed by different subagents; three of the four
reviews found a defect the builder had missed, and two of those were gaps in what the
tests could *falsify* rather than errors in the production code.

**Files touched (this session):**
- `src/lib/filters/validate.ts` (new)
- `src/lib/filters/__tests__/validate.test.ts` (new)
- `src/components/graph/GraphFilterBar.tsx`
- `src/components/graph/__tests__/GraphFilterBar.test.tsx`
- `src/lib/tree-utils.ts`
- `src/lib/__tests__/tree-utils.mutants-simulate.test.ts`
- `src/lib/__tests__/tree-utils.mutants-drop.test.ts`
- `src/stores/page-blocks-move.ts`
- `src/stores/__tests__/page-blocks-move.test.ts` (new)
- `src/lib/i18n/history.ts`
- `src/lib/i18n/__tests__/catalog-parity.test.ts`
- `src/components/__tests__/TrashView.test.tsx`

**Verification:**
- `npx vitest run` (full frontend suite) — run serially by the orchestrator after all
  subagents finished; see the process note below on why concurrent runs were discarded.
- `npx tsc -b` — clean.
- pre-commit hook — all staged-file checks pass.
- pre-push hook — full clippy + push-staged checks pass.

**What each item actually changed:**

- **#3791** — `readPersistedFilters()` no longer casts `JSON.parse`d localStorage straight
  into `FilterPredicate[]`. A per-`kind` validator (24 variants, enumerated from
  `src/lib/filters/model.ts`, plus 4 nested wire-shape unions from `bindings.ts`) drops
  entries that fail and logs a `droppedCount`. Unknown `kind` is rejected outright; extra
  properties on an otherwise-valid variant are deliberately passed through, and that
  decision is pinned by a test.
- **#3793** — deleted the provably-unreachable `if (!activeItem)` guard in
  `simulateProjection` and two redundant clauses in `computeDropIndex`. Mutation ledgers
  re-derived from a fresh run.
- **#3799** — added `wouldCreateMoveCycle` to `reconcileBatchMove` for symmetry with
  `moveToParent`, and removed three redundant fragments. **This is a structural change,
  not a bug fix** — see below.
- **#3860** — 9 of 63 `trash.*` keys gained `_one`/`_other` forms (the issue named 3; the
  sweep found 6 more), plus a guard in the existing `catalog-parity` test requiring any
  `{{count}}`-interpolating key to carry complete plural forms.

**Process notes:**

- **The #3799 cycle guard fixes no reachable bug, and the PR says so.** The builder
  proved its own headline feature outcome-equivalent to the pre-existing post-rebuild
  presence check, and the reviewer independently re-derived the proof from the store's
  rooted-acyclic-forest invariant rather than accepting the fuzz corpus. Tracing the
  caller settled it: `page-blocks-reducers.ts:729-737` does `needsReload = true; await
  get().load()` on `null` from *either* path, so there is no observable difference. The
  guard is worth keeping for symmetry, wasted-work avoidance and diagnostic logging —
  but "cycle guard added" must not be read as "cycle bug fixed", and #3799 was closed on
  that framing.

- **Two mutation figures over two different populations is not a delta.** The tempting
  line for the #3793 PR body was "20 → 10 open mutants". It would have been wrong: the
  before-figure (16 survived + 4 NoCoverage) comes from the #3765 run over unrefactored
  code with an unstated total, while the after-figure (280 generated / 269 killed / 1
  timeout / 10 survived / 0 NoCoverage) is over the current code. Same metric, different
  denominators. The after-numbers are reported standalone.

- **Full-suite runs are unreliable while sibling agents falsify in a shared checkout.**
  One reviewer's full-suite run reported a `TrashView` timeout that did not reproduce.
  It ran while another reviewer was mid break-and-restore on that very file — the
  falsification discipline that makes reviews trustworthy also makes the tree
  transiently broken for anyone else running tests in it. Parallel *preparation* in one
  checkout is fine; the authoritative suite run has to be serial, after every agent has
  finished. Adopted as the rule for this loop.

- **A builder caught its own vacuous test.** #3791's first component-level test for
  "unrecognised kind is dropped" stayed green when the validator was bypassed, because
  `canonicalToGraphFilter`'s existing `default: return null` already dropped unknown
  kinds downstream. It was rewritten to assert the validator-specific observable (the
  `logger.warn` drop count) and then went red as required. This is the failure mode the
  falsification rule exists to catch, and it was caught by the break-it step rather than
  by review.

- **Scope held; two follow-ups filed rather than absorbed.** `#3881` records that the
  `JSON.parse`-then-cast pattern spans two generic preference primitives and ~8 further
  feature boundaries — the more valuable half of #3791, deliberately not bundled into a
  PR that would then have been reviewable only as a refactor. `#3882` records the 35
  count-interpolating i18n keys outside `trash.*` that #3860's guard now ratchets.
