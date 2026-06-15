# Session 1034 — audit fix #1266: useBlockLinkResolve memo guard

2026-06-15. From the 2026-06 Opus quality audit (perf). `/loop /batch-issues` run.

## Problem
`src/hooks/useBlockLinkResolve.ts` re-ran its O(N × content-length)
`matchAll(ULID_LINK_RE)` full-page scan on every `s.blocks` array reallocation
(keystroke-flush / indent / reorder), because the scan effect was keyed on the raw
`[blocks]` array — unlike its sibling `useBlockPropertiesBatch.ts`, which derives a
stable signature first.

## Fix
Mirror the sibling's pattern: derive `contentSignature = blocks.map(b => b.id + '\0' +
(b.content ?? '')).join('\x01')` in a `useMemo([blocks])` and key the scan effect on
`[contentSignature]`. Content is included (not just id like the sibling) because
`[[ULID]]` link tokens live in block content. The hook input widened from `{content}`
to `{id, content}` (the sole caller, `BlockTree.tsx:499`, already passes full blocks).

## Verification
New `content-signature memo guard (#1266)` tests: no-recompute when the array is
reallocated with byte-identical id+content (spy on the scan), recompute when a
`[[ULID]]` token is added. Reviewer independently confirmed `id+content` is the complete
dependency set (the scan reads nothing else per block), the `\0`/`\x01` separators
can't collide with real content (26-char Crockford ULID + control-char-free markdown),
and the test fails without the guard. Full frontend suite 12712 passed; tsc + oxlint clean.
