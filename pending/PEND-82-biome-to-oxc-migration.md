# PEND-82 — Migrate from Biome to the OXC toolchain (oxlint + oxfmt)

Replace the single-binary Biome (linter + formatter) with VoidZero's OXC
toolchain: **oxlint** (the linter, v1.0 stable since Aug 2025) for linting and
**oxfmt** (the formatter, Beta since Feb 2026) for formatting. Both are
Rust-based, ESLint-/Prettier-compatible by design, and substantially faster
than Biome — but adopting them introduces non-trivial config translation,
suppression-comment churn, and three concrete rule-coverage regressions that
need a decision before the switch.

> **Latent / not-urgent.** Biome is currently squeaky-clean on this repo (see
> PEND-69) and runs in well under a second; the perf upside is real but not a
> bottleneck the maintainer is feeling today. The reason to do this is
> ecosystem trajectory (Vite+/VoidZero alignment, type-aware linting on the
> oxlint roadmap), not pain relief.

## Why now (and why "now" is a soft answer)

- **oxlint 1.0 is stable** (Aug 2025); 801 rules in the catalog across
  ESLint / typescript-eslint / unicorn / react / jest / vitest / import plugins;
  112 enabled by default; 50–100× faster than ESLint, ~2× faster than Biome
  for lint.
- **oxfmt is Beta** (Feb 2026): 100% Prettier-v3.8 conformance, ~30× faster
  than Prettier, ~3× faster than Biome; formats JS/TS/JSON(C)/YAML/TOML/
  CSS/SCSS/Less/Markdown/MDX/HTML/Vue/Angular/GraphQL; built-in Tailwind class
  sorting and import sorting; ships a `--migrate prettier` helper. **No 1.0
  date published.**
- **Type-aware linting** (typescript-eslint parity) is on oxlint's roadmap —
  alpha shipped Mar 2026, currently 59/61 typescript-eslint rules covered.
  Biome's type-aware story is weaker.
- **Migration helpers:** `@oxlint/migrate` translates ESLint flat configs;
  `oxfmt --migrate prettier` translates Prettier configs. **No Biome migrator
  exists** — config and suppression rewrites are manual.

## Current Biome surface in agaric

Baseline (2026-05-27) — what the migration has to land replacements for:

| Surface | Where | Notes |
|---|---|---|
| `biome.json` | repo root, 105 lines | linter (13 customized rules) + formatter (single quote, no semis, 100 col, 2-space indent) + 3 path-glob `overrides` blocks |
| `biome-check` hook | `prek.toml:70-80` | runs `npx biome check` per staged file, JS/TS/JSON, with bindings + .sqlx excluded |
| `lint` / `lint:fix` / `format` / `format:check` scripts | `package.json:12-15` | all call `biome` |
| `@biomejs/biome` dep | `package.json:100` | pinned `2.4.15` |
| Dependabot group | `.github/dependabot.yml:107-108` | bundles `biome` + `@biomejs/*` with TS/Vite/tslib |
| `biome-ignore` comments | `src/` + `e2e/` | **396 total** — see distribution below |
| Doc references | `docs/architecture/tooling.md:38`, `ci-and-tooling.md:16`, `frontend.md:133`, `docs/BUILD.md:125`, `pending/PEND-69-*.md` (×many) | narrative + tables |

### `biome-ignore` distribution (production + test)

```text
164  suspicious/noExplicitAny           (mostly tests per PEND-69)
122  a11y/*                              (semantic-roles, focus, etc.)
 56  correctness/useExhaustiveDependencies
 19  style/noNonNullAssertion            (mostly tests; 2 prod audited justified)
 14  complexity/noExcessiveCognitiveComplexity   (13 prod — PEND-69's main remaining debt)
  3  suspicious/noArrayIndexKey
  2  suspicious/noDocumentCookie
  2  suspicious/noConsole
  2  security/noDangerouslySetInnerHtml  (audited justified per PEND-69)
  1  suspicious/noThenProperty
  1  suspicious/noControlCharactersInRegex
  1  suspicious/noAssignInExpressions
  1  style/useThrowOnlyError
```

All 396 directives are `biome-ignore lint/<rule>` — oxlint does **not** parse
that syntax. It respects `// oxlint-disable[-next-line] <rule>` and
`// eslint-disable[-next-line] <rule>` (via `respectEslintDisableDirectives:
true` by default), so a mechanical sed rewrite is feasible but per-rule
because the rule names change (see § Rule mapping below).

## Rule mapping — Biome → oxlint

Mostly 1:1, but **three holes** with no oxlint equivalent. These are the
decisions that gate the migration.

| Biome rule | oxlint equivalent | Risk |
|---|---|---|
| `complexity/noExcessiveCognitiveComplexity` (warn, max 25) | `eslint/complexity` (cyclomatic, not Sonar cognitive) | **Metric drift.** Cyclomatic ≠ cognitive. The 13 prod suppressions and the "deferred refactor" in PEND-69 are calibrated against cognitive=25; cyclomatic at any threshold will surface a different set of functions. Either re-baseline the suppression list or accept the rule loss. |
| `correctness/noUnusedImports` (error) | `typescript/no-unused-vars` covers it | ✅ clean |
| `correctness/noUnusedVariables` (error) | `eslint/no-unused-vars` / `typescript/no-unused-vars` | ✅ clean |
| `correctness/noUndeclaredDependencies` (error) | **no direct equivalent** (no `import/no-extraneous-dependencies` in oxlint catalog) | **Hole.** Either drop the guard (we have `knip` for unused deps but nothing for undeclared) or keep a tiny `biome` sidecar that runs this single rule. |
| `correctness/noUnusedFunctionParameters` (error) | covered by `no-unused-vars` (args option) | ✅ clean |
| `suspicious/useAwait` (error) | `typescript/require-await` | ✅ clean |
| `suspicious/noEvolvingTypes` (error) | **not in oxlint catalog** | **Hole.** Biome-specific TS evolving-type guard. Accept the loss (no replacement) or skip migration. |
| `suspicious/noConsole` (warn, allow warn/error) | `eslint/no-console` (allow option) | ✅ clean |
| `suspicious/noMisplacedAssertion` (error) | `vitest/no-conditional-tests` / `vitest/no-standalone-expect` family | ⚠️ Verify the closest oxlint rule covers the same misuse pattern before relying on it. |
| `style/noNonNullAssertion` (error) | `typescript/no-non-null-assertion` | ✅ clean |
| `style/useConst` (error) | `eslint/prefer-const` | ✅ clean |
| `style/useExplicitLengthCheck` (error) | `unicorn/explicit-length-check` | ✅ clean |
| `style/noDefaultExport` (error) | `import/no-default-export` | ✅ clean |
| `style/useThrowOnlyError` (error) | `typescript/only-throw-error` | ✅ clean |
| `complexity/useLiteralKeys` (off) | `eslint/dot-notation` (leave off) | ✅ clean |
| `assist/source/organizeImports` | `oxfmt` import sorting (built-in) | ✅ clean — moves from linter to formatter |

**Net rule loss:** `noEvolvingTypes` (no replacement), `noUndeclaredDependencies`
(no replacement), and a behavioural shift on cognitive→cyclomatic complexity.
Everything else maps.

## Formatter parity — Biome → oxfmt

Biome formatter options in use → oxfmt support:

| Biome option | Value | oxfmt? |
|---|---|---|
| `indentStyle` | `space` | ✅ supported |
| `indentWidth` | `2` (`tabWidth`) | ✅ supported |
| `lineWidth` | `100` (`printWidth`) | ✅ supported (default also 100) |
| `javascript.formatter.quoteStyle` | `single` (`singleQuote: true`) | ✅ supported |
| `javascript.formatter.semicolons` | `asNeeded` (`semi: false` + ASI fixups) | ⚠️ **Verify.** Prettier exposes `semi: true\|false`; oxfmt advertises `semi` but the "as needed" / ASI-safe variant isn't documented as a distinct value. May need to choose between always-on or always-off, or accept that oxfmt + the codebase agree on the same ASI-driven outcomes Biome produced. |
| `files.includes` (`!dist`, `!src-tauri/target`, …) | ignore list | ✅ supported via `ignore` patterns |
| `overrides[].includes` for `noDefaultExport` off in `src/main.tsx` + `*.config.ts` | per-glob disables | ✅ supported via `.oxlintrc.json` `overrides[]` (same shape) |

**The `semicolons: asNeeded` mapping is the headline formatter risk** —
discover it on Day 1 of the prototype (run `oxfmt` on a sample of files, diff
against current state) and decide before fanning out across the whole tree.

## Phased plan

### Phase 0 — Prototype on a worktree (½ day, kill-criterion gate)

Goal: prove the three holes (cognitive complexity, `noEvolvingTypes`,
`noUndeclaredDependencies`) and the `semicolons: asNeeded` formatter mapping
are tolerable, **before** committing to a multi-day migration.

1. Branch off `main`. Install `oxlint` + `oxfmt` (`npm i -D oxlint oxfmt` or
   the suggested alternative install path from oxc.rs docs).
2. Generate a baseline `.oxlintrc.json` (start from
   `npx @oxlint/migrate` if a Biome→oxlint helper exists by then, else hand-
   port from `biome.json`).
3. Run `npx oxlint .` against the tree. Compare with current Biome output:
   - Which functions does the new complexity rule flag vs Biome's 14
     suppressions? Decide: re-baseline, accept a different set of refactors,
     or skip the rule.
   - Confirm `noEvolvingTypes` and `noUndeclaredDependencies` are silently
     missing (expected). Decide: accept the loss, add knip rules, or keep
     Biome as a sidecar for these.
4. Run `npx oxfmt --write src/` on a copy of `src/`. `git diff`. **Kill
   criterion:** if the diff has more than a handful of stylistic noise lines
   beyond what `semicolons: asNeeded` accounts for, abort and revisit when
   oxfmt 1.0 ships.
5. Write findings + the three decisions (D1-D3 below) at the top of this
   file. **Gate:** maintainer signs off before Phase 1.

### Phase 1 — Config + scripts + hook swap (1 day)

Assumes Phase 0 green-lighted.

1. **`.oxlintrc.json`** — full hand-port of `biome.json`'s 13 customized rules
   plus 3 override blocks. Includes a top-level `ignorePatterns` mirroring
   Biome's `files.includes` exclusions (`dist`, `src-tauri/target`,
   `src-tauri/gen`, `.sqlx`, `src/lib/bindings.ts`, `coverage`, `*.css`,
   `public/pdf.worker.min.mjs`).
2. **`.oxfmtrc` / oxfmt config** — single quote, no semis (or whatever Phase 0
   landed on), 100 col, 2-space indent. Add the same ignore list. Move
   `organizeImports` from linter to oxfmt's import sorting.
3. **`package.json` scripts** — replace `biome check` / `biome format` calls:
   - `lint` → `oxlint .`
   - `lint:fix` → `oxlint --fix .`
   - `format` → `oxfmt --write .`
   - `format:check` → `oxfmt --check .`
4. **`prek.toml`** — rewrite the `biome-check` hook (lines 70-80) as a
   `oxlint-check` hook + a sibling `oxfmt-check` hook. Same `types_or` /
   `exclude` filters. Per-file (`pass_filenames = true`).
5. **`package.json` deps** — `npm rm @biomejs/biome`; `npm i -D oxlint oxfmt`.
6. **`.github/dependabot.yml`** — replace the `biome` + `@biomejs/*` entries
   in the `lint-and-build` group (lines 107-108) with `oxlint` + `oxfmt`.
   Update the inline comment on lines 60-61.

### Phase 2 — Mechanical suppression rewrite (½–1 day)

Rewrite all 396 `biome-ignore` directives. Per-rule sed is feasible because
oxlint accepts `eslint-disable`-shape directives with the new rule names
(e.g. `// biome-ignore lint/suspicious/noExplicitAny: foo` →
`// oxlint-disable-next-line @typescript-eslint/no-explicit-any -- foo`).

Approach:

1. Generate the rename table from the **Rule mapping** above as a sed/`node`
   script (one entry per top-13 rule).
2. Rewrite in a single commit so git history shows the mechanical change
   isolated from any behaviour-changing config edits.
3. Re-run `oxlint .` — expect 0 warnings (the suppressions are pre-validated
   by PEND-69's Session 823-827 audit).
4. For the 14 `noExcessiveCognitiveComplexity` cases: convert to oxlint's
   replacement rule (if any) **only if Phase 0 D3 said "use cyclomatic at
   re-baselined threshold"**; otherwise drop the directives entirely.

### Phase 3 — Doc sweep + cleanup (¼ day)

1. **`docs/architecture/tooling.md`** — replace `biome` references on line 38
   with oxlint/oxfmt.
2. **`docs/architecture/ci-and-tooling.md`** — same on line 16.
3. **`docs/architecture/frontend.md:133`** — the "god component biome-ignore"
   pattern reference; update to the new directive form.
4. **`docs/BUILD.md:125`** — the pre-commit hook list.
5. **`pending/PEND-69`** — note the migration; the cognitive-complexity row
   either disappears (rule gone) or gets a re-baselined count.
6. **`AGENTS.md`** / `src/__tests__/AGENTS.md` — grep for `biome` mentions and
   update.
7. Delete `biome.json` in the same commit that lands `.oxlintrc.json` +
   `.oxfmtrc`.

### Phase 4 — Verification (½ day, parallel with Phase 3)

1. `npx oxlint .` — must be 0 warnings.
2. `npx oxfmt --check .` — must be 0 violations.
3. `prek run --all-files` — must pass.
4. `scripts/verify-ci-equivalent.sh` — must pass (full CI mirror).
5. Open a PR; let `_validate.yml` confirm CI is happy with the new hooks.

## Open decisions (Phase 0 gates)

- **D1 — oxfmt Beta or wait for 1.0?** Beta is at 100% Prettier conformance
  and shipping in production at VoidZero / Vite+ users. No published 1.0 ETA.
  Recommendation: **adopt Beta** unless the Phase-0 prototype surfaces a
  semis/quoting drift the maintainer can't stomach. Revisit cost if 1.0 ships
  during execution (config may shift).
- **D2 — Atomic swap, or run oxlint side-by-side with Biome for a sprint?**
  Atomic is cheaper (no double-maintenance) and the toolchain is clean
  (PEND-69), so the risk of "we missed a rule" is low. Side-by-side is the
  conservative path if the maintainer wants a safety net. Recommendation:
  **atomic**, because PEND-69's audit already cleared the suppression debt
  and the rule-mapping table above is exhaustive.
- **D3 — How to handle the three rule-coverage holes?**
  - `noExcessiveCognitiveComplexity`: (a) drop it and close out PEND-69's
    "main remaining debt" by removing the metric rather than fixing it,
    (b) replace with cyclomatic and re-baseline the suppression list,
    (c) keep a one-rule biome sidecar.
  - `noEvolvingTypes`: probably (a) drop — it's a low-frequency rule and the
    repo currently has zero violations.
  - `noUndeclaredDependencies`: (a) drop and rely on `knip` + CI's package
    install to surface phantom deps, (b) keep a one-rule biome sidecar.

  Recommendation: drop all three (option a) — the codebase is currently
  clean against them and the cost of maintaining a biome sidecar for two
  rules exceeds the risk of regression on rules nobody has been violating.
- **D4 — Suppression rewrite mechanism.** A `node scripts/migrate-biome-
  ignores.mjs` (with the rename table baked in) is more auditable than a
  sed one-liner and easier to dry-run. Use a script, land its output in one
  commit, delete the script after the migration commits.

## Cost / impact / risk

- **Cost:** S-M, ~2-3 days of focused work end-to-end (Phase 0 ½d, Phase 1
  1d, Phase 2 ½-1d, Phase 3 ¼d, Phase 4 ½d). The hand-port of the config and
  the suppression-comment rewrite dominate.
- **Impact:**
  - Performance: lint ~2× faster, format ~3× faster. **Not material on this
    repo's size** — both already finish well under a second.
  - Ecosystem: aligns with Vite+ / VoidZero direction; opens the door to
    type-aware linting (oxlint roadmap) without re-tooling later.
  - Surface area: 1 fewer config file (`.oxlintrc.json` + `.oxfmtrc` replace
    `biome.json`'s combined config — slightly more files, but each is
    smaller).
- **Risk:**
  - **D3 rule holes** — accepting the loss of 3 rules is the headline
    behaviour change. Pre-PR review of any code touched in the same window
    can mitigate.
  - **`semicolons: asNeeded` mapping** — formatter divergence would touch
    every JS/TS file. Phase-0 prototype catches this on Day 1.
  - **Tooling churn** — oxfmt is Beta; config may shift before 1.0. Risk is
    bounded (config is small) but real.
  - **Doc/links** — PEND-69's narrative references `biome` heavily; needs
    careful sweep to avoid stale references.

## How to re-audit current Biome surface

```bash
# Suppression inventory (the migration target)
grep -rhoE "biome-ignore lint/[a-zA-Z/]+" src e2e --include='*.ts' --include='*.tsx' \
  | sort | uniq -c | sort -rn

# All references in tooling/docs that need rewriting
grep -rn -i "biome" --include='*.yml' --include='*.json' --include='*.md' \
  --include='*.toml' --include='*.sh' . \
  | grep -v node_modules | grep -v .claude/worktrees

# Baseline Biome run (must be 0 warnings before migration)
./node_modules/.bin/biome check .
```

## Sources (2026 snapshot)

- [Announcing Oxlint 1.0 — VoidZero](https://voidzero.dev/posts/announcing-oxlint-1-stable)
- [Oxfmt Beta — VoidZero / oxc.rs](https://oxc.rs/blog/2026-02-24-oxfmt-beta)
- [Oxlint Type-Aware Linting Alpha — VoidZero](https://voidzero.dev/posts/announcing-oxlint-type-aware-linting-alpha)
- [Migrate from Prettier — Oxfmt docs](https://oxc.rs/docs/guide/usage/formatter/migrate-from-prettier)
- [Oxlint Config File Reference — oxc.rs](https://oxc.rs/docs/guide/usage/linter/config-file-reference)
- [Oxlint Rules — oxc.rs](https://oxc.rs/docs/guide/usage/linter/rules.html)
- [Migrating from ESLint, Biome, and Prettier to Oxlint and Oxfmt — Nicolas Charpentier](https://charpeni.com/blog/migrating-from-eslint-biome-prettier-to-oxlint-oxfmt)
