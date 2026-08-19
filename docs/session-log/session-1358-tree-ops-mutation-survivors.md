# Session 1358 — adversarial verification of the tree-ops mutation-survivor diff (2026-08-20)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-20 |
| **Subagents** | orchestrator-only (this session re-verified a prior agent's diff; no new build subagents) |
| **Items closed** | — (none closed by this session; see notes) |
| **Items modified** | #3750, #3765, #3759 (comment posted, not closed) |
| **Tests added** | +0 (frontend, net) — this session only corrected/retracted comments in a fourth pre-existing test file; the diff under review had already added the tests |
| **Files touched** | 4 |

**Summary:** Adversarially re-verified a test-only diff (`block-tree-ops.test.ts`,
`tree-utils.mutants-build.test.ts`, `page-blocks.reorder.test.ts`) that claimed 11
mutation-survivor kills and various equivalence arguments across #3750/#3765/#3759,
against production files it claimed were byte-identical to their originals. Confirmed
the production-file claim, hand-reproduced RED/GREEN for every killable mutant the diff
targets (14 distinct points, more than the 11 claimed), and audited every equivalence
argument on the merits rather than trusting "green under mutation" as proof. Found one
genuine defect: two of eight `page-blocks-move` mutants deferred to a pre-existing
ledger (`page-blocks.move-reparent.test.ts`) are NOT equivalent — the production file's
own later doc comment already retracted that exact claim — and fixed the ledger (stale
line-number drift on five entries, retraction on two) rather than let the diff's
implicit "resolved" framing stand.

**Files touched (this session):**
- `src/stores/__tests__/page-blocks.move-reparent.test.ts` (+29/−23) — this session's
  fix: corrected five stale line citations in the pre-existing `#3759 EQUIVALENCE
  LEDGER` and retracted the `361:9`/`361:15` (`!cur` guard) claim, which the
  production file's own `#3799 Finding 5` doc comment already contradicts.
- `src/lib/__tests__/block-tree-ops.test.ts`, `src/lib/__tests__/tree-utils.mutants-build.test.ts`,
  `src/stores/__tests__/page-blocks.reorder.test.ts` — the diff under review; verified,
  not further modified.

**Verification:**

1. **Production files untouched** — `git diff` against `src/lib/block-tree-ops.ts`,
   `src/lib/tree-utils.ts`, `src/stores/page-blocks-move.ts` was empty before any of
   this session's work; confirmed via `md5sum` before/after every hand-mutation round
   that each file was restored byte-for-byte.
2. **Kills re-proved by hand** (mutate production source → run the targeted test →
   confirm RED → revert → confirm GREEN), 14 distinct mutation points, all genuinely
   killed — more than the 11 originally reported:
   - `block-tree-ops.ts:130:57` (UnaryOperator, `?? -1` → `?? +1`, ghost-reference
     indent fallback).
   - `page-blocks-move.ts`: `112:12` (BlockStatement), `113:7` EqualityOperator
     (`==`→`!=`), `113:34` (BooleanLiteral), `114:7` (ConditionalExpression, both
     directions), `114:47` (BooleanLiteral), `118:10` (MethodExpression, `.some`→
     `.every`), `118:26` (ArrowFunction), `147:7`/`147:61` (the cycle-guard branch),
     `148:17`/`148:37`/`148:96` (the `logger.warn` call's args), `231:32`/`232:9` (the
     presence-check loop).
3. **Equivalence claims audited on the merits**, not on "the suite stayed green":
   - `tree-utils.ts:383:7`/`410:5` — the algebraic identity
     (`x - sign(x)·D = 0` at `|x| = D`) verified by hand, then the `>`→`>=` mutation
     applied and the full `tree-utils` suite (97 tests) re-run green.
   - `tree-utils.ts:423:7`/`424:7`/`431:7` — idempotent-clamp argument (the only extra
     case an off-by-one `>=`/`<=` admits is `depth === bound`, where the assignment
     writes back the value already held) verified the same way.
   - `tree-utils.ts:443:9`/`539:16` — the "unreachable, prior branch already
     intercepted" claims re-derived from the control-flow structure directly (not
     trusted from the comment): `443:9`'s equality case is excluded by the
     `depth === previousItem.depth` branch immediately above it returning first;
     `539:16`'s equal-index case is excluded because `overId` reaching this branch at
     all requires it to have survived filtering `without = items.filter(id !==
     activeId)`, which structurally forces `overId !== activeId` and therefore
     `overIdxInItems !== activeIndex`, independent of whether ids are unique. Both
     then re-confirmed empirically (full suite green post-mutation).
   - `block-tree-ops.ts:40:28` — read `serialize()`'s actual body (2 lines, never
     reads `doc.type`) and hand-mutated `'doc'` → `''`; the full `block-tree-ops` +
     `markdown-serialize` suites (703 tests) stayed green.
   - `page-blocks-move.ts:113:7` ConditionalExpression-false — confirmed
     `orderedIds` traces back to `FlatBlock.id: BlockId` (bindings.ts, non-optional)
     through every call site, so `orderedIds.includes(null)`/`.has(null)` really is
     always false at runtime, not just under the type declaration; hand-mutated and
     confirmed green.
   - `page-blocks-move.ts:217:35` — backed by a **committed, re-runnable** sweep
     (`scripts/mutation-harnesses/page-blocks-move-reconcile-batch.harness.ts`), the
     strongest form of evidence available here; read the harness and confirmed its
     control (`232:9`) is asserted `> 0` differing while the claim is asserted `0`.
4. **The "eight inherited claims" (page-blocks-move, "per a pre-existing ledger, all
   green under mutation") were NOT accepted on that basis.** Traced them to
   `page-blocks.move-reparent.test.ts`'s own `#3759 EQUIVALENCE LEDGER` (a different,
   older ledger than the reorder-test one). Result:
   - **5 hold** (`254:9`, `257:9`, `317:20`, `317:37`, `366:7`) — re-checked their
     structural arguments against the current code (all 7 `computeSpliced` call sites
     in `page-blocks-reducers.ts` walked by hand to confirm `touchedIds` are always
     drawn from the returned `blocks` array), but their line citations had drifted
     and were never corrected — fixed in this session.
   - **2 do not hold** (`361:9`/`361:15`, the `reconcileProvisionalMoveSuccess` `!cur`
     guard) — the ledger's own evidence was "never observed to matter across 96
     reconciles", an empirical corpus count, not a proof; `page-blocks-move.ts`'s own
     `#3799 Finding 5` doc comment, written later than the ledger, already retracts
     this exact claim ("a real concurrent-write race, not defensive noise... kept, not
     deleted"). Reclassified as untriaged survivors rather than silently accepted;
     posted as a reviewer comment on #3759 (GitHub) rather than hand-editing the
     bot-managed #3142 ledger.
5. **Vacuous-test check** — for the `logger.warn` spy test, confirmed by hand-mutation
   (item 2 above, `147:7`/`147:61`/`148:*`) that it distinguishes the cycle-guard path
   from the presence-check path for the reason claimed (only the cycle guard logs;
   breaking that exact branch/args reddens the test) and not incidentally.
6. **Line-drift citation check** (`tree-utils.mutants-build.test.ts`, 186/192 →
   193/199) — confirmed against the current file: `193:7` is
   `if (selected.size === 0) return []` and `199:35` is
   `const ancestorStack: string[] = []`, matching the corrected citations exactly.
7. **Full harness run** — `npx vitest run`: 777 files, 17642 tests passed (+1 expected
   fail), exit 0. `npx tsc -b --noEmit`: clean. `npx oxlint` on all four changed files:
   clean.
8. **Real Stryker scores** (`STRYKER_MODULE=<module> node scripts/run-mutation.mjs
   <module>`, measured this session, not repeated from the prior report):
   - `block-tree-ops`: 98.99% (96 killed, 2 timeout, 1 survived — the verified-
     equivalent `40:28`, 0 no-coverage).
   - `tree-utils`: 96.43% (269 killed, 1 timeout, 10 survived — all 10 verified
     equivalent above, 0 no-coverage).
   - `page-blocks-move`: 94.00% (141 killed, 9 survived, 0 no-coverage) — the 9
     survivors are exactly the 7 verified-equivalent claims plus the 2 retracted
     `361:9`/`361:15`, matching the audit's breakdown precisely.
   All three closely match the diff's claimed scores; none regressed.

**Process notes:**

- The strongest-looking evidence in this diff (algebraic identities, canary hit
  counts, a committed re-runnable harness) held up under adversarial re-derivation.
  The weakest-looking framing — "per a pre-existing ledger, re-verified empirically
  (all green under mutation)" for 8 mutants — was where a real defect was hiding, and
  it wasn't in the diff under review at all: it was two mutants' worth of a *different*,
  older, already-superseded ledger in a fourth test file the diff didn't touch. "Green
  under mutation" is the definition of a survivor, not evidence of equivalence, and an
  empirical corpus count dressed as a proof is exactly the failure mode session 1328
  ("A citation that was never there") described — this session found a live instance
  of it rather than a hypothetical one.
- Two hand-mutations of `page-blocks-move.ts` (`114:7` ConditionalExpression forced
  `if (true)`, and a from-scratch run of the same) caused `npx vitest run` on the
  affected files to hang rather than fail fast — the mutation makes `wouldCreateMoveCycle`
  always reject non-null-parent moves, which cascades into unexpected `load()` calls
  that starve manually-controlled mock promises in unrelated tests. Worked around by
  targeting the specific `it` name (`-t "wouldCreateMoveCycle"`) for that class of
  mutation instead of running the whole file; the direct `wouldCreateMoveCycle` unit
  tests added by the diff are exactly what made this fast and safe to isolate.

**Commit plan:** single commit (`28c91be5b`, local to `claude/fe-mutation-tree-ops`),
not pushed.
