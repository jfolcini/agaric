# Session 4501 — type-check scripts/**/*.mjs

**Ask.** Fix every finding of the TypeScript review, the small ones included. The largest: the repo's guards and tooling, `scripts/**/*.mjs`, are plain JS that no project type-checked.

**Done.**
- `tsconfig.scripts-js.json`, referenced from the root, checks `scripts/**/*.mjs` with `allowJs` and `checkJs`. It is strict like every project except `noImplicitAny`: an unannotated JS parameter stays `any`, and a type is written only where inference falls short. With `noImplicitAny` on as well, the same check also asked for about 2,900 parameter annotations that check nothing the rest of strict does not. A separate project, so the one `.ts` script keeps `noImplicitAny`.
- The check found 932 errors in 78 files, and oxlint's type-aware rules, which now see the scripts' types, found 12 more. All are fixed, with no `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` or `any`:
  - JSDoc types where inference fell short: `[]` read as `never[]`, `let x = null` read as `null`, and options objects whose optional fields read as required.
  - `js-scanner.mjs` exports a `Token` type and types `tokenize`, which removed most of its errors and the casts its importers would otherwise need.
  - Caught values are `unknown`: they print through `errorMessage` (`scripts/lib/error-message.mjs`), which replaced nine local copies of the same line. `file-mutation-survivors.mjs` uses its own `asError` instead, because a self-test runs a copy of it beside its one static import.
  - `process.env.X` reads with brackets.
  - The sort-compare hits pass a code-unit comparator, the order the default sort gives.
- No real bug turned up. A few values the code assumed present now fail with a message instead of a TypeError:
  - `git-scratch-guard.mjs`: an index entry without an object id.
  - `playwright-shard.mjs`: `--update` without a report path.
  - `check-metric-provable.mjs`: a file missing from the parsed set.
  - A thrown non-`Error` prints as itself, not `undefined`.
- `tsconfig.base.json`'s note loses its history aside (#7125's review note).
- prek's `tsc` hook also runs on `javascript`, so a commit that touches only `.mjs` is checked. CI already ran it, through `prek run --all-files`.

**Ran.**
- `npm run typecheck`: clean, and type-aware oxlint over `scripts/` and `e2e/`: clean.
- `node --test` over every `scripts/**/*.test.mjs`: 257 pass, the same as on `main`.
- Every script's `--self-test`, 17 of them: the same exit codes and assertion counts as on `main`.
