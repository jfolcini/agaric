## Session 1187 — @-tag lookup, creation, and pill navigation (2026-07-22)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-07-22 |
| **Subagents** | 1 build + 1 review (both top-tier; editor-internals) |
| **Items closed** | `#2996` `#2997` `#2998` |
| **Files touched** | 3 source + 4 test/e2e |

**Summary:** Fixed the `@`-tag system. Root cause of the "@ creates nothing / doesn't
surface existing tags" bugs was the orphan-tag lifecycle: `createBlock({blockType:'tag'})`
produces a tag with no `space` property, and `list_all_tags_in_space` filters on
`space_id`, so a just-created (or manually-created-but-unapplied) tag never appears in `@`
search and has no navigable page until it is applied to a block. Fix mirrors the backend's
own orphan-adoption op: emit `setProperty(key:'space', valueRef: currentSpaceId)` right
after `createBlock` at both create sites. Separately, `useTagClickHandler` navigated
unconditionally; it now verifies the target via `getBlock` and surfaces
`linkTargetNotFound` on a miss/deleted tag (mirroring the `[[` link path). #2998 (toolbar
`@` button) already worked — the button inserts ` @` and `@tiptap/suggestion` re-detects
the trigger — so it only needed a regression test.

**Files touched:**
- `src/hooks/useBlockResolve.ts` (`onCreateTag` space-scoping), `src/components/TagList.tsx`
  (manual `handleCreateTag` space-scoping), `src/hooks/useRichContentCallbacks.ts`
  (`useTagClickHandler` navigation guard)
- Tests: `src/editor/__tests__/at-tag-picker.test.ts` (toolbar-trigger integration),
  `src/hooks/__tests__/useBlockResolve.test.ts`, `src/hooks/__tests__/useRichContentCallbacks.test.ts`,
  and `e2e/tag-management.spec.ts` (new crux e2e: create via `@` → fresh `@`-search finds it → pill navigates)

**Verification:**
- `tsc -b --noEmit` 0 errors (reviewer fixed a real `deleted_at` string-vs-epoch type error);
  oxlint clean; vitest 180 passed (targeted).
- Playwright e2e: `e2e/tag-management.spec.ts` 17/17 (incl. the new crux flow) + editor-mode
  pill navigation. Reviewer verified the backend op chain (query → adoption → projection
  `UPDATE blocks SET space_id`) and did an anti-false-green proof: neutralizing the
  `setProperty(space)` write made the crux e2e fail at the space-scoping assertion.

**Process notes:** Debug-first builder confirmed the picker frontend plumbing already
mirrored the `[[` sibling; the real defects were the tag `space_id` lifecycle and a missing
nav guard, not the picker wiring. Flagged decision (kept): space-scope at the two
orphan-producing callsites rather than adding a `createTagInSpace` IPC.

**Commit plan:** single PR (own branch); not auto-merged.
