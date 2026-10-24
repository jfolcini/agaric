# Session 2905 — a move into a space refuses a name that space holds

#6099. Moving a page or tag to another space checked the space and the properties the move would drop, never the name. The target could end up holding two pages with one title, and since #6052 a `[[Title]]` link there is a tie that stays plain text.

**Fix.**
- **Forward move:** `move_blocks_to_space_inner` runs the rename check over the moved blocks after its writes. The check is `reject_taken_names`, renamed from #6051's `reject_revived_duplicate_names`, since moves now use it too.
  - It works after the writes because the helpers read each block's current `space_id` and leave the block itself out. They therefore check the target space, and two like-titled pages moved together see each other.
  - A clash rolls back the whole `CommandTx`, Loro included.
- **Reverse path:** a move's reverse is `SetProperty(space = prior)`, which undo, redo, revert and point-in-time restore all apply through `apply_reverse_set_property`. Its `space` branch now runs the same check whenever the block still resolves a space. A trashed block resolves none and passes; restoring it from Trash then hits the #6051 check.
- **Error and UI:** the refusal is the same `Validation`/`DuplicatePageTitle` and message as a rename.
  - The "Move to space" toast already shows a validation message in its own words, so the frontend needed no code.
  - MCP `move_page_to_space` maps `Validation` to invalid-params with the message. Its `list_tools` description now names the refusal, as `mcp/AGENTS.md` asks for a contract change.
  - The undo store keeps a refused undo on the stack, so the same Ctrl+Z works once the holder is renamed.
- **Mock:** the mock's move is wrapped in `allOrNothing` and checks names after its writes, and its revert checks the landing space. Both are pinned by `space_move_onto_a_taken_name.json`, whose `expected` the backend authored.

**Not here:**
- The reverse check runs per op. A page-scoped restore across two space hops is refused when the intermediate space holds the title, even if the final one is free. It refuses whole, and it is the same class as #6051.
- Only the moved ids are checked. A tag nested under a moved page is not, and the app never makes one.

**Shown red:**
- **Backend:** with the forward call removed, the page, tag, pair and MCP tests and the fixture fail on the move succeeding. With the reverse call removed, the undo test and the fixture's undo step fail.
- **Mock:** with its check removed, or its all-or-nothing wrapper removed, the fixture and the Playwright case in `spaces-management.spec.ts` fail.

**Suites:**
- the whole workspace under nextest (three partitions);
- clippy;
- the `SQLX_OFFLINE` check;
- vitest over `src/lib`, `src/hooks`, `src/stores` and the touched components;
- typecheck and lint;
- the manual prek hooks;
- eleven related Playwright specs.
