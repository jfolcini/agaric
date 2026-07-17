# Session 1178 — #886 StrykerJS nightly mutation lane (frontend pure libs)

## Scope

Adopt StrykerJS mutation testing scoped to the **pure, deterministic** frontend libs
(`search-query` modules, `agenda-sort`, `filters/model`, `date-utils`, `tree-utils`) as a
**nightly-only, non-gating** CI lane — implementing the maintainer's evaluation verdict on
[#886](https://github.com/jfolcini/agaric/issues/886) ("adopt, but as a nightly-only lane,
not per-PR gating").

Closes #886.

## What shipped

- `stryker.config.mjs` — Stryker config implementing the three known blockers from the
  maintainer's eval: (1) `tsconfigFile` pointed at a nonexistent path so Stryker skips the
  tsconfig rewrite that crashes under this repo's `typescript@7` native port; (2)
  `ignorePatterns` excluding `src-tauri`/`e2e`/`target`/`.venv`/etc. so the monorepo sandbox
  copy doesn't choke; (3) `vitest.related: false` to defeat barrel-re-export scope creep.
- `stryker.modules.mjs` — single source of truth mapping each of the 10 mutated modules to
  its own test file(s).
- `stryker.vitest.config.mjs` — per-module vitest config; `test.include` narrowed to just
  the target module's test file(s) so mutating one file never pulls in the component suite.
- `scripts/run-mutation.mjs` — driver that runs `stryker run` once per module with
  `STRYKER_MODULE` set (a single Stryker run can't vary vitest scope per mutated file).
- `.github/workflows/scheduled-deep-checks.yml` — new `mutants-frontend` job mirroring the
  Rust `mutants` job's style: Node 24 + `npm ci`, non-blocking (`|| true` — survivors are
  triage signal, not a gate), step-summary table + surviving-mutant list, report artifact
  upload. Rides the existing weekly cron; no new trigger.
- `package.json` / `package-lock.json` — `@stryker-mutator/core@9.6.1` +
  `@stryker-mutator/vitest-runner@9.6.1` (exact), `"mutation"` npm script.
- `.oxlintrc.json` (no-default-export override for the two config files), `.gitignore`
  (`.stryker-tmp/`, `reports/mutation/`), `docs/BUILD.md` ("Mutation testing (nightly)"
  subsection).

## Verification

- All 10 target modules run correctly scoped (6–54 s each); the two spot-checks reproduce
  the maintainer's measured numbers exactly (`tokenize` 81.30%, `filters/model` 80.13%),
  confirming no barrel-import scope leakage.
- `knip` / `oxlint` / `oxfmt --check` / `typos` / `zizmor` clean on every changed file.

## Review

Reviewer (adversarial) caught and fixed one defect: `docs/BUILD.md` documented
`npm run mutation -- tokenize model`, but `model` is not a valid module key — it is
registered as `filters-model`; the documented command would fail. Corrected and re-verified
live. CI job independently confirmed correct, secure (zizmor clean, least-privilege
`contents: read`, no template injection), and non-blocking; dependency diff confirmed to add
only the two Stryker devDeps.

## Notes

- Excluded `search-query/register.ts`, `registry.ts`, `autocomplete.ts` (module-level mutable
  registry state) and `is-iso-date.ts` (no dedicated test file — only exercised indirectly)
  per the maintainer's scoping guidance.
- Single-module local run: `npm run mutation -- <module>` (Node 24 required); no args runs
  all 10.
