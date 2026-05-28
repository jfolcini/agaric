<!-- markdownlint-disable MD060 -->
# Bindings, Tooling, Security

Architectural contracts at the language / process boundaries. Workflow + catalogues live in [`docs/BUILD.md`](../BUILD.md); this file documents the **rules**, not the commands.

## Type-safe IPC bindings

The `agaric_commands!` macro in `src-tauri/src/lib.rs` is the **single source of truth** for the Tauri command surface. It expands to both:

1. The production `invoke_handler!` registration (real runtime).
2. The `tauri-specta::collect_commands!` export (TypeScript bindings).

Because both consumers come from the same token tree, the handler and the bindings cannot drift. Add a command in one place → both update.

Bindings are generated into `src/lib/bindings.ts` by the `regenerate_ts_bindings` ignored test (`cargo test -- specta_tests --ignored`). The generated file is checked in. A Rust test gate (`ts_bindings_up_to_date`) runs in CI; the generated content is whitespace-and-header-normalised before compare, so cosmetic diffs don't fail the gate.

`src/lib/tauri.ts` wraps every `invoke()` call in a typed function. The wrapper layer handles Tauri 2's explicit-null-vs-undefined contract (Tauri rejects `undefined` over the wire; the wrapper coerces). Frontend always calls the typed wrappers, never `invoke()` directly.

## Compile-time SQL

Every `sqlx::query!` / `sqlx::query_as!` is validated at compile time against the schema. The offline cache is `.sqlx/` (checked in). The `sqlx-prepare-check` prek hook (pre-push) fails on a stale cache.

Runtime `sqlx::query()` (no macro) is restricted to genuinely-dynamic SQL: recursive CTEs, FTS5 query builders, snapshot ops, sync protocol fan-out. Every such site has a comment justifying the runtime form.

## ULID + RFC3339 type-level contracts

Two invariants ride at the type level:

- **ULID uppercase Crockford-Base32** — `BlockId::Deserialize` / `::new` / `::from_trusted` all normalise. The op-log blake3 preimage is hash-stable only when this normalisation is, so the contract is enforced at construction. Lowercase ULIDs round-trip back to uppercase before storage.
- **`now_rfc3339()` returns a lex-monotonic `Z`-suffix string.** Millisecond precision. Reverse-op queries rely on lex-comparing timestamps; without the `Z` suffix lex comparison would diverge from chronological order.

Both contracts are documented at the construction site and enforced by tests.

## Dev tooling

The single source of truth for all pre-commit / pre-push gates is `prek.toml`. CI invokes `_validate.yml` (a reusable workflow shared by `ci.yml` and `release.yml`) which runs the same gate. Green local `prek run --all-files` ⇒ green CI validate.

Pre-commit vs pre-push split is deliberate: fast hooks (biome, type-check, lint, markdown, link-check, …) on commit; compile-heavy hooks (`cargo nextest`, `cargo sqlx prepare --check`, `playwright`) on push. Keeps commit latency under a few seconds; push catches everything.

Notable hooks that enforce architectural contracts:

- **`tauri-command-sanitize`** — see Security § Error sanitization below.
- **`tauri-bindings-parity`** — fails on bindings drift.
- **`tauri-mock-parity`** — fails if `src/lib/tauri-mock/handlers.ts` is missing a handler that the wrapper layer expects.
- **`migrations-immutable`** — refuses changes to already-shipped migrations.
- **`migrations-strict-tables`** — every new schema migration must use `STRICT` mode.
- **`ipc-error-path-coverage`** — every Tauri command's error paths must be exercised by tests.
- **`snapshot-redaction`** — insta snapshots must not contain ULIDs or timestamps.
- **`axe-presence`** — every frontend component test must include an `axe(container)` audit.

## Security

### Threat model

Single-user, local-only. The DB is in the user's home directory; kernel-level filesystem permissions are the trust boundary. No bearer tokens, no rate limits, no per-agent budgets — if an attacker can write to your home directory, they already have your data.

Full threat model in `SECURITY.md`. This file documents only the **architectural mechanisms**, not the policy.

### Error sanitization at the IPC boundary

Every Tauri command wraps its inner body with `sanitize_internal_error` (`src-tauri/src/commands/mod.rs`). The wrapper:

- Collapses internal `AppError` variants (`Database`, `Migration`, `Io`, `Json`, `Channel`, `Snapshot`) into a generic `InvalidOperation("an internal error occurred")` over the wire.
- Lets user-facing variants (`Validation`, `NotFound`, `InvalidOperation`, `NonReversible`, `Gcal`) pass through with their original message.

The split prevents accidental leakage of file paths, SQL errors, OS error codes, etc. to the frontend (and from there to user-facing toasts, screenshots, bug reports).

Enforced by the `tauri-command-sanitize` prek hook: every new `#[tauri::command]` must wrap its inner with `.map_err(sanitize_internal_error)`.

### Storage

- **No encryption at rest** by the app itself. The OS handles disk encryption (FileVault / BitLocker / LUKS / Android FBE). SQLCipher was rejected (overhead + key management complexity not worth the marginal threat).
- **OS keychain** holds OAuth tokens, per-space (`oauth_tokens_<SPACE_ULID>`).
- **Self-signed TLS certificates** are stored in the keychain; the cert private key never touches disk plaintext.

### Code-level

- `#![deny(unsafe_code)]` at the workspace level — no unsafe code in Agaric's Rust.
- `gitleaks` pre-commit hook + GitHub secret scanning.
- `cargo deny` + `npm audit` pre-push.
- `zizmor` pre-commit on GitHub Actions workflows (template-injection / artipacked / excessive-permissions baseline; unpinned-uses and cache-poisoning are deferred policy calls).
- CodeQL on every PR; Dependabot keeps deps current.

## Observability

`tracing` macros throughout the Rust code. The OS-correct app data directory hosts the log file (`agaric.log` rolled by `tracing-appender`). `src/lib/logger.ts` mirrors structured logging on the frontend; errors are buffered for the `BugReportDialog` to attach.

`reportIpcError` is the canonical IPC-error funnel — wraps every `invoke()` call site so a backend `AppError` always lands in a typed toast + log entry, never `console.error` and silence.

`logger.warn` / `logger.error` are the canonical handlers in `catch` blocks. Silent `.catch(() => {})` is a banned pattern; the rule is enforced by code review.
