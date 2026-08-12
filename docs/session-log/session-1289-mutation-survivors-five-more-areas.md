# Session 1289 — five more mutation areas, and what a null result is worth (2026-08-12)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-12 |
| **Subagents** | 5 build + 5 review (+1 targeted follow-up) |
| **Items closed** | `#3749` `#3751` `#3754` `#3765` `#3766` |
| **Items modified** | `#3142` (77 survivor lines removed from the machine-readable block), `#3788` (dedup evidence added) |
| **Tests added** | 25 (frontend) / 0 (backend) |
| **Files touched** | 9 |

**Summary:** Triaged the 77 listed mutation survivors across five more frontend areas under #3142 — 31 mutants killed, the rest recorded as accepted gaps with proofs of equivalence. `filters-model` reached **100.00%** with zero survivors and zero `NoCoverage`. The batch's real output was methodological: every builder was required to read Stryker's own `mutation.json` before designing a test, which eliminated the line-vs-column errors that cost session 1288 a rework pass — and the review layer then reversed a builder conclusion in *both* directions on the same module.

**Files touched (this session):**
- `src/lib/__tests__/agenda-sort.test.ts`
- `src/lib/__tests__/tree-utils.mutants-build.test.ts` (comments only)
- `src/lib/__tests__/tree-utils.mutants-depth.test.ts` (comments only)
- `src/lib/__tests__/tree-utils.mutants-drop.test.ts` (comments only)
- `src/lib/__tests__/tree-utils.mutants-simulate.test.ts` (comments only)
- `src/lib/filters/__tests__/model.test.ts`
- `src/lib/search-query/__tests__/classify.test.ts`
- `src/lib/vault-import.test.ts`
- `docs/session-log/session-1289-mutation-survivors-five-more-areas.md` (new)

Per-file line deltas are deliberately omitted, as in session 1288: they went
stale twice during that PR's review as follow-up commits landed, and
`git diff --numstat origin/main...HEAD` is both authoritative and always
current.

No source file was modified. Sources were temporarily mutated during falsification and restored; `git diff` over all five modules' sources is empty.

**Outcome per area** (scores measured from `reports/mutation/<module>/mutation.json` after the work, not reported by the agent that did it):

| Area | Killed | Accepted gaps | Score | Survivors | NoCoverage | Issue |
|---|--:|--:|--:|--:|--:|---|
| filters-model | 15 | 0 | **100.00%** | 0 | 0 (was 16) | #3754 |
| vault-import | 7 | 5 | 95.24% | 5 | 0 | #3766 |
| tree-utils | 0 | 16 | 93.27% | 16 | 4 | #3765 |
| agenda-sort | 8 | 31 | 90.24% | 31 | 2 (was 10) | #3749 |
| classify | 1 | 14 | 89.71% | 14 | 0 | #3751 |

Scores are over each module's mutants at the pinned Stryker config. Note the denominators differ from the issue lists: the issues carry 77 line-entries, but the JSON holds more distinct mutants because the filer dedupes by (line, mutator) — agenda-sort alone showed 31 real survivors behind 21 entries.

**Verification:**
- `npx vitest run` over the changed test files — green.
- `node scripts/run-mutation.mjs` per module — the table above is read back from the resulting JSON. `filters-model` was re-run after its reviewer added a test, so its 100.00% reflects the final state.
- `git diff --name-only | grep -v test` — empty.
- pre-commit and pre-push hooks pass.

No Rust was touched, so `cargo nextest` was not run for this session.

**Follow-up issues filed:** #3790 (agenda-sort: two unreachable branches, a conjunct that cannot be false, a sentinel colliding with real data), #3791 (persisted graph filters are `JSON.parse`d and cast unchecked), #3792 (the agenda-sort suite's `agenda-sort.ts:NNN` citations have drifted, one past EOF), #3793 (tree-utils: two mutually-redundant guards make a block unreachable), #3794 (`SENTINEL_ID`'s safety rests on an uppercase normalization that exists for hash canonicalization).

**Process notes:**

**Ground-truth-first worked.** Session 1288 lost a rework pass to three agents reporting a line cleared while a mutant at another *column* of that line was still alive. Requiring every builder to run Stryker and read `mutation.json` — tracking (line, column, mutator, replacement) — removed that class of error entirely this batch. It also surfaced a trap worth keeping: for `LogicalOperator` sub-node mutants the `replacement` field is an **AST node**, so splicing it textually reassociates the expression. On `agenda-sort.ts:359`, the naive splice yields a *killable* mutant while Stryker's actual parenthesised form is equivalent — a verifier following "apply the replacement verbatim" reaches the opposite verdict. Splice at the reported `location.start`/`end` offsets instead.

**The review layer reversed the builder in both directions on one module.** On `classify` the builder killed one mutant and excused fourteen. The reviewer found that (a) one of the fourteen was genuinely killable and guards a real defect — a consumed span running past `input.length` inverts the quoted-span arithmetic and duplicates the free-text tail — and (b) the builder's single kill was equivalent on every input `parse()` can produce, because its fixture nested two quoted spans, which `tokenize` cannot emit. Worse, that test asserted `'AAA  BBB  BBB'` — pinning a duplication artifact as correct, thirty lines below an existing test titled *"does not duplicate the overlap when two quoted spans nest inside one append() range"*. The file briefly held both contracts. The fabricated-fixture test was removed and replaced with a ledger comment; the real kill stayed.

**What makes a null result trustworthy.** Four of five areas concluded with large numbers of "equivalent" verdicts, which is the conclusion that saves the most work and therefore deserves the most suspicion. The technique that earned trust was not a bigger sweep but a **validated** one: `tree-utils` ran its differential harness against all 211 mutants in the same functions that the suite already kills, and confirmed it detected 211/211 before reporting zero differences on the survivors. Its reviewer then found the gap that control still left — every killed sibling differs across a whole half-space, while every survivor differs only at a single equality point, so 211/211 proved the harness *reached* those lines without proving it ever generated `depth === maxDepth`. It closed that with canary mutants firing only at the equality points, which separated "unreachable" (0 hits at the site, hits above it) from merely "unobserved". That distinction is the difference between a proof and a hope.

**Two claims that did not survive contact.** `filters-model`'s equivalence rested on "`by` only exists on the `tag` variant" — true of TypeScript-constructed values, and false at the trust boundary: `GraphFilterBar.readPersistedFilters()` `JSON.parse`s localStorage, checks only that `kind` is a string, and casts unchecked. The mutant became a real kill and the module reached 100% (#3791). Similarly, `tree-utils` recorded `SENTINEL_ID` as unreachable "under the id contract"; tracing block-id provenance through `projection.rs` and `restore.rs` showed no such contract exists on the untrusted path — the entire margin is one `to_ascii_uppercase()` whose doc comment says it exists for blake3 canonicalization (#3794). Both times the phrase doing the work was an appeal to a guarantee nobody had checked was enforced.
