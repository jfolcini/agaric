## Session 914 — #213 PR 4: block-ref creation parity (2026-05-30)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-30 |
| **Subagents** | orchestrator-direct build + 1 explore + 1 review |
| **Items closed** | — (partial: #213 PR 4) |
| **Items modified** | #213 |
| **Tests added** | +4 (toolbar button behaviour ×2, slash catalog ×2) |
| **Files touched** | 9 |

**Summary:** Implemented #213 PR 4 — `((block-ref))` can now be created the same three ways as `[[page-link]]`, all opening the existing BlockRefPicker (which fires on the literal `((` trigger): a toolbar button, a `/block-ref` slash command, and a `blockRefPicker` keyboard-catalog entry. Each mirrors its page-link equivalent: the toolbar button resolves a selection via the existing `resolveBlockRefFromSelection` command or inserts `((` when there's no selection; the slash command + structural handler insert `((`. (Block-refs correctly do NOT get an auto-create path — unlike page-links, you can't create a block that doesn't exist.)

**Files touched (this session):**
- `src/lib/toolbar-config.ts` (+block-ref button in `createRefsAndBlocks`, `Parentheses` icon)
- `src/lib/slash-commands.ts` (+`block-ref` command, references group)
- `src/hooks/useBlockSlashCommands/useSlashCommandStructural.ts` (+`'block-ref'` handler → `((`)
- `src/lib/keyboard-config/catalog.ts` (+`blockRefPicker` entry, keys `((`)
- `src/lib/i18n/toolbar.ts` (+`toolbar.insertBlockRef`, `toolbar.blockRefTip`)
- `src/lib/i18n/shortcuts.ts` (+`keyboard.blockRefPicker`)
- `src/lib/__tests__/toolbar-config.test.ts` (count 3→4, label list, insertTag index→2, +2 block-ref behaviour tests) & `src/lib/__tests__/slash-commands.test.ts` (+block-ref catalog assertions)

**Verification:**
- `npx vitest run` toolbar-config + slash-commands + keyboard-config + useBlockSlashCommands — 200+ tests pass. tsc clean, oxlint clean.

**Process notes:**
- Pre-scoped with an Explore agent to confirm the mirror was clean (no hidden gaps): `resolveBlockRefFromSelection` + the `((` suggestion plugin already exist; the keyboard catalog entry is documentation metadata (the real trigger is the extension's hardcoded `char: '(('`), exactly like `blockLinkPicker`.

**Commit plan:** single commit / pushed.
