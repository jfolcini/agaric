## Session 827 — PEND-69 hygiene: useExhaustiveDependencies audit (high-risk tranche) (2026-05-24)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-24 |
| **Subagents** | orchestrator-only (read-only correctness audit) |
| **Items closed** | PEND-69 `useExhaustiveDependencies` (high-risk tranche deep-verified) |
| **Items modified** | PEND-69 (row + action order) |
| **Tests added** | 0 |
| **Files touched** | 0 src (no bugs found) + 2 plan/log |

**Summary:** Audited the `useExhaustiveDependencies` suppressions (56 prod, the
plan's "highest latent-bug value" category). Deep-verified the highest-risk
members — every site where a value is **read in the effect body but omitted from
the deps**, which is where a stale-closure bug would actually live:
- `PageBrowser.tsx:631` (filter-announce): reads `filters`/`t` but deps on
  `wireFiltersKey`. Correct — `wireFiltersKey` faithfully tracks the chip set, so
  the effect re-runs with the current render's `filters`/`t` on every real change;
  a language-only `t` change has nothing to announce.
- `BlockHistoryItem.tsx:125` (compared-diff): reads `comparedDiff/Loading/Failed`
  as guards but omits them. Correct — they're SET by the effect; including them
  causes a self-cancelling fetch loop (documented, incl. the test-vs-prod timing
  subtlety).
- The `resolveVersion` ref-cache identity-bump pattern (`useBacklinkResolution`
  ×3 et al.): the callbacks read a `useRef` cache (not a dep) plus `currentSpaceId`
  (which IS listed); `resolveVersion` is an intentional identity-bump so memoized
  callbacks pick up cache updates.
- The `stableKey`/digest array-substitute hooks (`useBatchProperties`,
  `useBlockPropertiesBatch`): a membership digest correctly substitutes for the
  array identity (covariant with the read array).

All correct — **no stale-closure bugs, no code changes.** The remaining ~49 are
documented variants of vetted patterns: trigger-key "re-run on X; body doesn't
read X" (safe by construction), ref/stable-handle reads, effect-set guard state,
mount-only hydration. Recorded the audit + taxonomy in PEND-69.

**REVIEW-LATER impact:**
- **PEND-69:** `useExhaustiveDependencies` row marked audited (risky surface clean);
  action-order item 1 addressed. A full line-by-line pass of the remaining ~49 is
  available but low-ROI (all lower-risk than the verified set).
- **Previously resolved:** 1340+ → 1341+ across 826 → 827 sessions.

**Files touched (this session):**
- `pending/PEND-69-tooling-hygiene-suppression-debt.md`, `SESSION-LOG.md` (docs only)

**Verification:**
- Read-only audit; no source edits, so the tsc/biome/test baseline is unchanged.
  `prek run` on the staged docs passes.

**Lessons learned:** Like the cast + unsafe audits, this category was already
well-managed — every suppression carries a specific inline reason and follows an
idiomatic pattern. For mature suppression surfaces, deep-verify the genuinely
risky members (here: "read in body but omitted") and taxonomize the rest, rather
than exhaustively re-reading documented idiomatic effects for a near-zero bug yield.

**Commit plan:** single doc-only commit. Not pushed.
