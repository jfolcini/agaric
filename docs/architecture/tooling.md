<!-- markdownlint-disable MD060 -->
# Bindings, Tooling, Security

Architectural contracts at the language / process boundaries. Workflow + catalogues live in [`docs/BUILD.md`](../BUILD.md); this file documents the **rules**, not the commands.

## Type-safe IPC bindings

The `agaric_commands!` macro in `src-tauri/src/lib.rs` is the **single source of truth** for the Tauri command surface. It expands to both:

1. The production `invoke_handler!` registration (real runtime).
2. The `tauri-specta::collect_commands!` export (TypeScript bindings).

Because both consumers come from the same token tree, the handler and the bindings cannot drift. Add a command in one place → both update.

Bindings are generated into `src/lib/bindings.ts` by the `regenerate_ts_bindings` ignored test (`cargo test -- specta_tests --ignored`). The generated file is checked in. A Rust test gate (`ts_bindings_up_to_date`) runs in CI; the generated content is whitespace-and-header-normalised before compare, so cosmetic diffs don't fail the gate.

The frontend never calls `invoke()` directly (enforced by the `no-raw-invoke` prek hook). It calls either the generated `commands.*` surface or the hand-written wrapper modules under `src/lib/tauri/`, which handle Tauri 2's explicit-null-vs-undefined contract (Tauri rejects `undefined` over the wire; the wrapper coerces).

The wrapper layer is being retired in favour of direct `bindings.ts` use (#2927). The `tauri-import-baseline` prek hook ratchets it: the allowlist of files importing `@/lib/tauri` (`scripts/tauri-import-baseline.json`) may only shrink. New code should call `commands.*` and unwrap with `unwrap` from `@/lib/app-error`. See [`frontend.md § Tauri command wrappers`](frontend.md).

## Compile-time SQL

Every `sqlx::query!` / `sqlx::query_as!` is validated at compile time against the schema. The offline cache is `.sqlx/` (checked in). The `sqlx-prepare-check` prek hook (pre-push) fails on a stale cache.

Runtime `sqlx::query()` (no macro) is restricted to genuinely-dynamic SQL: recursive CTEs, FTS5 query builders, snapshot ops, sync protocol fan-out. The `check-dynamic-sql` prek hook (#646) enforces this: it counts runtime `sqlx::query(`/`query_as(`/`query_scalar(` sites per production file against a checked-in baseline (`src-tauri/dynamic-sql-baseline.txt`) and fails any file that grows past its baseline unless every dynamic site in it carries a `// dynamic-sql: <reason>` marker. Existing sites are grandfathered; the gate applies back-pressure toward the compile-checked macro forms for new code. The marker attaches to the *statement*, not to a fixed line offset (#3653) — it counts on the call line, on any earlier line of the same statement, or anywhere in the comment run directly above it, so a `cargo fmt` reflow cannot orphan a valid one. Files carrying a whole-file `#![cfg(test)]` inner attribute are skipped: they cannot reach a release binary, so they are outside the guard's remit.

Re-anchoring is scoped (#3659): `python3 scripts/check-dynamic-sql.py --update-baseline <path>...` rewrites only the named entries and leaves every other line byte-identical (bare, it takes the production `.rs` files in your current diff; `--all` regenerates everything). It used to regenerate the whole file, and the baseline had drifted in both directions, so the safest-looking command in the guard's own interface pulled eight unrelated entries into any diff that needed one — which is why contributors were either hand-editing this generated file or skipping the re-anchor entirely. The guard now also fails when the baseline records MORE sites than the tree has, or names a file the scan no longer covers: downward drift is invisible to a ratchet that only fires upward, and every stale entry is headroom a future unjustified site could be added into unnoticed.

## ULID + timestamp type-level contracts

Two invariants ride at the type level:

- **ULID uppercase Crockford-Base32** — `BlockId::Deserialize` / `::new` / `::from_trusted` all normalise. The op-log blake3 preimage is hash-stable only when this normalisation is, so the contract is enforced at construction. Lowercase ULIDs round-trip back to uppercase before storage.
- **Timestamps that get compared are INTEGER epoch-ms, not strings.** `op_log.created_at` is `INTEGER` epoch-ms (migration 0079, #109 Phase 2), sourced from `crate::db::now_ms()` and compared **numerically** — the reverse-op "find prior op" queries rely on that intrinsic integer ordering, so there is no lex-collation or `Z`-suffix hazard. `now_rfc3339()` (a lex-monotonic `Z`-suffix string, millisecond precision) is retained only for legacy TEXT columns not yet migrated (e.g. `property_definitions.created_at`) and for log/display output; new tables take epoch-ms per the AGENTS.md timestamp-encoding rule.

Both contracts are documented at the construction site and enforced by tests.

## Dev tooling

The single source of truth for all pre-commit / pre-push gates is `prek.toml`. CI invokes `_validate.yml` (a reusable workflow shared by `ci.yml` and `release.yml`) which runs the same gate. Green local `prek run --all-files` ⇒ green CI validate.

Pre-commit vs pre-push split is deliberate: fast hooks (oxlint, oxfmt, type-check, markdown, link-check, …) on commit; compile-heavy hooks (`cargo nextest`, `cargo sqlx prepare --check`, `playwright`) on push. Keeps commit latency under a few seconds; push catches everything.

Notable hooks that enforce architectural contracts:

- **`tauri-command-sanitize`** — see Security § Error sanitization below.
- **`tauri-mock-parity`** — fails if `src/lib/tauri-mock/handlers.ts` is missing a handler that the wrapper layer expects.
- **`no-raw-invoke`** — no bare `invoke()` in app code.
- **`tauri-import-baseline`** — ratchets the `@/lib/tauri` → `bindings.ts` migration (#2927); the importer allowlist may only shrink. This is the sole guard on the wrapper layer's retirement — a former sibling hook (`tauri-bindings-parity`, one wrapper per command) was retired in #3218 for pulling in the opposite direction of this ratchet.
- **`migrations-immutable`** — refuses changes to already-shipped migrations.
- **`migrations-strict-tables`** — every new schema migration must use `STRICT` mode.
- **`ipc-error-path-coverage`** — every Tauri command's error paths must be exercised by tests.
- **`snapshot-redaction`** — insta snapshots must not contain ULIDs or timestamps.
- **`axe-presence`** — every frontend component test must include an `axe(container)` audit.
- **`main-module-detection`** — a guard script's "am I the process entry point?" check must realpath **both** sides. `import.meta.url` / `import.meta.filename` is the resolved real path while `process.argv[1]` is the path as invoked, so the naive comparison is false through a symlinked `scripts/` dir, repo root or checkout — and the guard then exits 0 having run nothing, which is indistinguishable from a clean pass (#3373). `import.meta.main` is deliberately not the answer: it is only `Added in: v24.2.0` while `engines.node` is `>=24`, so on a permitted 24.0/24.1 it is `undefined` and reproduces the same silent no-op.

## Security

### Threat model

Single-user, local-only. The DB is in the user's home directory; kernel-level filesystem permissions are the trust boundary. No bearer tokens, no rate limits, no per-agent budgets — if an attacker can write to your home directory, they already have your data.

Full threat model in `SECURITY.md`. This file documents only the **architectural mechanisms**, not the policy.

### Error sanitization at the IPC boundary

Every Tauri command wraps its inner body with `sanitize_internal_error` (`src-tauri/src/commands/mod.rs`). The wrapper:

- Collapses internal `AppError` variants (`Database`, `Migration`, `Io`, `Json`, `Channel`, `Snapshot`) into a generic `InvalidOperation("an internal error occurred")` over the wire.
- Lets user-facing variants (`Validation`, `NotFound`, `InvalidOperation`, `NonReversible`) pass through with their original message.

The split prevents accidental leakage of file paths, SQL errors, OS error codes, etc. to the frontend (and from there to user-facing toasts, screenshots, bug reports).

Enforced by the `tauri-command-sanitize` prek hook: every new `#[tauri::command]` must wrap its inner with `.map_err(sanitize_internal_error)`.

### Storage

- **No encryption at rest** by the app itself. The OS handles disk encryption (FileVault / BitLocker / LUKS / Android FBE). SQLCipher was rejected (overhead + key management complexity not worth the marginal threat).
- **OS keychain** holds OAuth tokens, per-space (`oauth_tokens_<SPACE_ULID>`).
- **The sync identity is a file, not a keychain entry.** `sync-endpoint.key` holds this device's 32-byte ed25519 iroh secret, hex-encoded, mode `0o600`, in the app data dir (`agaric-sync/src/transport/identity.rs`). There is no `keyring` dependency on this path and never was — the retired self-signed TLS keypair lived on disk the same way. OS full-disk encryption is the confidentiality boundary, as it is for `notes.db`.

### Code-level

- `unsafe_code = "deny"` in every crate's `[lints.rust]`. The only escape hatch is a per-file `#![allow(unsafe_code)]`, and each one must be listed in `src-tauri/unsafe-allowlist.txt` (audited by the `unsafe-allowlist` prek hook). See [`ci-and-tooling.md`](ci-and-tooling.md) § JNI / Android unsafe_code reconciliation.
- `gitleaks` pre-commit hook + GitHub secret scanning.
- `cargo deny` + `npm audit` pre-push.
- `zizmor` pre-commit on GitHub Actions workflows (template-injection / artipacked / excessive-permissions baseline; unpinned-uses and cache-poisoning are deferred policy calls).
- CodeQL on every PR; Dependabot keeps deps current.

## Observability

`tracing` macros throughout the Rust code. The OS-correct app data directory hosts the log file (`agaric.log` rolled by `tracing-appender`). `src/lib/logger.ts` mirrors structured logging on the frontend; errors are buffered for the `BugReportDialog` to attach.

`reportIpcError` is the canonical IPC-error funnel — wraps every `invoke()` call site so a backend `AppError` always lands in a typed toast + log entry, never `console.error` and silence.

`logger.warn` / `logger.error` are the canonical handlers in `catch` blocks. Silent `.catch(() => {})` is a banned pattern; the rule is enforced by code review.
