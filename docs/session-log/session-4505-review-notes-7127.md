# Session 4505 — #7127's review notes

**Ask.** Fix every finding, the small ones included; this PR carries the reviewer's non-blocking notes from both of #7127's reviews.

**Done.**
- `errorMessage` (`scripts/lib/error-message.mjs`) replaces the 33 remaining inline copies of `err instanceof Error ? err.message : String(err)`, in 24 scripts. Two copies stay:
  - `file-mutation-survivors.mjs` keeps its own `asError`, because a self-test runs a copy of it beside its one static import.
  - The copy in `check-unanchored-content-regex.mjs` is fixture text, not code.
- `check-dynamic-sql.mjs` and `check-raw-tx.mjs` now import the helper. Their tests copy each guard with the modules it imports (`GUARD_FILES`), so both lists name `lib/error-message.mjs` too.
- `check-doc-code-paths.mjs`'s self-test read an `Error`'s message through `errorMessage` inside its own `instanceof Error` branch; it reads `err.message`. The note named `check-dynamic-sql.mjs`; the line is in `check-doc-code-paths.mjs`.
- `measure-boot.mjs` named its baseline twice, `baselineDir` only to keep a type narrowed inside `boot()`. The argument's destructuring default (`''`) does that, and the usage check still exits on a missing one.
- `tsconfig.json`'s `references` are one object per line again, as before #7127; the one new entry is the only change left there.

**Ran.**
- `npm run typecheck`: clean. Type-aware oxlint over `scripts/`: clean.
- `node --test` over every `scripts/**/*.test.mjs`: 257 pass.
- Every script's `--self-test`, 17 of them: the same exit codes and assertion counts as on `main`.
