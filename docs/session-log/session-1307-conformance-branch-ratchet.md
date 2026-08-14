# Session 1307 — conformance ratchet: key on the branch, not the command (2026-08-15)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-15 |
| **Subagents** | 1 build + 1 review |
| **Items closed** | `#3878` |
| **Items modified** | filed `#3892` |
| **Tests added** | +2 (frontend) / +0 (backend) |
| **Files touched** | 2 |

**Summary:** The backend-only conformance ratchet keyed on the command, so an uncovered
*branch* of a covered command read as covered — a guard that could not fail in the case it
existed for. It now keys on `${command}::${branch}`, with the branch derived mechanically
from each fixture step's own `args.request` rather than from a hand-maintained list of
covered arms.

**Files touched (this session):**
- `src/lib/tauri-mock/__tests__/conformance-coverage.test.ts`
- `docs/session-log/session-1303-conformance-branch-ratchet.md` (new)

**Verification:**
- `npx vitest run src/lib/tauri-mock/__tests__` — 24 files, 365 tests, all passed.
- `npx tsc -b` — clean.
- pre-commit hook — all staged-file checks pass.
- pre-push hook — full clippy + push-staged checks pass.

**The falsification pair, which is the actual deliverable:**

The defect is a guard that cannot fail, so "tests pass" proves nothing here. GREEN before:
the unmodified ratchet reported `list_blocks` fully covered with 10/10 passing, despite two
of its five branches having zero query steps in any fixture. RED after, with the new waivers
temporarily removed to prove causality:

```
AssertionError: These READ-ONLY Tauri command BRANCHES have NO conformance query step
and NO allowlist waiver: ["list_blocks::agenda-range","list_blocks::agenda-date"]
```

**Migration, count-preserving with denominators:** 74 read-only commands → 78 required
units (73 untouched commands, each keeping exactly one implicit branch, plus 5 `list_blocks`
branches). `READ_NO_QUERY_ALLOWLIST` is untouched at 54 entries before and after. The new
`READ_QUERY_BRANCH_ALLOWLIST` holds exactly 2, both `list_blocks::agenda-*`, waived with
the issue's own reason: agenda rows come from `agenda_cache`, which needs `set_due_date` /
`set_scheduled_date` ops before a query step, not merely a seed.

**Process notes:**

- **The key is derived, not declared, and that distinction is the whole design.** A
  hand-maintained list of which arms are covered would be a second artifact free to drift
  from the code — the same failure mode one level up. `stepBranchKey()` classifies a step by
  the first present, non-null discriminator in Rust dispatch order, reading data already
  present in every fixture. The one thing that *is* hand-declared — the four discriminator
  field names — is cross-checked by a test that parses `filter_count`'s array literal
  straight out of `queries.rs` and fails loud on drift.

- **That cross-check was itself falsified.** It would have been ironic to ship, inside a fix
  for a guard that cannot fail, a second guard that cannot fail. A bogus sixth entry was
  added to the Rust array literal; the test went RED with a clear diff; the file was
  restored and confirmed byte-identical.

- **The fix's own uniqueness claim was wrong, and the sweep that caught it is the reason
  this is worth reading.** The implementation asserted `list_blocks_inner` was the only
  command with this dispatch shape, citing `grep -rl 'else if let Some'`. That grep actually
  returns three files, not one — and more importantly it is a narrow probe: it cannot see a
  `match` on an enum, a dispatch on a boolean flag, an `Option::map_or` chain, or an
  `if let ... else if ...` split across helpers. A broader sweep found a genuine second
  instance, `filtered_blocks_query_inner`, whose own exclusivity guard covers four `value_*`
  arms of which only `value_text` has a query step. It is still silently fully-covered.
  Filed as `#3892`; the misleading comment was corrected in place rather than left to
  imply exhaustiveness.

  Recording this because the general lesson outlives the instance: **a claim that a defect
  class has exactly one instance deserves at least as much scrutiny as the fix itself.**
  It is the claim that decides whether the work is complete or merely local, and it is
  cheap to state and expensive to check, which is precisely why it tends to go unchecked.

- **Edge cases in the derivation, decided rather than defaulted.** A step with zero
  discriminators falls to the `children` default, mirroring the Rust `else` arm — correct,
  not coverage inflation. A hand-authored fixture setting two discriminators picks the
  higher-precedence one, mirroring the mock's documented permissiveness; such a request
  would fail `filter_count > 1` validation on the real backend, so it cannot silently
  miscredit coverage.

- **Additive by construction.** Any command absent from the manifest returns its own bare
  name as its single branch, so the other 73 read-only commands are byte-identically
  unaffected. This matters because the ratchet is the yardstick the whole #3830 coverage
  programme is measured by — a change that quietly re-baselined it would mis-report that
  entire effort.
