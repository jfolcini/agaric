# Session 3177 — Rename a select option; one row per option (#5841 S4)

Slice S4 of #5841, the last one, built on S1 (#6187), S2 (#6196) and S3 (#6204). The maintainer decided its open questions in issue comment 6517465507.

**Shipped:**
- **The op.** `rename_property_option { space_id, key, old_option, new_option }` renames in place: the definition's options keep their order, and every value of the space's blocks equal to the old name gets the new one, the Trash included. It writes the existing roots, so there is no format bump.
  - The release hold since S1 covers the one thing that needed it: an S3 build cannot parse this op.
- **Refusals.** Built-ins (`priority`, `todo_state`) and the app's own keys; a blank name; renaming onto itself; an undeclared key or a non-select; an old name that is not an option. Renaming onto an existing option, or onto a name some block still holds, is refused, so the undo's swap is exact.
- **Undo.**
  - It renames back whatever holds the new name now, so a later edit on a renamed block survives.
  - It follows a later rename of the key. The undo op records the key it renamed under, so replay, sync and redo agree.
  - It is refused with the reason when the definition was deleted or merged away, or the old name is an option or a held value again.
  - Undoing an earlier set of the old name lands on the new name. The mapping is one way: a value equal to the new name from before the rename is a different value.
- **UI.**
  - Settings › Properties loses its raw-JSON options editor. It reuses the page property table's editor, with one row per option: add, remove, reorder, Save.
  - Both editors get an inline Rename per saved option, with an Undo toast. After a rename from the page table, the open page reloads its values.
- **History** labels the op "Property option renamed", with the summary `key: old → new`.
- **Mock.** It mirrors the above and is pinned by three fixtures: `property_option_rename`, `property_option_rename_undo_maps_value` and `property_option_rename_undo_follows_key`.

**Accepted, not fixed:**
- **Two devices, last writer wins.** A peer's concurrent options edit can leave the new name outside the options, and two different renames can leave both names on blocks. Both stay visible, and the devices agree.
- **A replay at boot renames a peer value imported between the op and a crash.** That value then syncs as a normal write, so the devices still converge.

**Review.** An independent review found nothing blocking.
- **Fixed here:** the inline rename now trims the new name before checking whether it is taken and before sending it, as Add already did. A padded copy of an existing option used to get through.
- **Left for the follow-up PR:** a rename from the page table reloads every open page through the sync path, which also re-anchors each page's undo, so a pending redo is lost. The op is space-keyed and shifts no page's undo positions.

**Release hold:** it ends when this PR merges.

**Ran:**
- clippy clean.
- Targeted nextest over agaric-store, agaric-engine, the sync tests, the `commands` and `command_integration` binaries, and the history/property/undo lib tests: 4651 passed.
- `conformance_fuzz`.
- Typecheck, plus vitest over the mock, properties, history and hooks.
- Playwright: 142 property, history and settings specs.
- The bench group was smoke-run at small sizes only; the weekly lane runs the real sizes.
- Not run here: `e2e-tauri/property-option-rename.e2e.ts`, which runs in CI.
