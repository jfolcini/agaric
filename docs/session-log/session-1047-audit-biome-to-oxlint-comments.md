# Session 1047 — audit fix #1265: replace stale Biome comment references with oxlint

2026-06-16. From the 2026-06 Opus quality audit (maintainability/docs). `/loop /batch-issues` run.

## Finding
~30 source comments/directive justifications across 24 files cited "Biome" and nonexistent
Biome rule names; the project bans Biome and lints with oxlint. A wrong rule id in a
disable directive is worse than nothing (silently ineffective).

## Fix (comment/prose-only — no code changed; 34 1:1 line swaps)
- Rule-id-in-comment references mapped to the real oxlint rule:
  `noExcessiveCognitiveComplexity` → `eslint/complexity`; `lint/suspicious/useAwait` →
  `typescript/require-await`; `noControlCharactersInRegex` → `eslint/no-control-regex`;
  negated-empty-class → `eslint/no-empty-character-class`; `useExhaustiveDependencies` →
  `react-hooks/exhaustive-deps`; `useThrowOnlyError` → `typescript/only-throw-error`;
  `biome-ignore` → `oxlint-disable`.
- Stale "keeps biome happy" prose → oxlint.
- **No `oxlint-disable` rule id was altered** — every directive already named a correct
  oxlint rule; only the word "biome" in their justification prose was corrected, so none
  can mis-fire.

## Verification
`grep -rni biome src/ src-tauri/src/ scripts/` → no matches. `npx oxlint` exit 0 (no new
violation surfaced from the directive-comment edits; corrected rule ids verified real).
`cargo check` clean (no Rust comments needed changing). The diff is purely comment/prose
lines.
