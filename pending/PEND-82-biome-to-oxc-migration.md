# PEND-82 — Adopt the OXC toolchain (lint, format, build-pipeline)

Replace Biome (linter + formatter) with VoidZero's OXC toolchain and migrate
the Vite build pipeline onto OXC's Rust-based pieces in the same arc:

- **Track A (lint + format swap)** — `oxlint` (linter, v1.0 stable since
  Aug 2025) + `oxfmt` (formatter, Beta since Feb 2026) replace `biome.json`
  and the `biome-check` hook.
- **Track B (build-pipeline adoption)** — `oxc-transform` and
  `oxc-resolver` are already running today (Vite 8 ships Rolldown as its
  runtime bundler — see Track B header), so the only outstanding pieces
  are flipping `build.minify` from `'esbuild'` to `'oxc'` in
  `vite.config.ts:132`, and an optional swap of `@vitejs/plugin-react` →
  `@vitejs/plugin-react-oxc` to drop the residual Babel surface.

Both tracks are Rust-based, ecosystem-aligned (VoidZero/Vite+), and
substantially faster than the incumbents — but Track A introduces non-trivial
config translation, suppression-comment churn, and three concrete
rule-coverage regressions. Track B is much smaller than first glance
suggests: **Vite 8 already runs on Rolldown** (no rollup in the dep tree;
`oxc-transform` and `oxc-resolver` are on the build path today), so Track B
reduces to selecting `'oxc'` as the minifier and an optional
plugin-react-oxc swap. Each track has its own kill-criterion prototype
before commitment.

> **Latent / not-urgent.** Biome is currently squeaky-clean on this repo (see
> PEND-69) and runs in well under a second; Vite+esbuild build is ~few-second
> cold. The perf upside is real but not a bottleneck the maintainer is
> feeling today. The reason to do this is ecosystem trajectory (Vite+ is
> being rebuilt on Rolldown/OXC, type-aware linting is on the oxlint
> roadmap, plugin-react-oxc is the documented forward path), not pain
> relief. The two tracks are **independent** — Track A can ship without
> Track B, and vice versa.

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
- **Vite 8 is already on Rolldown** (which is itself built on OXC). The
  installed `vite@8.0.14` declares `rolldown: 1.0.2` as a production
  `dependency` and there is **no `rollup` anywhere in the dep tree** — the
  `vite@npm:rolldown-vite` alias was the Vite 6/7 opt-in mechanism and is
  obsolete in v8. Vite 8 re-exports `transformWithOxc` as a first-class API.
  This means `oxc-transform` and `oxc-resolver` are *already* on the
  critical build path — Track B doesn't need to install them; it just
  selects how aggressively to use them.
- **`build.minify` accepts `'oxc'` natively in Vite 8** — typed
  `boolean | 'oxc' | 'terser' | 'esbuild'`. The current
  `vite.config.ts:132` still pins `'esbuild'` (the pre-v8 default).
  Flipping to `'oxc'` is a one-character change behind a Phase B0
  kill-criterion.
- **`@vitejs/plugin-react-oxc`** ("the future default Vite plugin for React
  projects") is published as the eventually-default replacement for
  `@vitejs/plugin-react`. The currently-installed `@vitejs/plugin-react@6`
  is **already Rolldown-native** (declares `@rolldown/plugin-babel` as a
  peer dep; no `@babel/core` runtime dep), so the upgrade to `-oxc` is
  optional and only buys removing the residual Babel surface for the
  React Refresh injection. Tradeoff: plugin-react-oxc has no Babel
  hookpoint, so it's not viable if/when this repo adopts
  `babel-plugin-react-compiler`.
- **Migration helpers:** `@oxlint/migrate` translates ESLint flat configs;
  `oxfmt --migrate prettier` translates Prettier configs. **No Biome migrator
  exists** — config and suppression rewrites are manual. (No Track B
  migration helper is needed — the minifier swap is one config-key edit
  and the optional plugin-react-oxc swap is one import line.)

## OXC toolchain — coverage matrix

What each piece of the OXC stack is, what it would replace here, and the
natural adoption path. **Not all OXC components have a useful standalone
CLI surface** — `oxc-transform` and `oxc-resolver` are libraries consumed
by higher-level tools, and three of the five pieces are *already in use
transitively* via Vite 8 / Rolldown.

| OXC piece | Status (current install) | Replaces in agaric | Adoption path | Track |
|---|---|---|---|---|
| `oxlint` | not installed; oxlint 1.0 stable (Aug 2025) | `biome` linter (`biome.json` lint block + `biome-check` hook) | Direct: `.oxlintrc.json` + `oxlint` CLI | **A** |
| `oxfmt` | not installed; oxfmt Beta (Feb 2026) | `biome` formatter (`biome.json` formatter block + `biome format` scripts) | Direct: `.oxfmtrc` + `oxfmt` CLI | **A** |
| `oxc-transform` | ✅ **already in use** — pulled in by Rolldown via Vite 8; Vite re-exports `transformWithOxc` | Babel in `@vitejs/plugin-react@6` (already Rolldown-native — no `@babel/core` runtime dep) | **No work.** Optional follow-up: swap `@vitejs/plugin-react` → `@vitejs/plugin-react-oxc` to drop the remaining Babel surface for React Refresh (Phase B2 — gated on not adopting react-compiler). | **B** (optional) |
| `oxc-resolver` | ✅ **already in use** — Rolldown's internal resolver | Vite's resolver path (transparent) | **Transitive.** Nothing to do — also picked up by oxlint when Track A lands. | — |
| `oxc-minify` | available but not selected — `build.minify` is typed `boolean \| 'oxc' \| 'terser' \| 'esbuild'`; `vite.config.ts:132` still pins `'esbuild'` | The esbuild minifier in production builds | **One-line config change** (Phase B0/B1): `'esbuild'` → `'oxc'`, behind a kill-criterion prototype. | **B** |

**Takeaways for scoping:**

1. We are already on Rolldown, which means `oxc-transform` and
   `oxc-resolver` are already on the build path. There is *no work* to
   "adopt" them — strike them from the active todo list.
2. The only build-pipeline work is **flipping the minifier** to `'oxc'`
   and an optional plugin-react-oxc swap. Combined Track B effort is
   well under a day if both kill-criteria clear.
3. Track A (lint+format swap) remains the headline migration — bigger
   diff, more decisions, more docs.

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

The two tracks are independent. **Default execution order: A → B**, because
Track A is the bigger diff with more decisions, and landing it first
proves the toolchain piecewise. Track B is small enough that it can also
go first if the maintainer prefers a quick warm-up. The tracks can be done
in parallel worktrees, but the doc/dep cleanup phases (A3, B3) must not
race for the same files.

---

## Track A — Lint + format swap (Biome → oxlint + oxfmt)

### Phase A0 — Prototype on a worktree (½ day, kill-criterion gate)

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
   file. **Gate:** maintainer signs off before Phase A1.

### Phase A1 — Config + scripts + hook swap (1 day)

Assumes Phase A0 green-lighted.

1. **`.oxlintrc.json`** — full hand-port of `biome.json`'s 13 customized rules
   plus 3 override blocks. Includes a top-level `ignorePatterns` mirroring
   Biome's `files.includes` exclusions (`dist`, `src-tauri/target`,
   `src-tauri/gen`, `.sqlx`, `src/lib/bindings.ts`, `coverage`, `*.css`,
   `public/pdf.worker.min.mjs`).
2. **`.oxfmtrc` / oxfmt config** — single quote, no semis (or whatever Phase A0
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

### Phase A2 — Mechanical suppression rewrite (½–1 day)

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
   replacement rule (if any) **only if Phase A0 D3 said "use cyclomatic at
   re-baselined threshold"**; otherwise drop the directives entirely.

### Phase A3 — Doc sweep + cleanup (¼ day)

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

### Phase A4 — Verification (½ day, parallel with Phase A3)

1. `npx oxlint .` — must be 0 warnings.
2. `npx oxfmt --check .` — must be 0 violations.
3. `prek run --all-files` — must pass.
4. `scripts/verify-ci-equivalent.sh` — must pass (full CI mirror).
5. Open a PR; let `_validate.yml` confirm CI is happy with the new hooks.

---

## Track B — Build-pipeline OXC adoption (transform + resolver + minify)

> **Important: we are already on Rolldown.** The current `vite@8.0.14` lists
> `rolldown: 1.0.2` as a runtime `dependency` and **no `rollup` exists in
> the dep tree at all** (`npm ls rollup` → empty). `@vitejs/plugin-react@6`
> declares `@rolldown/plugin-babel` as a peer dep and no longer pulls in
> `@babel/core` at runtime. The `vite@npm:rolldown-vite` alias was the
> Vite 6/7 opt-in path and is **obsolete for v8** — Rolldown is the only
> bundler in Vite 8.
>
> Concretely, that means:
>
> - **`oxc-transform`** is already running (Rolldown uses it for the
>   TS/JSX transform; Vite 8 re-exports it as `transformWithOxc`).
> - **`oxc-resolver`** is already running (Rolldown's internal resolver).
> - **`oxc-minify`** is *available but not yet selected* — Vite 8's
>   `BuildOptions.minify` is typed `boolean | 'oxc' | 'terser' | 'esbuild'`
>   and `vite.config.ts:132` still pins `'esbuild'` (the pre-v8 default).
>
> So Track B's real scope is **two small follow-ups**, not a build-engine
> swap:

- **B-flip-minifier** — change `build.minify` from `'esbuild'` to `'oxc'`
  in `vite.config.ts:132`. One-line config change behind a kill-criterion
  prototype.
- **B-plugin-react-oxc (optional)** — swap `@vitejs/plugin-react@6` →
  `@vitejs/plugin-react-oxc` to remove the remaining Babel surface in the
  React Refresh injection. Only meaningful if we're not using any Babel
  plugins / `babel-plugin-react-compiler` (verify before committing —
  plugin-react-oxc has no Babel hookpoint).

### Phase B0 — Prototype the minifier flip (½ day, kill-criterion gate)

Goal: prove `oxc-minify` produces a working production bundle of equal-or-
better size, **before** changing the default for everyone.

1. Branch off `main` in a separate worktree (don't share with Track A
   work-in-progress).
2. Edit `vite.config.ts:132`:
   - From: `minify: !process.env['TAURI_DEBUG'] ? 'esbuild' : false`
   - To:   `minify: !process.env['TAURI_DEBUG'] ? 'oxc' : false`
3. `npm run build` — produce a baseline esbuild build first on `main`,
   then this `oxc` build. Capture:
   - `dist/` raw + gzip totals (via `du -sb` and a gzip pass).
   - Per-chunk sizes from `rollup-plugin-visualizer` (run with `ANALYZE=1`
     against both builds).
   - Build wall time (real seconds, repeat 3× and take the median).
4. `npm run test` — Vitest stays on the dev pipeline, but a smoke run
   catches any transform-time regressions in shared code paths.
5. `npm run test:e2e` (Playwright) — must pass against the `oxc`-minified
   build. The Tauri-served bundle is what end users actually load, so any
   minification-induced runtime regression surfaces here.
6. **Kill criteria** — any of the following, abort and stay on `'esbuild'`:
   - bundle size grows (raw or gzip) by any non-trivial amount;
   - any test failure that didn't exist on the esbuild build;
   - a chunk's content changes shape in a way that breaks the PERF-24
     manual-chunks intent (e.g. a vendor chunk now imports app code);
   - the MAINT-84 destructuring-in-workers bug (`vite.config.ts:121-130`)
     re-appears under `oxc-minify` — original repro: discriminated-union
     narrowing in a Worker, lower target. Re-run the relevant Worker
     code paths.
7. Write findings + the D7 decision at the top of this file. **Gate:**
   maintainer signs off before Phase B1.

### Phase B1 — Apply the minifier flip (¼ day)

Assumes Phase B0 green-lighted.

1. Land the `vite.config.ts:132` edit as a single commit.
2. Update the MAINT-84 comment at `vite.config.ts:121-130`. The original
   bug was esbuild-specific (`esbuild worker-pipeline bug`); under
   `oxc-minify` the comment should be tightened to historical context.
   Do **not** delete the `es2023` target rationale — that's
   minifier-independent and still applies.
3. Audit the direct `esbuild` devDep (`package.json:111`, `^0.28.0`). It
   was historically required by `@vitejs/plugin-react` and by Vite's own
   esbuild minifier path. With `minify: 'oxc'`, run `npm ls esbuild` to
   see if anything else (vitest's dep-prebundle, etc.) still pulls it in
   transitively. If yes → leave the direct devDep alone (pinning the
   floor matters). If no → consider removing the explicit devDep so the
   peer-dep is the only source of truth.

### Phase B2 — Optional plugin-react-oxc swap (¼ day, separate decision)

This is independent of B1 and can be done later (or skipped). Only run
if D8 = "swap".

1. `npm rm @vitejs/plugin-react && npm i -D @vitejs/plugin-react-oxc`.
2. In `vite.config.ts:3`, change the import:
   - From: `import react from '@vitejs/plugin-react'`
   - To:   `import react from '@vitejs/plugin-react-oxc'`
3. `npm run dev` — verify HMR + React Refresh on a real edit.
4. `npm run build` — diff `dist/` vs baseline; expect no meaningful size
   change but a slightly faster transform path.
5. Update `.github/dependabot.yml` — move the dep entry to the new name in
   whichever group currently contains `@vitejs/plugin-react`.

### Phase B3 — Doc sweep + cleanup (¼ day, parallel with B1/B2)

1. `docs/architecture/tooling.md` — if a "Build pipeline" section exists,
   note that Vite 8 ships Rolldown (already true at the time of writing
   PEND-82) and that the minifier is now `oxc-minify`. If no such section
   exists, do not add one — code is authoritative.
2. `docs/BUILD.md` — update the build-tool description if it names
   `esbuild` or `Rollup` specifically.
3. `vite.config.ts:121-130` — tightened in Phase B1 (above).
4. `pending/PERF-24` — note that the chunking algorithm has been Rolldown
   for the life of vite 8; the minifier swap doesn't affect chunking.
5. `pending/MAINT-84` — note that the esbuild worker-pipeline bug class
   is now off the codepath.

## Open decisions (Phase A0 / B0 gates)

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
- **D5 — Track A / Track B ordering.** Default A → B (lint+format swap
  first, then build pipeline). Track A is the bigger diff and the more
  decisions; landing it first proves the toolchain piecewise. Track B's
  minifier flip is independent and can land in any order — including
  before Track A — if a maintainer prefers the small change first.
  Alternative: parallel worktrees if both are wanted in the same release
  window — coordinate edits to `package.json`, `dependabot.yml`, and
  `docs/architecture/tooling.md` to avoid merge churn.
- **D6 — Track B minifier semantics.** The current
  `build.minify: !TAURI_DEBUG ? 'esbuild' : false` (`vite.config.ts:132`)
  has a `TAURI_DEBUG=1` short-circuit for debug builds. The minimal swap
  is `'esbuild'` → `'oxc'`, preserving the short-circuit unchanged. The
  MAINT-84 / esbuild-worker-pipeline-bug commentary at
  `vite.config.ts:121-130` documents an esbuild-specific
  destructuring-in-workers fix that may be obsolete under `oxc-minify` —
  re-run the original Worker repro at Phase B0 to confirm. If the bug
  class is genuinely off the codepath, tighten the comment to historical
  context (don't delete the `es2023` target rationale — that's
  minifier-independent).
- **D7 — Adopt `'oxc'` minifier?** Decision belongs at the bottom of
  Phase B0:
  - (a) **Adopt** — bundle size is equal-or-better, no test regressions,
    no MAINT-84-class regression. Flip in Phase B1.
  - (b) **Defer** — any kill-criterion fires; stay on `'esbuild'` and
    revisit when `oxc-minify` reaches a published 1.0 (the standalone
    `oxc-minify` package is still labelled alpha/Beta in OXC's release
    pages even though Rolldown ships it).

  Recommendation: **adopt (a)** unless the prototype shows a clear
  regression — Vite 8 has standardised the option, and the rest of the
  Vite codepath already runs on Rolldown/OXC, so the minifier is the
  only step in the chain still using a non-OXC tool.
- **D8 — Adopt `@vitejs/plugin-react-oxc`?**
  - (a) **Swap** — removes the residual Babel surface; tiny speedup on
    cold start; documented forward-default path. **Blocker:** if/when
    this repo adopts `babel-plugin-react-compiler` (currently it does
    not), `-oxc` is not viable because it has no Babel hookpoint.
  - (b) **Stay** on `@vitejs/plugin-react@6` — already Rolldown-native;
    keeps the Babel hookpoint available for future react-compiler /
    custom-plugin work.

  Recommendation: **stay (b)** for now. The performance delta is small,
  `@vitejs/plugin-react` v6 already removed the heavy Babel runtime dep,
  and keeping the hookpoint is cheap optionality.

## Cost / impact / risk

- **Cost:**
  - **Track A:** S-M, ~2-3 days end-to-end (Phase A0 ½d, A1 1d, A2 ½-1d,
    A3 ¼d, A4 ½d). The hand-port of the config and the suppression-
    comment rewrite dominate.
  - **Track B (minifier flip alone):** XS, ~¾ day end-to-end — Phase B0
    prototype ½d (build + e2e smoke + size measurement is the bulk), B1
    apply ¼d.
  - **Track B optional plugin-react-oxc swap (D8 = swap):** add ¼ day on
    top.
- **Impact:**
  - Performance: lint ~2× faster, format ~3× faster (Track A). Build:
    minifier-only delta is typically small but measurable on cold prod
    builds (Phase B0 quantifies it on this repo specifically). **None of
    these are material to the maintainer's current workflow** — Biome
    already runs under a second and prod builds aren't on the inner loop.
  - Ecosystem: aligns with VoidZero direction across linter, formatter,
    and the build pipeline's last non-OXC step; opens the door to
    type-aware linting (oxlint roadmap) without re-tooling later.
  - Surface area: 1 fewer config file (`.oxlintrc.json` + `.oxfmtrc`
    replace `biome.json`'s combined config — slightly more files, but
    each is smaller). Track B is config-shrink, not config-add.
- **Risk:**
  - **D3 rule holes** — accepting the loss of 3 rules is Track A's
    headline behaviour change. Pre-PR review of any code touched in the
    same window can mitigate.
  - **`semicolons: asNeeded` mapping** — formatter divergence would
    touch every JS/TS file. Phase A0 prototype catches this on Day 1.
  - **Tooling churn** — oxfmt is Beta and `oxc-minify` is alpha/Beta as
    a standalone (though stable as Rolldown's built-in); config may
    shift before 1.0. Risk is bounded (config is small) but real.
  - **MAINT-84 regression class** — the esbuild worker-pipeline
    destructuring bug is documented in `vite.config.ts:121-130`. If
    `oxc-minify` re-introduces a related bug class, Phase B0's Worker
    repro catches it before the flip.
  - **Doc/links** — PEND-69's narrative references `biome` heavily;
    needs careful sweep to avoid stale references.

## How to re-audit current state

```bash
# Track A — suppression inventory (the lint-migration target)
grep -rhoE "biome-ignore lint/[a-zA-Z/]+" src e2e --include='*.ts' --include='*.tsx' \
  | sort | uniq -c | sort -rn

# Track A — all biome references in tooling/docs that need rewriting
grep -rn -i "biome" --include='*.yml' --include='*.json' --include='*.md' \
  --include='*.toml' --include='*.sh' . \
  | grep -v node_modules | grep -v .claude/worktrees

# Track A — baseline Biome run (must be 0 warnings before migration)
./node_modules/.bin/biome check .

# Track B — confirm vite is on Rolldown (no rollup in tree)
npm ls vite rolldown rollup

# Track B — confirm current minify selection
grep -n "minify" vite.config.ts
```

## Sources (2026 snapshot)

- [Announcing Oxlint 1.0 — VoidZero](https://voidzero.dev/posts/announcing-oxlint-1-stable)
- [Oxfmt Beta — VoidZero / oxc.rs](https://oxc.rs/blog/2026-02-24-oxfmt-beta)
- [Oxlint Type-Aware Linting Alpha — VoidZero](https://voidzero.dev/posts/announcing-oxlint-type-aware-linting-alpha)
- [Migrate from Prettier — Oxfmt docs](https://oxc.rs/docs/guide/usage/formatter/migrate-from-prettier)
- [Oxlint Config File Reference — oxc.rs](https://oxc.rs/docs/guide/usage/linter/config-file-reference)
- [Oxlint Rules — oxc.rs](https://oxc.rs/docs/guide/usage/linter/rules.html)
- [Migrating from ESLint, Biome, and Prettier to Oxlint and Oxfmt — Nicolas Charpentier](https://charpeni.com/blog/migrating-from-eslint-biome-prettier-to-oxlint-oxfmt)
- [Rolldown — the bundler that powers Vite 7+](https://rolldown.rs/)
- [`@vitejs/plugin-react-oxc` on npm](https://www.npmjs.com/package/@vitejs/plugin-react-oxc) — described as "The future default Vite plugin for React projects"
- Verified locally on `vite@8.0.14`: `BuildOptions.minify` is typed
  `boolean | 'oxc' | 'terser' | 'esbuild'`; `rolldown@1.0.2` is a runtime
  dep; `rollup` is absent from the dep tree.
