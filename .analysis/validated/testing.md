# Testing dimension — VALIDATION

**Verdict tally:** CONFIRMED 3 · CONFIRMED-BUT-RESEVERITY 1 · EXAGGERATED 2 · HALLUCINATED 0

The most consequential finding (the `#[ignore]`d I-Search-5 test) is **real but mis-framed**:
it is NOT a dual-path runtime inconsistency (the CTE path is test-only). It IS a genuine
off-by-one in the *production* materialized inheritance depth bound. Reseverity downward and
reframe. Details below.

---

### [MEDIUM→reframe] `#[ignore]`d test masks a real depth-boundary off-by-one (I-Search-5)
- **Verdict**: CONFIRMED-BUT-RESEVERITY (down to LOW; reframe required)
- **Evidence checked**:
  - `tag_query/resolve/tests.rs:1468-1546` — read the full ignored test + `#[ignore]` reason.
  - `tag_inheritance_macros.rs:225-241` (`tag_inh_descendant_tags_full!`): seed is
    `JOIN blocks b ON b.parent_id = bt.block_id ... 0 AS depth` → depth 0 = **child** of the
    tagged block. Recursion bound `dt.depth < 100`.
  - `tag_query/resolve.rs:438-459` (`resolve_expr_cte`): seed is
    `SELECT bt.block_id AS id, 0 AS depth` → depth 0 = **the tagged block itself**. Bound
    `tt.depth < 100`.
  - `MAX_TAG_INHERITANCE_DEPTH = 100` at `tag_inheritance_macros.rs:73`.
- **The math is real**: both walk 100 recursive steps, but the macro's counter starts one
  tree-level lower, so the materialized cache attributes a tag to descendants up to **101**
  levels below the tag-bearer; the oracle stops at 100. On a 105-deep chain: materialized =
  B000 + B001..=B101 (102), oracle = B000..=B100 (101). Verified by tracing both bounds.
- **WHY THE RAW FINDING IS MIS-FRAMED (key correction)**: `resolve_expr_cte` is **test-only** —
  grep shows it is called *exclusively* from `tests.rs` (resolve.rs:429 is the only def; all
  21 call sites are in tests.rs). Production `resolve_expr` / `resolve_tag_leaves`
  (resolve.rs:30-72) reads `block_tag_inherited` ONLY. There is **no "CTE fallback" in
  production**, so the report's stated impact ("a tag query can return a different result set
  depending on whether it goes through the materialised cache vs. the CTE fallback") does NOT
  occur. Production is internally consistent — it always uses the materialized path.
- **The actual (smaller) bug**: the materialized inheritance bound is off-by-one relative to
  the nominal 100-level intent measured from the tag-bearer. A tag propagates one level deeper
  than `MAX_TAG_INHERITANCE_DEPTH` nominally implies. This only manifests on parent chains
  **≥101 blocks deep** under a single tag — an extreme edge in a notes app. No data corruption,
  no nondeterminism, no hash-chain impact; deterministic and bounded.
- **Corrected severity**: LOW (was MEDIUM). It is a real but cosmetic/edge depth-semantics
  off-by-one, not a live dual-path correctness divergence.
- **BETTER-APPROACH**: File as a tracked correctness-debt issue (the test already documents
  the exact fix in resolve.rs/macros). But do NOT bill it as "tag queries return different
  results in production." The line citation `resolve.rs:249-261` in the test doc is also
  **stale** — the real oracle seed is at resolve.rs:438-459 (249-261 is unrelated
  `compile_candidate_subquery` doc text). Note the cite drift when filing.
- **Note**: the test author was honest — the `#[ignore]` reason correctly says "production fix
  required." This is documented coverage debt, not a hidden landmine.

### [MEDIUM] Recurrence date-math has zero property/fuzz coverage
- **Verdict**: CONFIRMED
- **Evidence checked**: `ls src-tauri/src/recurrence/` (compute.rs, mod.rs, parser.rs,
  projection.rs, tests.rs); grep for `proptest|prop_assert|quickcheck|prop_compose` over
  `recurrence/**` → **NONE**; `ls src-tauri/proptest-regressions/` → block_descendants, dag,
  loro, mcp, soft_delete — **no recurrence dir**. Confirms recurrence is example-tested only
  while the other invariant-rich areas all have proptests + regression corpora.
- **Assessment**: Genuinely valuable. Date math (leap years, sticky month-end clamp,
  div/rem_euclid month wrap, i64 overflow guards) is exactly the class where hand-picked
  examples miss edges, and the module has explicit stated invariants. Severity MEDIUM is fair.
- File-worthy. Fix proposal (monotonicity + clamp + guard-rail proptests) is sound.

### [MEDIUM→LOW] formatRelativeTime asserts against a second live-clock read
- **Verdict**: EXAGGERATED (real mechanism, but one of the two cited lines is robust;
  reseverity to LOW)
- **Evidence checked**: `format-relative-time.ts:18` reads its own `Date.now()`;
  test `format-relative-time.test.ts:104-105` and `112-113` read a *separate* `Date.now()`
  for the expected value. Dual-read mechanism is real.
- **Correction**: Line 104 is effectively robust, not flaky. The timestamp is *exactly* 5 min
  ago (`5 * 60_000` = 300000ms exactly). The formatter's later `Date.now()` only makes diff
  ≥ 300000, which still floors to `minutesAgo:5` until a full extra minute elapses. The report's
  claim that it could floor to 4 is **backwards** — the delta pushes the count up, not down,
  and never reaches 6 within a realistic test window. So line 104 does not flake.
- **The genuine one is line 113** (epoch 0 → day count): expected uses one `Date.now()`,
  formatter uses a later one; if a UTC-midnight boundary falls between the two reads (a ~few-ms
  window once per day) the day count diverges. Real, but vanishingly rare.
- **Corrected severity**: LOW. A one-line hygiene fix (`vi.setSystemTime`) is correct and cheap.
- File-worthy only as a minor test-hygiene cleanup; fix is right.

### [LOW] Two e2e date-picker chip tests skipped (#1170)
- **Verdict**: CONFIRMED
- **Evidence checked**: `e2e/toolbar-controls.spec.ts:373,382` — `test.skip(...)` with an
  honest comment (lines 368-372) explaining the chip-click path doesn't survive blur in pure
  e2e; toolbar "Set due date" covers the same picker via a portal trigger; tracked as #1170.
- **Assessment**: Accurate. The gap is real (chip→picker onClick has no automated coverage),
  honestly tracked. The proposed component-level RTL test is the right mitigation. LOW is fair.
- Minor but file-worthy (or just leave to #1170).

### [LOW] Real-timer wait in async-scheduler test
- **Verdict**: CONFIRMED
- **Evidence checked**: `src/lib/in-page-find/__tests__/matcher.test.ts:320-323` —
  `handle.cancel()` then `await new Promise(r => setTimeout(r, 20))` then
  `expect(completed).toBe(false)`. Exactly as described: a negative assertion after a fixed
  real-clock sleep, which silently weakens (not flakes) under CI load.
- **Assessment**: Correct and correctly rated LOW. Fake-timers/idle-callback stub is the right
  fix. Genuinely a weakened assertion, but very low impact.

### [LOW] Pervasive bare toHaveBeenCalled()
- **Verdict**: CONFIRMED (count) but EXAGGERATED as a problem
- **Evidence checked**: `grep -c "toHaveBeenCalled()"` over `src/**/*.test.ts(x)` = **1250**
  (matches). But `toHaveBeenCalledWith` = **2551** — the suite already favors arg-checking
  2:1; bare uses are the minority and (as the report concedes) many are legitimate presence
  checks for refetch triggers.
- **Assessment**: The report is honestly self-deprecating here (Confidence: low). Without
  enumerating which bare uses are on the IPC/contract surface, this is a sampling signal, not
  an actionable finding. Not worth filing as-is — would need the targeted enumeration first.
- **TRIVIAL / drop** unless the synthesizer wants a scoped "audit invoke-mock assertions" task.

---

## Net assessment — file-worthiness, ranked

1. **Recurrence proptest gap [MEDIUM]** — the strongest finding. Real, verified by grep, clear
   value given date-math edge density and the precedent that every other invariant area has
   proptests. **File it.**
2. **I-Search-5 depth off-by-one [LOW, reframed]** — real production off-by-one in the
   materialized inheritance bound, but NOT the dual-path runtime divergence the raw report
   claims (CTE path is test-only). Extreme edge (≥101-deep chains). File as low-priority
   correctness debt, with the corrected framing and the stale `resolve.rs:249-261` cite noted.
3. **formatRelativeTime dual-clock [LOW]** — only line 113 genuinely flakes; line 104 is
   robust (report's flake direction is wrong). Minor hygiene cleanup, cheap. Optional.
4. **e2e chip-click skips [LOW]** — already tracked as #1170; file only if you want the RTL
   stopgap. Optional.
5. **matcher.test real-timer [LOW]** — valid weakened-assertion cleanup. Optional.
6. **bare toHaveBeenCalled [drop]** — count is real but not actionable without enumeration;
   the suite already favors `toHaveBeenCalledWith` 2:1. Drop unless scoped.

No hallucinations. Two severity downgrades (I-Search-5 framing, formatRelativeTime).
