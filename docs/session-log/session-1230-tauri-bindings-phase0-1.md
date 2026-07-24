# Session 1230 — tauri.ts→bindings.ts migration phases 0+1 (#2927)

**Issue:** #2927

## What

Phase 0 — guard prerequisites (load-bearing):

- `scripts/check-ipc-error-path.mjs` `callsIpc()` widened to match runtime
  `import { commands } from '@/lib/bindings'` (against type-stripped source, so
  `import type`/inline-`type` imports don't count). Without this fix, every later
  consumer swap would silently drop error-path-test coverage. Self-test +3
  fixtures; guard green at 59 components, no new violations.
- `scripts/check-tauri-bindings-parity.mjs`: 6 stale GCal `KNOWN_UNWRAPPED`
  entries pruned (verified absent from bindings.ts). 121/141 wrapped, 20
  allowlisted; stale-allowlist warning gone.

Phase 1 — 54 pure type-only importers redirected `@/lib/tauri` → `@/lib/bindings`
(4 merged into pre-existing bindings imports); every redirected type verified
present in bindings.ts under the same name. `scripts/tauri-import-baseline.json`
209 → 155 via `--update-baseline`.

Deviation from plan estimate (~112/→~97): only 68 files are *pure* type-only
importers (68 + 141 mixed = 209), and 14 of those hit non-redirectable types
(domain-only: `ProjectedAgendaEntry`, `PeerRefRow`, `BibliographyFormat`;
dual-defined with differing shape: `AttachmentRow`, `PropertyRow`,
`ResolvedBlock`) — consolidating those is a semantic change deferred to later
phases. 54 is the defensible tsc-verified set.

## Review

Frontend-only mechanical redirect pass: orchestrator-verified (guards + tsc
re-run post-rebase); agaric-reviewer covers the PR.

## Verification

`npx tsc -b` 0 errors (pre- and post-rebase over the #2897 merge incl. the
regenerated bindings.ts); vitest tauri suites 445 passed (19 files); parity,
import-baseline (+self-test), ipc-error-path (+self-test) prek hooks all green;
oxlint clean; exactly 57 intended files changed.
