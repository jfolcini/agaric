# Session 2548 — Settings › Properties docs say what the view does (#5736)

#5736 item 6 asked for a real-lane spec of renaming a key, changing a type and
renaming a select option in Settings › Properties. None of the three exists: the
view creates a definition, deletes an unused one, and edits a select key's
options as JSON, and no command renames a key or changes a type. The maintainer
chose to correct the docs and track the capabilities in #5841.

**Docs corrected:**
- `docs/features/properties.md` § Where to manage definitions: what the view
  offers, with the built-in and `todo_state` locks, and a pointer to #5841.
- The "Type changes are destructive" pitfall is deleted; there is no type change.
- The select-options pitfall: editing the options leaves existing values on
  their old text (`update_property_def_options_inner` counts the orphans and
  keeps them).
- `docs/features/views.md`, the Settings › Properties line.

**Checked against:** `PropertyDefinitionsList.tsx` (`LOCKED_PROPERTY_OPTIONS`,
`NON_DELETABLE_PROPERTIES`), `delete_property_def_inner`'s refusal while any
block uses the key, and the property commands in `bindings.ts`.
