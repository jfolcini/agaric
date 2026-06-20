# Session 1002 — oxlint guard rules (follow-up)

Follow-up to #1876. Adopts a batch of low-/zero-cost oxlint rules surfaced by
measuring candidate rules against the tree (counts via `oxlint -A all -D <rule>`).

## oxlint rules added

Zero-violation guards (pure regression protection, no code change):
- `unicorn/prefer-node-protocol`
- `unicorn/prefer-array-flat-map`
- `eslint/default-case-last`
- `unicorn/prefer-string-slice`
- `eslint/no-alert`

Small manual fixes (oxlint classifies these as suggestions, not autofixes):
- `unicorn/prefer-modern-math-apis` — 2 sites: `Math.sqrt(dx*dx+dy*dy)` →
  `Math.hypot(dx, dy)` (`useLongPress`, `useBlockTouchLongPress`).
- `eslint/no-lonely-if` — 3 sites: `else { if … }` → `else if …`
  (`SourcePageFilter`, `useToolbarOverflow` ×2). Semantically identical.

Verified: oxlint 0/0, oxfmt clean, `tsgo -b` 0, the 4 touched files' tests pass
(60/60).

## tsc / cargo fmt / oxfmt

Nothing left to adopt — tsc is already maximal (`noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noFallthroughCasesInSwitch`,
`noUnusedLocals/Parameters`, …); stable rustfmt has no extra knobs; oxfmt has no
config surface.

## clippy — deferred (latent-violation finding)

The candidate guards `dbg_macro` / `todo` / `unimplemented` are **already**
configured (`warn`) in the app crate. Mirroring them into the `agaric-diagnostics`
crate was dropped on purpose:

Editing a Rust crate's `[lints.clippy]` forces CI to **re-lint** that crate. On a
clean compile, the diagnostics bins (`op_log_histogram`, `audit_cross_space_refs`)
and some app-lib tests (e.g. `src/mcp/server/tests.rs:368`) trip pedantic lints
added in #1875 (`map_unwrap_or`, `uninlined_format_args`, `semicolon_if_nothing_returned`).
These are **latent on `main`**: when #1875 landed, the Swatinem rust-cache restored
already-compiled artifacts for the unchanged targets, so clippy never re-linted them
and the new lints never fired. They surface only on a cache-miss / clean compile.

→ Left as a separate Rust cleanup (fix the latent violations, ideally with a
cache-busting clean clippy run in CI), tracked outside this frontend PR.
