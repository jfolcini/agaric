# Session 1164 — Multi-agent deep review: 66 issues filed (#2651–#2716) (2026-07-16)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-07-16 |
| **Subagents** | 217 (12 domain reviewers + 2 adversarial verifiers per finding + completeness critic + 2 gap reviewers) |
| **Items closed** | — (review-only session) |
| **Items filed** | #2651–#2716 (66 issues, `deep-review` label; 8 `priority`) |
| **Files touched** | 1 (this log) |

**Summary:** Full-codebase deep review across correctness, robustness, maintainability, performance, architecture, UX, security, unit-test quality, e2e coverage, and docs — from SQL, backend, frontend, and product perspectives. Every finding was adversarially verified by two independent agents (a hallucination fact-checker re-reading the cited code, and an exaggeration/severity judge). Review base was `4e499e32c`; every surviving finding was then re-verified against `origin/main @ ec9e0eb78` before filing, which dropped 11 findings already fixed by the parallel work stream (backspace-merge rollback, HistoryPanel store patch, #855 pairing-proof gate, apply-path-collapse doc rewrites, snapshot decode on `spawn_blocking`, and others) and annotated 7 more as partially addressed.

**Pipeline:** 100 raw findings → 83 confirmed / 15 unverified (verifier session-limit deaths; 2 highs manually re-verified and filed, 13 presented to jfolcini unfiled) / 1 disputed / 1 refuted → internal dedupe of 8 double-discoveries → stale-base re-verification → 66 filed.

**Priority (high-severity, all `priority`-labelled):**
- #2651 `flush_draft` appends an op without materializing (the one write path outside `apply_op_projected`)
- #2652 attachment blob-presence check defeats the size-mismatch self-heal
- #2653 batch delete leaves cascaded descendants in the page store (ghost rows)
- #2654 attachment bytes cross IPC as JSON number arrays (multi-MB main-thread stalls)
- #2655 undo/redo engine bypass → non-move undo suspends sync export for the space (reverse-move half already fixed by #1553/#2604)
- #2656 `::` picker / custom property slash commands send empty `value_text` the real backend rejects (mock-masked)
- #2715 exported frontmatter scalars not YAML-escaped (newline injection / fence break-out)
- #2716 multi-line block content does not round-trip through export→import

**Recurring themes (mediums/lows):** the hand-maintained per-op cache-invalidation matrix in `materializer/dispatch.rs` (3 fresh gaps of the #2196 shape + its perf mirror: global rebuild fan-outs where scoped infrastructure exists); architecture-doc drift concentrated in `crdt-and-recovery.md` / `AGENTS.md` invariant 2 / `search.md` (several sibling drifts were already fixed upstream mid-review); e2e coverage holes clustered on app-level surfaces (Spaces, draft autosave, MCP settings, sync pairing completion, 4 of 10 settings tabs) with one structural cause — the tauri-mock event system accepts `listen()` but can never deliver an event (#2683, cross-linked to #155).

**General feedback from the reviewers:** consistently strong — "top-decile test suite", "exceptionally good health" (SQL layer), "one of the most performance-disciplined React frontends I have reviewed" (perf), single-write-path + convergence-by-construction praised (architecture). The refuted finding was a security exaggeration (CSP img-src); the disputed one (AgentAccessTab bindings bypass) was judged working-as-intended.

**Coverage caveat:** the `ci-release-supply-chain` gap reviewer died on a session limit and was not re-run — CI/release/supply-chain remains unaudited by this review.

**Verification:** docs-only session (this file); no code changed.
