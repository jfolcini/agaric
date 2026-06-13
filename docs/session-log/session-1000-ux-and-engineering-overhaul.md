## Session 1000 — UX audit + engineering review overhaul (2026-06-13)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-13 |
| **Subagents** | ~125 across two multi-agent workflows (UX audit 83, code review 42) + ~20 build/review/fix agents |
| **Items closed** | #977 #823 #986 #987 #739 #838 #988 #991–#1013 (UX) #1015–#1018 #1020–#1031 (eng) |
| **Items modified** | #887 #979 #1019 (A1 deferred) |
| **Tests added** | +130 frontend (hot-path + UX regression + a11y) |
| **Files touched** | ~45 across 18 PRs |

**Summary:** Ran two adversarially-verified multi-agent workflows over the editor/tree/block/menu surfaces — a UX audit (38 raw → 26 confirmed → 23 deduplicated findings) and an engineering review (36 raw → 17 confirmed). Filed all 40 as GitHub issues, then fixed all 23 UX issues and 16/17 engineering issues across file-disjoint subagent-built, adversarially-reviewed PRs. Enabled the React Compiler (#977) after proving the prior "breaks e2e" signal was build-tooling noise. Fixed 3 suite flakes — 2 were real product bugs (cmdk `aria-activedescendant` sync, markdown-serializer non-idempotence).

**Highlights:**
- **React Compiler** enabled (#977/#979): the "breaks editor e2e" history was a flaky timing test + fail-fast cancel, then babel-over-`.ts` parse mangling — both fixed; cost is +18.8% on the index entry chunk.
- **UX fixes** (#1033–#1037): context-menu alignment/focus-ring/icons, gutter token unification, tree drop affordance + spacing, a canonical `<Kbd>` component, radius-by-prominence + design-system polish.
- **Engineering fixes** (#1039–#1043): focus-transition correctness races (silent draft-autosave loss; stale-`await` query write; destroyed-editor cleanup), the O(N) selection re-render cascade, hot-path test gaps, design-system prop-type contracts, and `BlockContextMenu` action-bag segregation.
- **#988** focused-block borders neutralized: the theme's red/rust `--ring`/`--primary`/`--accent` were used for resting decoration, reading as a validation error; switched to neutral tokens (verified with before/after screenshots).

**Deferred:** A1 (#1019) — the `BlockTree` `useEditorEventDispatch()` refactor — left open; its own issue requires the block-switch/keystroke/collapse e2e suite to land first.

**Process notes:**
- Caught and resolved stale-base rebase hazards where engineering worktrees forked before UX PRs merged (eng-ds ↔ #1037 on `button.test.tsx`; eng-arch ↔ perf on `BlockContextMenu.tsx`/`SortableBlock.tsx`).
- Adversarial review earned its cost: rejected a radius "fix" as a regression, caught a perf-assertion flake (50ms→250ms, measured), a missed consumer test, and two issue-prescribed fixes that were wrong for TipTap v3 / React closure semantics.
