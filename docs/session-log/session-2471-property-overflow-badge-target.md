# Session 2471 — The `+N` property badge opens its own block's drawer

#5736's property specs found this. A block's chip row folds the properties
past `INLINE_PROPERTY_LIMITS` into a `+N` badge, and the badge opened the
wrong drawer:
- with no block being edited, clicking it opened nothing;
- with another block being edited, it opened that other block's drawer,
  which showed "No properties set".

**Cause:** the badge sent `OPEN_BLOCK_PROPERTIES` through the command bus,
which acts on the focused block. The badge keeps focus where it was, so it
never focused its own row.

**Fixed:** the badge calls `onShowProperties(blockId)` with its own row's id,
the path the context menu's Properties item already takes.
`SortableBlock` passes the action down from `useBlockActions()`, as it does
`onTogglePriority`.

**Tests:**
- **`e2e/property-overflow-badge.spec.ts`** seeds eight properties on a Quick
  Notes block. It clicks `+N` with no block being edited, then with another
  block focused. Each time the drawer must list `k8`, a property past the
  inline cap. Both tests were red against the unfixed code.
- **`BlockInlineControls.test.tsx`**: the badge's click, Enter and Space tests
  asserted that the bus event fired, which pinned the bug. They now assert
  the action receives the row's id, and they were red against the unfixed
  code.

**Not checked:** the due and scheduled date chips also go through the
focus-keyed bus. Clicking one on a block that isn't being edited may open
the picker for the focused block. That needs a reproduction before a fix.

**Ran:**
- the new spec with `--repeat-each=3`;
- the property and drawer specs;
- vitest on `src/components/editor` and `src/components/editor-toolbar`;
- `npm run typecheck`.
