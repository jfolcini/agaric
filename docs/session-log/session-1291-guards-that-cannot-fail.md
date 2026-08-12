# Session 1291 — acting on the dead-code findings, and being wrong about them four times (2026-08-12)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-12 |
| **Subagents** | 4 build (serial, one at a time) |
| **Items closed** | `#3787` `#3790` `#3797` `#3798` `#3801` `#3802` |
| **Items modified** | — |
| **Tests added** | 1 (frontend) / 0 (backend) |
| **Files touched** | 9 |

Per-file line deltas are omitted deliberately — they drifted three times across the preceding PRs, and `git diff --numstat origin/main...HEAD` is authoritative.

**Summary:** Implemented the six cleanup issues that sessions 1288–1290 filed while triaging mutation survivors — guards no input can trip, and comments describing the opposite of their code. Four modules' dead code removed, four comments corrected. **Every one of the four issues contained a claim of mine that did not survive verification**, which is the session's main result and the reason the work was done one agent at a time with an explicit instruction to attack the issue rather than implement it.

**Files touched (this session):**
- `src/lib/date-utils.ts`, `src/lib/__tests__/date-utils.test.ts`
- `src/lib/agenda-sort.ts`, `src/lib/__tests__/agenda-sort.test.ts`
- `src/lib/inline-property-parse.ts`, `src/lib/__tests__/inline-property-parse.test.ts`
- `src/lib/export-graph.ts`, `src/lib/__tests__/export-graph.test.ts`
- `src/lib/filters/model.ts`, `src/lib/search-query/classify.ts`
- `src-tauri/agaric-engine/src/import.rs`, `src-tauri/src/commands/pages/markdown.rs` (comments only)

**Outcome per module:**

| Module | Change | Mutation |
|---|---|---|
| date-utils | 3 guards removed, 2 kept + annotated | 89.30% → **94.54%**, survivors 22 → 10 |
| agenda-sort | 2 branches removed, 3 kept + annotated | survivors 31 → 28, NoCoverage 2 → 1 |
| inline-property-parse | 1 guard removed | survivors 4 → **2** (98.56%) |
| export-graph | dead `.filter()` + ternary removed | unresolved 17 → **11** |
| filters-model | comment only | **156/156**, unchanged |

No module gained a new survivor location — in each case the mutants that disappeared were exactly the deleted code's.

**Verification:**
- `npx vitest run` per module after every change; full affected set green.
- `npx tsc -p tsconfig.app.json --noEmit` after every removal — see the process note, this is not the obvious command.
- `node scripts/run-mutation.mjs <module>` once per module, before and after.
- pre-commit hooks pass on all four commits.

**Follow-up issues filed:** #3805 (`tsc --noEmit` is vacuous here), #3806 (a block genuinely due `9999-12-31` is shown as undated), #3807 (the reserved-key list is duplicated four times across TS, Rust and two SQL literals with no gate).

**Process notes:**

**Four issues, four wrong claims, all in the same direction — over-confidence that code was dead.** Recording them individually because the shapes differ and each is a distinct trap:

1. **#3787 — a value-side refutation.** A `?? 'Jan'` fallback looked dead behind an integer range check. It is live via a **fractional** month: `"2026-1.5-05"` passes `m < 1 || m > 12`, then indexes `MONTH_SHORT[0.5]`. The same issue also called two round-trip arms "perfectly correlated"; they are not — under `Pacific/Apia`, `2011-12-30` is a day that never existed, so only `getDate()` rejects it, while `1000-00-01` is caught only by `getMonth()`. A prior attempt blamed Kiritimati, which was also wrong: that zone resolves forward and both arms disagree together.
2. **#3790 — a type-side refutation.** A `?? ''` fallback is unreachable at runtime but **required by the type-checker**: `noUncheckedIndexedAccess` types a tuple indexed by a *variable* as `T | undefined`, so removing it gives TS2322. Unreachable and removable are different properties.
3. **#3797 — a counting error.** The reserved-key list has **four** copies, not three; the missed one is a second literal SQL `NOT IN (…)` in the same function, invisible to a grep for either constant name.
4. **#3798 — the same counting error in a different costume.** `sanitizeSegment` has three `return` statements but **four exit values**, because one delegates to a function that returns from two places. The conclusion survived; the framing did not.

The generalisation worth keeping: **an analysis written while looking at a mutation report is optimised for explaining survivors, not for being true.** It reaches for "this is unreachable" because that explains why the mutant lived, and that explanation is right about the mutant while being wrong about the code. Every one of these was caught by an agent told explicitly to refute rather than implement.

**A verification command that verified nothing.** `npx tsc --noEmit` — which I had been putting in agent prompts all session — **type-checks nothing in this repo and always exits 0**. The root `tsconfig.json` is `{"files": [], "references": [...]}`, and `--noEmit` does not follow project references, so it succeeds on an empty program. It waved through a genuinely broken removal during #3787; the real arbiter is `tsc -p tsconfig.app.json --noEmit`, which produced TS18048 five times on the same code. Filed as #3805. Worth noting the pre-commit hook does run a real check, so this never risked `main` — the cost is false green during local iteration, with the failure arriving detached from its cause.

**Two decisions to *not* do the obvious thing.** #3802 proposed exporting `GRAPH_HAS_DATE_SENTINEL` so tests stop hardcoding its literal. Declined: `model.mutants.test.ts` kills the `StringLiteral` mutant *precisely because* the test hardcodes it. Import the constant and code and test mutate together, the mutant becomes equivalent, and `filters-model` falls off 100%. The duplication is load-bearing, and an unused export would invite exactly the cleanup that breaks it. Similarly, export-graph's Zip-Slip guard is subsumed for every input but was kept as explicit security intent and annotated against future "simplification".

**A bug found by cleaning up, not by testing.** While confirming #3790's sentinel finding, `effectiveDate` turned out to use `'9999-12-31'` as its no-date sentinel while `groupByDate` tests for that literal — so a block genuinely due on that date is displayed as undated and sorted with the undated ones. Unlike the `'0000-00-00'` / `'9999-99-99'` sentinels the issue flagged (not valid dates, so they can only tie), this one is a date a user or import can actually produce. Filed as #3806.
