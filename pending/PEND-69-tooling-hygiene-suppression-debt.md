# PEND-69 — Tooling hygiene + suppression-directive tech debt

Tracks the audit of every error / warning / deprecation surfaced by the
toolchain, plus every in-code suppression directive (`#[allow]`, `biome-ignore`,
`@ts-expect-error`, …). Goal: keep the toolchain output **squeaky clean** (it is,
as of the snapshot below) and burn down the suppression surface, removing what is
unnecessary and tracking the rest with a per-category judgment.

> **Counts are a dated snapshot (2026-05-23), indicative not authoritative.** They
> exist to size the debt, not to be policed for staleness — do not add a hook that
> diffs these numbers. Re-run the commands in the "How to re-audit" section to get
> fresh figures.

## Toolchain status — clean baseline

| Tool | Command | Status (2026-05-23) |
|------|---------|---------------------|
| rustfmt | `cd src-tauri && cargo fmt --check` | ✅ clean |
| clippy | `cd src-tauri && cargo clippy --all-targets --all-features --no-deps` | ✅ 0 warnings |
| rust tests | `cd src-tauri && cargo nextest run` | ✅ pass (via prek) |
| rust-analyzer | (LSP; surfaces rustc + clippy) | ✅ proxied by clippy above |
| TypeScript | `npx tsc -b --noEmit` | ✅ no errors |
| Biome | `./node_modules/.bin/biome check .` | ✅ 0 warnings (after this pass) |
| prek umbrella | `prek run --all-files` | ⚠️ see "prek caveat" |

**prek caveat:** the per-commit hook runs on *staged* files only, so latent
`--all-files` breaches can hide in untouched files. One such breach
(`useAppKeyboardShortcuts.ts` cognitive-complexity 40 > 25) was found and fixed in
commit `f0f2117f`. Periodically run `prek run --all-files` against a clean tree to
catch the next one. (Today it is otherwise green.)

## Fixed in this pass

- **Biome unused-suppression warning** — `DensityRow.test.tsx:47` carried a
  `biome-ignore lint/correctness/noUnusedImports` that Biome itself reported as
  having no effect (the `import type * as React` is used). Removed; `biome check`
  is now 0-warning.
- **Two dead `eslint-disable` comments** — the project lints with Biome, not
  ESLint, so these did nothing: `PageBrowser.tsx:870`
  (`react-hooks/exhaustive-deps`; Biome's `useExhaustiveDependencies` was already
  satisfied — the effect uses refs) and `CommandPalette.test.tsx:243`
  (`no-bitwise`; Biome does not ban bitwise ops). Removed; explanatory comments
  kept.

## Suppression surface — TypeScript / Biome

`biome-ignore` directives, grouped by rule. Judgement: **Keep** = legitimate by
design (usually with an inline justification); **Debt** = should be fixed and the
suppression removed; **Audit** = each instance is a latent-bug risk and needs
case-by-case review.

| Rule | ~Count | Judgement | Notes / action |
|------|-------:|-----------|----------------|
| `suspicious/noExplicitAny` | 167 | Mostly Keep (tests) / Debt (prod) | 156 are in `__tests__`/`.spec` (mock/harness loose typing — acceptable). The **11 in prod `src/`** are the real targets: type them properly and drop the ignore. |
| `a11y/useSemanticElements` | 62 | Keep | Custom interactive elements that carry explicit ARIA roles (chip groups, listboxes, toolbars). Legit, but worth one holistic a11y pass to confirm each role is correct. |
| `correctness/useExhaustiveDependencies` | 59 | **Audit** | Deliberately-omitted React effect deps. Each is a stale-closure bug if the reasoning is wrong. Highest-value audit category. |
| `complexity/noBannedTypes` | 38 | Debt/Audit | Mostly `{}` / `Function`. Replace with precise types where feasible. |
| `a11y/useFocusableInteractive` | 25 | Keep | Non-focusable elements with handlers by design; verify keyboard reachability. |
| `style/noNonNullAssertion` | 16 | Audit | `!` escapes (the rule is `error` globally). Prefer a guard / `?.` + cast. |
| `complexity/noExcessiveCognitiveComplexity` | 14 | **Debt** | Functions over budget. Extract sub-functions (cf. the `useAppKeyboardShortcuts` refactor pattern). |
| `a11y/noStaticElementInteractions` | 10 | Keep/Audit | div/span with handlers; confirm role + key handlers exist. |
| `a11y/noNoninteractiveTabindex` | 9 | Keep | Roving-tabindex / focus-management patterns. |
| `a11y/useKeyWithClickEvents` | 6 | Audit | Click-only handlers; confirm keyboard parity. |
| other `a11y/*` | ~11 | Keep | `useAriaPropsSupportedByRole`, `noNoninteractiveElementToInteractiveRole`, `noLabelWithoutControl`, `useAnchorContent`, `noRedundantRoles`. |
| `suspicious/noArrayIndexKey` | 3 | Audit | Index-as-key; fine only for static lists. |
| `security/noDangerouslySetInnerHtml` | 2 | **Audit** | Confirm inputs are sanitized (XSS surface). |
| `suspicious/noConsole`, `noDocumentCookie`, `noThenProperty`, `noControlCharactersInRegex`, `noAssignInExpressions`, `style/useThrowOnlyError` | 1–2 each | Keep | Narrow, justified one-offs. |
| `@ts-expect-error` | 1 | Keep | `e2e/pages-view.spec.ts:956` injects a test-only global; could be typed via a test ambient decl. |

## Suppression surface — Rust

`#[allow]` / `#![allow]` directives, grouped by lint.

| Lint | ~Count | Judgement | Notes / action |
|------|-------:|-----------|----------------|
| `clippy::too_many_arguments` | 41 | Keep (mostly) | Tauri command handlers take many fields. Optionally fold related params into request structs; low priority. |
| `unused_imports` | 4 | Keep (was 23) | **Burned down Session 823.** The 19 file-level `#![allow]` in `commands/tests/*` were removed (4 genuinely-unused imports deleted/narrowed; fmt + clippy + nextest green). The remaining 4 are item-level `pub(crate) use` re-exports in `snapshot/mod.rs` (2) + `sync_daemon/mod.rs` (2) consumed only by a separate integration-test crate — can't be `#[cfg(test)]`-gated without breaking that crate, so the allow is justified and stays. |
| `dead_code` | ~19 | Audited Session 824 | Removed the genuinely-dead `apply_purge_block_sql_only` wrapper (no callers); converted 3 never-read intentional keeps to `#[expect(dead_code, reason)]` (orchestrator `materializer` field, `dag.rs depth`, `db.rs label`) so they self-report when wired. The remaining ~19 `#[allow(dead_code)]` are confirmed-justified keeps: documented scaffolding (`pagination` parity-test consts, `tag_inheritance` macro-embedded const), test-shim modules (`gcal_push/*`), platform-conditional variants (`mcp::SocketKind`), already-`cfg_attr(not(test))`-scoped (`retry_queue::pending_count`, `sync_daemon` handle), specta-read fields (`error::AppErrorSchema`), test-only-but-kept-as-future-API (`recurrence::handle_recurrence`), and the `is_empty`/`len` symmetry helper (`mcp::activity`). |
| `clippy::cast_possible_truncation` | 11 | Audited Session 825 — justified | All 6 production casts already document the invariant that makes truncation impossible (`f64 → i64/usize` has no `std` `TryFrom`; the values are non-negative whole numbers from SQLite REAL columns, or are `clamp`ed to `[0,1]` before scaling in `op_log_histogram::permyriad_from_share`). The 6 test casts are controlled-input data generation (`(i % 256) as u8`, etc.). No `try_into()` change applies (f64→int has no fallible conversion); keep with the documented invariants. |
| `clippy::cast_possible_wrap` | 1 | Audited Session 825 — justified | File-level allow on `integration_tests.rs` (test-only, controlled inputs). |
| `deprecated` | 1 | **Debt (tracked)** | `commands/gcal.rs:552` uses the deprecated `ShellExt::open`. Migrate to `tauri-plugin-opener` (MAINT-227) once the dep lands, then drop the allow. |
| `unsafe_code` | 1 | Keep | `#![allow(unsafe_code)]` on `sync_daemon/android_multicast.rs` (JNI). Justified; see below. |
| `clippy::type_complexity`, `match_same_arms`, `assertions_on_constants` | 1 each | Keep | Narrow, justified. |

### `unsafe` blocks (2 real)

Both in `sync_daemon/android_multicast.rs` (`JavaVM::from_raw` line 105,
`JObject::from_raw` line 123) — JNI FFI, justified inline. **Confirmed Session
825:** both already carry detailed `// SAFETY:` comments stating the invariant
(the process-global `JavaVM`/Activity `Context` from `ndk_context` outlive the
call; null-checked first), and the file-level `#![allow(unsafe_code)]` is
documented. No change needed.

## Migration to `#[expect]` (Rust) — opportunistic

Rust's `#[expect(lint, reason = "…")]` warns (`unfulfilled_lint_expectations`) when
the underlying lint would no longer fire — i.e., it self-deletes when the debt is
paid. Converting the **`dead_code`** and **`unused_imports`** allows to `expect`
would make the unnecessary ones surface automatically on the next build. Do this as
part of the burn-down, not as a mechanical mass-rewrite.

## Recommended action order

1. **`useExhaustiveDependencies` audit (59)** — highest latent-bug value; verify
   each omitted dep is intentional, fix the wrong ones.
2. **Prod `noExplicitAny` (11)** + **`noDangerouslySetInnerHtml` (2)** — small,
   high-value: type the `any`s; confirm the HTML inputs are sanitized.
3. ~~**Rust `unused_imports` (23)**~~ — DONE (Session 823): the 19 file-level test
   allows were removed and 4 unused imports deleted/narrowed; the 4 remaining
   item-level re-export allows are justified (integration-test-crate consumers).
4. ~~**Rust `dead_code` (~23)**~~ — DONE (Session 824): deleted 1 genuinely-dead
   wrapper, converted 3 never-read keeps to `#[expect(dead_code, reason)]`; the
   remaining ~19 `#[allow(dead_code)]` are confirmed-justified keeps (documented
   scaffolding, test-shims, platform variants, specta-read fields).
5. **`noExcessiveCognitiveComplexity` (14)** — extract sub-functions.
6. ~~**`cast_possible_truncation`/`_wrap` (12)**~~ — DONE (Session 825, audit-only):
   all already document the invariant (f64→int has no `try_into`); the 2 `unsafe`
   blocks already carry `// SAFETY:` comments. No code changes needed.
7. **MAINT-227** — `tauri-plugin-opener` migration removes the lone `deprecated`.
8. Lower priority: `noBannedTypes` precise typing; `noNonNullAssertion` guards;
   `too_many_arguments` request-struct folding; a11y holistic pass.

## How to re-audit

```bash
# Toolchain (must stay clean)
cd src-tauri && cargo fmt --check && cargo clippy --all-targets --all-features --no-deps
cd .. && npx tsc -b --noEmit && ./node_modules/.bin/biome check .
prek run --all-files          # against a clean tree — catches latent breaches

# Suppression inventory
grep -rhoE "biome-ignore lint/[a-zA-Z/]+" src e2e --include=*.ts --include=*.tsx | sort | uniq -c | sort -rn
grep -rhoE "#!?\[allow\([a-zA-Z_:]+" src-tauri/src --include=*.rs | sed 's/#!\?\[allow(//' | sort | uniq -c | sort -rn
```
