## Session 908 — CI-R16: SKIP_CI_VERIFY reason-string guard (2026-05-30)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-30 |
| **Subagents** | orchestrator-only build + 1 review |
| **Items closed** | #149 |
| **Items modified** | — |
| **Tests added** | +1 shell smoke test (20 cases) |
| **Files touched** | 4 |

**Summary:** Implemented the maintainer-approved "cheap guard" for the `SKIP_CI_VERIFY` pre-push escape hatch (#149 / CI-R16). The pre-push verifier now rejects a bare truthy flag (`SKIP_CI_VERIFY=1` and the `0/y/n/on/off/yes/no/true/false` set, case-insensitive, whitespace-trimmed) and requires an explicit, self-documenting reason string of ≥8 characters, which it echoes into the push output. This keeps the emergency hatch from quietly becoming the default push path while staying low-friction.

**Files touched (this session):**
- `scripts/verify-ci-equivalent.sh` (+~22 / guard block, header doc, 3 bypass-hint echoes)
- `scripts/push.sh` (+~8 / 3 internal bypass call sites now pass a descriptive reason constant — push.sh runs the verifier itself, then legitimately skips the hook)
- `scripts/test-skip-ci-verify-guard.sh` (new / 20-case reject-and-accept smoke test of the guard's early-exit branches)
- `prek.toml` (doc-comment update + new `skip-ci-verify-guard` pre-commit hook scoped to the guard scripts)

**Verification:**
- `bash scripts/test-skip-ci-verify-guard.sh` — 20/20 cases pass (truthy tokens, whitespace-padded truthy, too-short reasons rejected; ≥8-char reasons accepted incl. the exact-8 lower bound).
- `shellcheck` on all three scripts — clean.
- pre-commit hook — all staged-file checks pass.
- pre-push hook — full clippy + push-staged checks pass.

**Process notes:**
- Reviewer (separate subagent) flagged one real nit: a whitespace-padded truthy value (`"1      "`) slipped past both checks. Closed it with a pure-bash leading/trailing trim (internal spaces preserved) before evaluation, and pinned it with two new test cases plus an exact-8-char accept boundary.
- The guard's accept path `exit 0`s before the verifier body runs, so the test exercises reject/accept cheaply without ever launching the multi-minute verifier. The unset/normal-push fall-through path is intentionally not unit-tested (it would run the real verifier); confirmed by inspection that `${SKIP_CI_VERIFY:-}` empty falls through.

**Commit plan:** single commit / pushed.
