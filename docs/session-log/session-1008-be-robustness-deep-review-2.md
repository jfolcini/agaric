# Session 1008 — /batch-issues loop: backend robustness, batch 9 (2026-06-19)

## What happened

Ninth batch of the `/loop /batch-issues` run: four backend robustness/security
defense-in-depth findings from the multi-agent deep review, each on a disjoint file,
built by parallel subagents (≤2 concurrent Rust) and adversarially reviewed. Ran
overlapped with batch 8's frontend CI (#1792) and, at its tail, with batch 10's
frontend builds in a separate worktree.

## Shipped

Single PR `fix/be-robustness-deep-review-2`:

- **#1569** (HIGH, security) — the MCP handshake `clientInfo.name` was taken verbatim,
  wrapped in `Actor::Agent`, formatted `agent:{name}`, and bound into the append-only
  hash-chained `op_log.origin` on every RW tool call — no cap, charset normalization,
  or control-char rejection, so a misbehaving local client could persist an arbitrarily
  large/malformed string into durable state. Added `sanitize_agent_name` at the single
  capture site in `mcp/rmcp_adapter.rs` (`MAX_AGENT_NAME_LEN = 128`, `char::is_control`
  strip, char-boundary truncation, whitespace trim, `"unknown"` placeholder for
  empty-after-normalization). Reviewer confirmed no second unsanitized capture path and
  a bounded ≤518-byte durable origin value.
- **#1572** (MEDIUM) — `insert_remote_op` did `INSERT OR IGNORE` on PK `(device_id, seq)`
  and returned `Ok(rows_affected > 0)`, so a pre-existing row with a DIFFERENT hash
  (fork/corruption/device-id reuse) was silently dropped as if it were a benign
  idempotent re-delivery. Added a pre-insert `query_scalar!` probe: same-hash falls
  through (unchanged benign path), different-hash returns `AppError::InvalidOperation`
  + `tracing::error!`. New `.sqlx` entry generated for the probe.
- **#1573** (MEDIUM) — `first_child_for_blocks_inner` took an unbounded `Vec<BlockId>`
  with only an empty-check, never calling `ensure_batch_within_cap` like its siblings;
  added the cap immediately after the empty early-return, matching `get_blocks_inner`.
- **#1588** (LOW) — `SpaceId` Deserialize only uppercased (no ULID validation), so a
  malformed space id via `SpaceScope::Active` silently yielded empty results. Added
  `SpaceId::validate_shape` (reusing `ulid::Ulid::from_str`) + `SpaceScope::validate`,
  enforced via a hand-written `SpaceScope` `Deserialize` (byte-identical adjacently-
  tagged wire format) so all ~20 Tauri commands taking `scope: SpaceScope` reject
  malformed ids at the single serde funnel. `BlockId`/`SpaceId::Deserialize` untouched.

## Review pass

Four adversarial reviewers, two real catches:
- **#1572 reviewer** found a `clippy::collapsible_if` at `dag.rs:452` (would fail the
  pre-push clippy gate); collapsed it into a let-chain. Also owned the `.sqlx` regen and
  verified the offline build. Documented the probe-then-insert TOCTOU as an accepted
  limitation (the PK + `INSERT OR IGNORE` is still a non-overwriting durable backstop;
  this fix improves detection on the serial-delivery path).
- **#1588 reviewer** proved wire-format equivalence against the pre-change derive
  (`tag="kind"`, `content="space_id"`, `global`/`active` renames) and zero specta TS
  drift (regenerated `src/lib/bindings.ts` — only an 11-line doc-comment carried), and
  that `ulid::Ulid::from_str` accepts the uppercased form so no valid id is rejected.
- **#1569** and **#1573** reviewers confirmed clean (single capture site / sibling-cap
  parity) with revert-sensitive tests.

## Follow-ups to file

- Two other uncapped batch-family `json_each(?1)` siblings surfaced by the #1573
  reviewer: `batch_resolve_inner` (`commands/blocks/queries.rs`) and
  `trash_descendant_counts` (`pagination/trash.rs`) — both reachable via IPC, same
  uncapped-large-JSON class. Worth an `ensure_batch_within_cap` follow-up.

## Notes

- Files: `mcp/rmcp_adapter.rs`, `dag.rs` (+ `dag/tests.rs`), `commands/blocks/queries.rs`
  (+ `commands/tests/query_cmd_tests.rs`), `space.rs`, plus one new `.sqlx` entry and a
  doc-comment-only `src/lib/bindings.ts` regen. `cargo clippy --lib` +
  `check --all-targets` clean; offline build verified.
