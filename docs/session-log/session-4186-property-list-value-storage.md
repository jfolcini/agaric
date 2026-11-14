# Session 4186 — a property can hold a list: storage, engine and op (#6741, PR 1 of 4)

The first of the four pull requests in the design the maintainer approved on #6741 ("Design for option 3 (a list value in the one row)"). It adds the storage and nothing a user can reach: no screen offers the flag, and a key that no definition declares `multiple` refuses a list, so no list can exist on a device after this PR alone.

## What shipped

- **Migration 0133.** `block_properties` rebuilt with `value_list` (a non-empty JSON array, CHECKed) as a sixth arm of `exactly_one_value`, its six indexes and 0089's `spaces_register_is_space` trigger created again; `property_definitions.multiple`.
- **Engine format 7**, in the same commit. `PropertyValue::List` is one plain `LoroValue::List` in the slot a single value occupies, so two devices' concurrent writes of one list keep the later one whole. A definition's root map carries `multiple: true` only when set, so a definition written under format 6 is still the map the writer builds.
- **Ops.** `SetPropertyPayload` and `PropertyValueFields` carry an optional `value_list`, `PropertyDefState` an optional `multiple`, each left out of the stored text when empty or false. No new op type, table, store, queue or sync message.
- **Validation.** A list is taken only by a key its space declares `multiple`, and such a key takes nothing else. Each item is held to the definition's type; a ref item is checked against the holder's space like a single ref. A boolean is never a list.
- **Projection.** A list lands in `value_list` whatever the key's type. Under a `ref` key it keeps only the items whose target has a `blocks` row; `project_dropped_refs` projects a holder again once a missing item's target appears.
- **Purge.** `cache::purge_refs_from_lists` takes the purged ids out of the lists of refs holding them, beside the `value_ref` delete at each of the three purge chains.
- **Undo, recovery, space move.** `prior` carries the list for set and delete; disaster recovery restores lists and `multiple` from the engine, and the op-log replay writes a list op as a list row; a cross-space move treats `multiple` as part of a definition's identity and its drop records the list.
- **Mock and conformance.** The mock stores the list, validates it as the backend does and carries it through undo; `property_list.json` is the backend-authored fixture.

## Decisions and traps

- **The wire leaves the new fields out when empty**, as the op does: `PropertyRow.value_list` and `PropertyDefinition.multiple` are optional in the bindings. Every existing conformance fixture and frontend fixture keeps its bytes; the regenerated bindings split those three types into `_Serialize` / `_Deserialize`, which specta does for any type with `skip_serializing_if`.
- **A list lands in `value_list` under any key**, declared or not, and its items are filtered as refs when the key's type is `ref`, whether or not the definition is `multiple`. The projection therefore needs only the `key → value_type` map it already had.
- **The list's JSON text is written by one function**, `PropertyList::to_json`, and read through a `sqlx::Decode` on `PropertyList`, so no caller parses the column.
- **`set_property_inner` keeps its positional signature** (it has several hundred callers); a list goes through `set_property_list_inner`, which the `set_property` command picks when the bundle carries one. The same split is in the engine: `set_property_value_in_tx` takes the six slots, and the positional functions delegate to it.
- **`fit_reverse_to_declared_type` needs no list case.** A falsification showed an early return for lists there, and in the mock's twin, was dead: no type converts a list, so it already falls through unchanged. Both were deleted.
- **The readers of PR 2 to 4 are untaught on purpose.** `conversions` (type change) and `unfit_values` read the five scalar columns and would show a list row as an empty value that does not fit; the import paths refuse a single value under a list key with the warning they give any refused value.
- **A `git stash` during a background build** reverted the tree under a running `cargo nextest`. That run was thrown away and repeated.

## Existing assertions edited

`create_property_def` takes a fifth argument, so the eight frontend tests that pin its exact call shape gained `multiple: null` (`BlockPropertyEditor.test.tsx` twice, `PagePropertyTable.test.tsx` three times, `PropertyDefinitionsList.test.tsx` three times). The hand-ported `validateSetPropertyPayload` in `BlockPropertyEditor.test.tsx` counts `value_list` among the value fields, as `validate_set_property` now does. `the_definition_writer_refuses_a_builtin_and_a_type_change` gained the refusal of a change to `multiple`.

## Left for the later PRs

PR 2: defining and editing (the flag in Settings, *Change type…* to and from a list, the don't-fit rules, editors and chips, the MCP tool, the space file). PR 3: the any-item rule in filters, grouping, the query table. PR 4: import, export and the user documentation. An undo that restores a multi-select list after one of its options was renamed keeps the old option name; `forward_property_key` follows the rename for a single value only, and PR 2's multi-select is where that matters.
