# Session 4500 — one base tsconfig, and the Playwright project's two missing flags

**Ask.** Review the TypeScript setup against the ecosystem's moving parts (types, `tsc`, tsconfig, bundler, runtime) and fix every finding, the small ones included.

**Found.**
- The five projects each repeated the strict flags, and two had drifted: `tsconfig.e2e.json` and `tsconfig.wdio.json` lacked `noPropertyAccessFromIndexSignature` and `noUncheckedSideEffectImports`, and `tsconfig.node.json` lacked `noImplicitOverride`, `allowUnreachableCode: false` and `allowUnusedLabels: false`.
- `tsx` was a direct devDependency that nothing in the repo calls; `@wdio/cli` depends on it itself, to load `wdio.conf.ts`.
- `scripts/**/*.mjs` is type-checked by no project: the next PR.

**Done.**
- `tsconfig.base.json` holds the shared options and every flag; each project extends it and keeps only its files, `lib`, `types`, `paths` and buildinfo path. The app's `useDefineForClassFields: true` went: it is the default for an ES2023 target.
- The flags it added found 20 errors, all in `e2e/`:
  - `perf.spec.ts`'s `summarize` returned `Record<string, string | number>` for rows that always hold the same four fields. It returns `MetricSummary[]` now, and the `String()` / `Number()` around its fields went with the loose type.
  - The IPC-argument records in `block-keyboard-fundamentals.spec.ts` and `dataset` in `list-rows-phone.spec.ts` are open maps, so they read with brackets.
- `tsx` is gone from `package.json`; it stays installed through `@wdio/cli`, so the lockfile drops one line.

**Ran.**
- `npm run typecheck -- --force`: clean.
- `npx playwright test e2e/block-keyboard-fundamentals.spec.ts e2e/list-rows-phone.spec.ts`: 14 passed. `perf.spec.ts` is opt-in (`AGARIC_PERF=1`) and its change is the row type alone.
- oxfmt and oxlint on the changed files.
