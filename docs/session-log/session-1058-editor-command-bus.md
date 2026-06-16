# Session 1058 — #1250: focus-keyed block-command bus (drop per-BlockTree document-listener fanout)

2026-06-16. From the 2026-06 Opus quality audit (architecture). `/loop /batch-issues` run.
Behavior-preserving; bounded high-value slice (Category A) — keyboard-shortcut layer
(Category B) deferred to a future pass.

## Problem
Per-block editor commands routed through a global `document` CustomEvent bus disambiguated
by a single global `focusedBlockId`, so EVERY mounted BlockTree installed 13 gated
`document` listeners (`useBlockTreeEventListeners`). Journal week/month mount 7–30 BlockTrees
→ 91–390 listeners all firing + re-gating on every command.

## Fix
New `src/lib/block-command-bus.ts` — a module-level registry keyed by `pageStore`. Each
BlockTree calls `registerBlockCommandTarget(store, handlers)` ONCE. `dispatchBlockCommand`
reads the global `focusedBlockId`, resolves the single store where
`storeOwnsBlock(store, focusedBlockId)` holds, and invokes only that tree's handler with
`(blockId, detail)`. Per-BlockTree Category-A listeners: **13 → 0** (one registration).
`dispatchBlockEvent` still also fires the legacy `document` CustomEvent (typed-name
contract carrier; no live BlockTree consumer remains, so zero fanout).

**Scope:** migrated all 13 Category-A custom-event command listeners. **Category B** (the 10
keydown shortcuts in `useBlockTreeKeyboardShortcuts.ts`, with capture-phase /
`defaultPrevented` precedence vs TipTap and no-focus cases) is **deliberately left** as
document listeners — collapsing them safely (preserving the Ctrl+. editor-vs-document
precedence) is a separate, riskier change. No command is half-migrated.

## Verification
Same `storeOwnsBlock` predicate (moved from N per-listener gates to one bus resolution);
at most one owning tree → exactly one handler fires (7-tree test asserts called-once);
payload forwarded identically; reading focus fresh at dispatch is strictly more robust than
the old render-time closure. Reviewer confirmed routing equivalence, no live document
consumer depended on the removed listeners, Category B untouched, leak-free lifecycle. New
bus tests (all 13 commands, ownership, single-fire, lifecycle) + rewritten listener tests.
Full frontend suite 12767 passed; tsc + oxlint clean.
