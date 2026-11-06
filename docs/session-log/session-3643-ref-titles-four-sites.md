# Session 3643 — four more labels follow their ref target's title

#6427 fixed the ref property picker. Four more places had the same shape: they read a title from the resolve cache through the stable `resolveTitle` function, so under the React Compiler their labels stopped updating once mounted. A title that arrived later, or a rename by an agent or a synced device, never showed.

- Advanced query filter pill (`FilterGroup`): selects its summary string from the store, so a `LinksTo`/`LinkedFrom`/tag chip re-renders when its title changes. It still fetches nothing for an uncached id.
- Add-filter ref value's "selected" line (`PropertyRefValueInput`): selects the title string. It doesn't use `useRefTitle` because that hook's fetch would send a `batch_resolve` the existing `AddFilterPopover` tests do not mock.
- Change-type values preview (`ChangePropertyType`): a per-row `ValueText` reads each ref through `useRefTitle`. The row text stays one node (`a → b`), which the existing tests read.
- Move-to-space values list (`SpaceMoveConfirmDialog`): a `RefTitle` reads each ref through `useRefTitle`.
- Tests: `FilterGroup.test.tsx` and `PropertyRefValueInput.test.tsx`, each red without its fix on the `New title` assertion. The two dialogs have no dedicated test: a red one needs the existing files' mock seeding and dialog-opening helpers (the move dialog's alone is about a hundred lines), and the mechanism is the one the #6427 real-backend spec shows.
- Ran: vitest over `src/components/{AdvancedQuery,PageBrowser,properties,pages}`; typecheck; oxlint; oxfmt.
