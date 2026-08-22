# Session 1375 — 141 citations repointed, and a guard for the door the last PR widened (2026-08-22)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-22 |
| **Subagents** | two builders (disjoint files), one adversarial reviewer |
| **Items closed** | `#4181` (141/142 — see #4240), `#4226` |
| **Items modified** | — |
| **Tests added** | +18 guard self-test assertions |
| **Files touched** | 23 modified, 1 new — see the PR's file list |

**Summary:** two pieces of guard hygiene that both trace back to earlier work in this
series, plus one wrong pointer in a merged session log.

**#4181 — 141 of 142.** #4135 made the guard see bare-filename citations (`engine.rs:1166`)
and grandfathered the existing population so the mechanical change would not be buried
under a content sweep. This is the sweep. Every citation was resolved to a repo-rooted path
and its baseline entry removed in the same change; the guard is shrink-only and a stale
entry fails the build, so the two halves cannot drift.

Baseline arithmetic, independently re-derived in review: **198 → 57**. The `#4135`
population went 142 → **1**; the 53 `#4184` `partial-root` entries and the 3 older `missing`
entries are **byte-identical** sets, untouched. 141 removals, 141 `+`-side path rewrites,
cross-checked per file.

Three filenames were genuinely ambiguous and were disambiguated by reading content rather
than guessing — `queries.rs`, `import.rs`, `mod.rs` all have real siblings, and `mod.rs` has
43 candidates repo-wide. Review re-derived all three independently and confirmed them, and
cross-checked all 36 unique basenames against `git ls-files` for ambiguity the builder had
not flagged. There was none.

**The one left is left deliberately.** `pages.rs:622-637` cannot be resolved: `commands/
pages.rs` was split in #889 and no current file matches the range. It also lives in
`bindings.ts`, a **generated** file, copied verbatim from a Rust doc comment — so the
durable fix is upstream in `CreateBlockSpec`. Filed as **#4240**. A confidently wrong path
is worse than an honestly grandfathered one; that is the whole reason bare names are banned.

**What review found that the sweep could not.** The guard strips `:N` before checking
anything — it verifies the *file exists*, never that the *line is right*. So a mechanical
basename→path fix inherits whatever staleness was already there, and now dresses it in an
authoritative-looking path. Review spot-checked ~50 citations and found:

- **one genuinely wrong file**: `page-blocks.ts:392` was cited for the `pageStore.edit()` /
  `notifyUndo` contract. That file has neither; both live in `page-blocks-reducers.ts:298`,
  a differently-named sibling from a later split. Basename matching structurally cannot
  detect a post-split rename.
- **~9 stale line numbers** pointing at the right file but the wrong section — a comment
  about a shared fixture landing on unrelated Projects-page code, a citation of a Card
  wrapper instead of the per-row element it describes, and so on.

All fixed. Filed as a follow-up to sweep the remaining ~100 for the same class of drift.

One near-miss was investigated and **cleared**: `tauri.ts:1871` is 17× past that file's 106
lines, but the surrounding prose calls it "the *stale* doc anchor" and the test asserts its
**absence**. A deliberate historical negative reference, not a bug.

**#4226 — and why the issue's own recommendation was incomplete.** The lib-layering guard
excludes `src/types/**` on the premise that it is type-only, and nothing enforced that. The
issue recommended folding the directory into the tier scan at rank -1.

That would not have worked. A tier scan detects bad **imports**; the threat is a runtime
**export** — the issue's own example is a const object, which imports nothing at all. Give
it rank -1 and scan for upward imports and such a file reports clean. So the guard asserts
the property directly: every export under `src/types/` must be type-only, no baseline, no
opt-out — baselining a runtime leak here would reopen exactly the hole being closed.

Review ran the bypass shapes rather than reading for them. Caught: `export const enum`,
`export default`, a re-export of a runtime value from elsewhere, `export =`, a type-only
re-export missing the `type` keyword, `export *` and `export * as ns`. Correctly green:
`export type { … } from`. One false positive found — a value inside a `declare module`
block, which `tsc --strict` rejects anyway (TS1254/TS1183) — fails safe, filed.

The `.d.ts` exclusion was verified rather than assumed: `tsc --noEmit --strict` on a
synthetic `.d.ts` carrying an initializer and a function body fails outright, so an ambient
declaration structurally cannot emit runtime code.

**Also:** `session-1369-recovery-move-sweep.md` named PR **#4233** twice — the "Files
touched" row and the commit plan — when it shipped as **#4235**. #4233 is the
reach-divergence *issue*, so a reader auditing what shipped was sent to the wrong artifact
entirely, and that row is a pure pointer with no inline list behind it. Every session log
was grepped for stray pointers; this was the only one.

**Verification:** doc-citation guard and its self-test green with **zero stale entries**;
types-erasure guard and its 18-assertion self-test green, including a CLI subprocess check
that the gate really exits 1; lib-layering unchanged at 13; `tsc -b` clean; full suite
17704 passed, 1 expected fail.
