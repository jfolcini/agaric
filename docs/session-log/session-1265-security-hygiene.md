## Session 1265 — Supply-chain and IPC hygiene (2026-08-05)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-05 |
| **Subagents** | 2 build + 2 review |
| **Items closed** | #3319 |
| **Items modified** | — |
| **Tests added** | 0; 23 durable tests converted, 9 obsolete path/hook tests removed |
| **Files touched** | 28 |

**Summary:** Pinned every cached Tauri CLI install to the exact stable version declared
by `package.json`, removed the unused renderer-supplied attachment-path IPC end to end,
and corrected the advisory-waiver documentation. The live byte-ingest path remains the
sole attachment originator and retains validation, hashing, deduplication, op-log, and
cleanup behavior.

**Files touched (this session):**
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `.github/zizmor.yml`
- `docs/architecture/ci-and-tooling.md`
- `docs/architecture/threat-model.md`
- `src-tauri/agaric-core/src/attachment_filename.rs`
- `src-tauri/agaric-sync/src/sync_files.rs`
- `src-tauri/benches/groups/attachment_bench.rs`
- `src-tauri/src/commands/attachments.rs`
- `src-tauri/src/commands/block_cleanup.rs`
- `src-tauri/src/commands/blocks/crud.rs`
- `src-tauri/src/commands/mod.rs`
- `src-tauri/src/commands/pages/markdown.rs`
- `src-tauri/src/commands/tests/block_cmd_tests.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/materializer/handlers/attachments.rs`
- `src-tauri/src/sync_files/tests.rs`
- `src/hooks/__tests__/useBlockAttachments.test.ts`
- `src/hooks/useBatchAttachments.tsx`
- `src/hooks/useBlockAttachments.ts`
- `src/lib/__tests__/tauri-mock.test.ts`
- `src/lib/__tests__/tauri.test.ts`
- `src/lib/bindings.ts`
- `src/lib/i18n/editor.ts`
- `src/lib/tauri-mock/__tests__/conformance-coverage.test.ts`
- `src/lib/tauri-mock/handlers/attachments.ts`
- `src/lib/tauri/attachments.ts`
- `docs/session-log/session-1265-security-hygiene.md` (new)

**Verification:**
- Attachment-filtered workspace Nextest — 123/123 passed; 5,365 skipped.
- Targeted frontend suite — 4 files / 495 tests passed; the lint-corrected mock file
  was rerun separately, 274/274 passed.
- `just gen-bindings` — passed; generated bindings contain no `addAttachment` command.
- Rust formatting, Oxfmt, Oxlint, Actionlint, Markdown lint, documentation link targets,
  and `git diff --check` — passed.
- Independent technical and adversarial reviews — approved with no remaining findings.
- Canonical `just verify` — passed: Vitest 219 files / 6,487 tests; Nextest
  5,482 passed / 6 skipped; workspace doctests 7 passed / 4 ignored; all four SQLx
  lanes, MCP UDS smoke, externalBin release/version/artifact checks, Cargo audit, and
  npm audit signatures passed. Playwright was intentionally skipped by the verifier.
- pre-commit hook — pending commit.
- pre-push hook — covered by the canonical verifier before transfer-only push.

**Process notes:** Removing the dead wrapper alone would have left an unused arbitrary-path
core. The implementation instead moved durable command tests and the benchmark to
`add_attachment_with_bytes_inner`, deleted only five path-ingress contracts, and kept the
`add_attachment` domain op for replay, history, and undo. Review also caught that the
copied shell version glob accepted ranges and that core-only installed-version extraction
could reuse a prerelease binary; all four sites now validate canonical stable SemVer and
compare the complete CLI version token.

**Lessons learned (for future sessions):** Removing an IPC is a surface migration, not one
macro deletion: bindings, wrappers, hooks, mocks, allowlists, tests, benchmarks, copy, and
comments all need the same reachability audit. Version-pin validation must use the same
grammar on both desired and installed values or cache reuse defeats the pin.

**Commit plan:** single commit, then push and open a stacked PR.
