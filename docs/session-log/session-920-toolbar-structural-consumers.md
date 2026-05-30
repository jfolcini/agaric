## Session 920 — #253: wire the no-op structural toolbar buttons (ordered-list / divider / callout) (2026-05-30)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-30 |
| **Subagents** | orchestrator-direct |
| **Items closed** | #253 |
| **Items modified** | — |
| **Tests added** | +5 (3 inserts × content assertion, no-focus no-op, unmount cleanup) |
| **Files touched** | 2 |

**Summary:** Fixed #253 — the toolbar **ordered-list / divider / callout** buttons dispatched `INSERT_ORDERED_LIST` / `INSERT_DIVIDER` / `INSERT_CALLOUT` DOM events that **no production code listened for**, so the buttons were silent no-ops. Added the three missing listeners in `useBlockTreeEventListeners`, wired to the **same content-edit path** the matching slash commands already use (`useSlashCommandStructural`): each builds a minimal `SlashCommandContext` from the focused block and reuses the canonical `applyContentEdit` + `readCurrentContent` helpers — so the MAINT-116 undo contract and the parse→edit→remount flow are shared, not re-implemented.

- ordered-list → `1. <content>`
- divider → `---`
- callout → `> [!INFO] <content>`

`useBlockTreeEventListeners`'s `rovingEditor` option was widened from a narrow `{ editor }` shape to the full `RovingEditorHandle` (BlockTree already passes the real handle at runtime) so the handlers can call `editor.getJSON()` + `mount`.

**Files touched:** `src/hooks/useBlockTreeEventListeners.ts` (3 listeners + type widening + slash-helper reuse), `src/hooks/__tests__/useBlockTreeEventListeners.test.ts` (+5 tests asserting `edit_block` is called with the right `toText` and the block is re-mounted; plus no-focus and unmount-cleanup guards).

**Verification:** 21 hook tests + 284 FormattingToolbar/BlockTree integration tests green; tsc + oxlint + oxfmt clean. The listener-registration pattern is identical to the 8 pre-existing working listeners in this hook, and the edit logic is the proven slash-command path — so confidence is high without a manual app run, though a runtime click-through is still worthwhile before relying on it heavily.

**Process notes:**
- This unblocks #215's **callout type picker** sub-issue (#2), which had assumed the callout button worked — now it does, and threading the variant through the `INSERT_CALLOUT` `detail` payload is a clean follow-up.

**Commit plan:** single commit / pushed. `Closes #253`.
