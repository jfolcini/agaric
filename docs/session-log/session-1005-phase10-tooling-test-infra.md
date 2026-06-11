# Session 1005 — Phase 10: tooling / test-infra (maintainer-approved)

Maintainer approved starting Phase 10 (tooling/test-infra) ahead of the remaining arch
items (#644-B / #645-freebie). Most of the original Phase 10 list was already closed by
prior sessions; the open residue was a small hygiene cluster + the prek re-split.

## Shipped (PRs)

- **`fix(tooling)` hygiene — #864 + #868** (this PR):
  - **#864** — `src-tauri/tests/AGENTS.md:27` documented `cargo nextest … -E 'test(::op_log::)'`,
    but nextest names have no leading `::`, so the substring matched **0 tests** (same
    silent-no-match class as #641). Dropped the leading `::` → `test(op_log::)`.
  - **#868** — `scripts/check-import-cycles.mjs` stripped comments but NOT string/template
    literals, so a future import-shaped template literal / codegen string could register a
    phantom edge and false-FAIL a legit PR. Replaced the comment-only strip with a single-pass
    **string/comment/template-aware tokenizer** that emits a `masked` string + a `codeMask`
    bit-array; an `import`/`export`/`import(` match is accepted ONLY when its keyword sits in
    code position (`codeMask === 1`) — so real specifiers survive while import-shaped text in
    value position is rejected. Exported `detectImports` + a 5-case vitest
    (`src/__tests__/check-import-cycles-detect.test.ts`: real static/dynamic import → edge;
    template-literal + value-string + comment import-shaped text → no edge). Script still
    reports `0 import cycles` over 1137 modules. Also added the #868 logger-transport.ts
    lazy-sink constraint comment (module-init `logger.warn/error` before `tauri.ts` registers
    its sink is dropped by the no-op default — guard-rail note). Closes #864 #868.

- **`ci(prek)` stage re-split — #817** (sibling PR): see that PR. Moves tests/clippy/knip/
  lychee to pre-push, pins Phase-A lints to pre-commit (run once per push, not up to 3×),
  switches oxfmt/cargo-fmt to auto-fix write mode (taplo stays --check), and adds the missing
  `commit-msg` shim to `default_install_hook_types`. Target: commits <60s with no test runs;
  one ~3-5min push pass. **Maintainer action: run `prek install -f` once** after merge to pick
  up the new commit-msg shim.

## Next (per maintainer 2026-06-11)

After Phase 10: #644 **Option B** (split `commands/pages.rs` only), then #645 **freebie**
(diagnostics-bin crate split). The full Tauri-free core carve (Option C, decouple-first) is
the agreed end-state but deferred.
