# Session 1355 — Auditing 26 "equivalent mutant" claims in the query/filter modules (2026-08-19)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-19 |
| **Subagents** | orchestrator-only |
| **Items closed** | `#3751`, `#3760`, `#3762`, `#3763`, `#3764` (all confirmed, none reopened) |
| **Items modified** | `#3142` (audit comment), `#4173` (filed) |
| **Tests added** | +1 (frontend) / +0 (backend) |
| **Files touched** | 2 |

**Summary:** Adversarially re-audited the 26 mutation findings a previous pass had disposed of across `query-utils.ts`, `tagExpr.ts`, `tokenize.ts`, `to-search-filter.ts` and `classify.ts` — 25 declared equivalent with no test written, 1 killed. Every verdict was re-derived from the code's semantics rather than from the evidence originally offered, and **all 26 hold**, so no issue was reopened and no line returned to #3142's block. The audit's real output was evidential, not verdictal: several claims rested on "the suite stays green under the mutation" (which is the definition of a surviving mutant, not evidence about it) or on sweeps whose generators could not reach the mutated branch, and those were replaced with structural arguments plus instrumented reach counts. One killable mutant was found and its killing test deliberately **rejected as vacuous**.

**Files touched (this session):**
- `src/lib/__tests__/tagExpr.test.ts` (+11) — the `makeGroup()` default-parameter test from the previous pass, kept and independently re-proved
- `docs/session-log/session-1355-query-mutation-survivors.md` (new)

No source file changed. That is the correct outcome for 25 equivalent mutants, and it is also why the audit had to be evidential rather than diff-based.

## What was audited

Ground truth was re-established from the real harness before any judgement, because the line numbers carried in the child issue bodies can go stale:

| Module | Killed | Timeout | Survived | NoCoverage | Score |
|---|--:|--:|--:|--:|--:|
| tag-expr | 107 | 2 | 0 | 0 | **100.00%** |
| tokenize | 127 | 5 | 4 | 0 | 97.06% |
| query-utils | 126 | 0 | 4 | 0 | 96.92% |
| to-search-filter | 72 | 0 | 3 | 0 | 96.00% |
| classify | 112 | 10 | 14 | 0 | 89.71% |

The 25 survivors matched the issue bodies exactly, line and column. `tag-expr` is now clean, and the harness names the new test as the sole killer of its one mutant (`✓ makeGroup defaults the combinator to "and" … (killed 1)`) — which is what makes that test non-vacuous: it is the only thing in the suite that discriminates the mutant.

## Method

Three layers, in this order, because the order is the point:

1. **Semantic re-derivation.** For each mutant, an argument from the code that no input can distinguish it — or the input that does.
2. **Differential execution against the real source.** Each mutant hand-applied by exact-string patch to the actual file (not a reimplementation), a shared input corpus run through both versions, outputs compared line-for-line, source reverted. 25/25: zero differences.
3. **Reach instrumentation — the denominator.** A sweep is worth exactly its generator. `classify.ts` was temporarily instrumented with boundary counters and the corpus re-run, so each "0 differences" comes with the count of times the corpus actually *entered the state where the mutant could diverge*:

| Mutant | Diverges only when… | Corpus hits |
|---|---|--:|
| `classify:161:11` | `q[1] === to` | 1,940 |
| `classify:175:7` | `cursor === input.length` | 7,451 |
| `classify:182:9` ×2 | `qs === pos` | 2,269 |
| `classify:186:7` ×2 | `pos === stripped.length` | 1,941 |
| `classify:152:12` | `qi === quotedOrdered.length` | 884 |
| `classify:99:31`, `:103:9` ×2 | `indices.length === 1` | 5,340 |
| `classify:106:13` | `filters[i]` falsy in the shadow loop | **0** of 1,432 |
| `tokenize:139:24` ×2 | word loop starts on an unmatched `"` | 49,776 |
| `query-utils:96:36` | `rest` is all-operator / no-operator | 84 / 84 |

The zero on `classify:106:13` is the proof, not a gap: `!shadowed` is unreachable because `indices` only ever holds positions where `filters[i]?.kind === kind` already evaluated truthy, and nothing in the file deletes or nulls an entry.

## The one killable mutant, and why no test was written for it

`classify.ts:161:11` (`q[1] <= to` → `q[1] < to`) **can** be distinguished. Working out how is what settled it: the two differ only when a quoted span ends exactly at `to` *and* the next quoted span starts before `to` — i.e. only for **overlapping** quoted spans. `tokenize` cannot emit a pair (a quoted token only closes on a `"` followed by whitespace or end-of-input); checked exhaustively over every string of length ≤ 9 from `{a, ", space, tab, :}` — 2,441,406 inputs, **0 overlapping and 0 adjacent** pairs.

`classify` is exported and documented to tolerate spans it did not produce, so the overlapping pair was built by hand to see what a killing test would have to assert:

```
classify([{quoted [0,5]}, {quoted [1,4]}, {word 'tag:z' [5,10]}], '"a b"tag:z')
  original → freeText: '"a b"a b"'     ← duplicated tail
  mutant   → freeText: '"a b"'
```

A test pinning the original here asserts that the **duplicated-tail** output is correct — flatly contradicting the contract in `classify`'s own doc-comment ("does not duplicate the tail when a consumed span runs past the end of the input"), which exists to prevent exactly that. It would lock in the worse of the two behaviours, on an input the tokeniser cannot produce, to satisfy a coverage tool. Rejected.

## Where the original evidence was wrong (without the verdict being wrong)

- **`tokenize:102:20` / `:135:22`** — offered "a 200,000-input fuzz never throws". The `assertAdvanced` guard *cannot* fire on correct code, so a non-throwing fuzz was guaranteed in advance and carries no information. The argument that works is structural: the `where` label is materialised only inside the `cur <= prev` throw, and every branch of both loops strictly increases `i`.
- **`to-search-filter:128:*`, `tokenize:139:24`** — supported by "the scoped suite stays green under the mutation", which is a restatement of "the mutant survived".
- **`query-utils:96:36`** — the sweep behind it was 219,608 inputs, but nothing said whether the generator could produce a string containing `>`, `<`, `=` or `!`. Re-run from a generator built out of exactly those characters, with all four cells of the `(has-operator, has-non-operator)` truth table populated. The equivalence turns out to be a *consequence of #3795*: before that fix added the malformed-shorthand fallback, this mutant would have been killable.
- **`classify:161:11`** — "the stale-skip pass advances past it there instead" is true but never states what would have to hold for the mutant to diverge, so it cannot be falsified.

## Process finding

The three `to-search-filter` mutants closed on 2026-08-19 had **already** been triaged to the same verdict on 2026-08-12 and removed from #3142's block; the 08-17 weekly run re-added them as *new* and re-opened #3763. #3760 and #3764 show the same Aug-12 / Aug-17 / Aug-19 pattern. Three passes over three provably unkillable mutants in seven days.

This is #3142's documented behaviour ("once a line is gone, the next run that sees that mutant again will re-add it as new"), not a fault of either triage — the filer's only cross-run memory is the marker block, in which "hand-removed because proven equivalent" and "gone because it was killed" are stored identically. Filed as **#4173** with three options: the #3593 refactor treatment (which honestly retires only ~4 of the 25 — the rest are `noUncheckedIndexedAccess`-mandated, load-bearing defensive contracts, or intrinsic JS semantics), a filer-side accepted-gap block keyed on the full `file:line:column:mutator` id, or an explicit recorded decision to keep re-triaging. Deliberately **not** proposing `// Stryker disable` directives: #3593 rejected them because mutator-class directives also hide observable siblings on the same line, and that rejection stands.

**Verification:**
- `npx tsc -b --noEmit` — exit 0, no diagnostics.
- `npx vitest run` — 777 files, 17,635 passed / 1 expected fail / **1 failed**. The failure is `src/components/__tests__/TrashView.test.tsx > shows singular partial-progress toast when exactly 1 item was removed before the error`, a 60 s timeout on a test whose own comment notes its render cost auto-scales with `MAX_TRASH_BATCH_IDS`. Re-run in isolation: **101/101 pass in 24.6 s** (vs 154 s for the file under full-suite load). Load flake, in a component suite this session's diff (one `src/lib/__tests__/tagExpr.test.ts` file) cannot reach.
- `node scripts/run-mutation.mjs tag-expr query-utils tokenize to-search-filter classify` — all five modules ran clean; scores in the table above.
- `makeGroup` kill re-proved by hand: mutation applied (`= 'and'` → `= ''`) → `AssertionError: expected '' to be 'and'`, 1 failed / 17 passed; reverted → 18/18.
- Every hand-applied mutation reverted and confirmed reverted (`git status` clean apart from the one test file) after each of the 25 differential runs and both instrumentation runs.

**Lessons learned (for future sessions):**
- "The suite is green under the mutation" is the *definition* of a surviving mutant. It can never be evidence that the mutant is equivalent. Equivalence needs an argument from the code's semantics, or input coverage that provably saturates the discriminating state.
- When a sweep is used to check an argument, report the **reach**, not the input count. "300,000 inputs, 0 differences" and "0 inputs reached the branch" are the same observation until the denominator is stated. Instrumenting the real source with boundary counters and reverting costs one extra run and turns the sweep from decoration into evidence.
- A mutant being killable is not sufficient reason to kill it. If the only distinguishing input is one the module's own producers cannot generate, and the unmutated code behaves *worse* on it, the killing test pins a bug as a contract. Check what the original actually outputs on the distinguishing input before writing the assertion.
- Check whether a proposed remedy has already been litigated. `// Stryker disable` looked like the obvious durable fix here until #3248 → #3593 turned up an explicit prior rejection with a reason that still applies.

**Commit plan:** not pushed — audit deliberately left as a working-tree diff (`src/lib/__tests__/tagExpr.test.ts` +11) plus this log, for the caller to stage.
