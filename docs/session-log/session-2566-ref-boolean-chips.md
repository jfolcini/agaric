# Session 2566 — ref and boolean properties get chips, and adding a ref saves (#5736)

#5736's Properties items 2 and 3 asked for e2e specs of the boolean toggle and of a
ref property following a rename. Neither showed on the block: the chip row
(`extraPropertiesOf`) flattened only text, date and number, and the drawer edited a
boolean as a text box. The maintainer chose to build both.

**Built:**
- `InlinePropertyChip` renders each inline property. A ref chip shows the target's
  title from the resolve store, so a rename shows without a remount, and its value
  is a button ("Open {title}") that navigates through the block's `onNavigate`; a
  boolean chip reads "Key: Yes / No" and opens the drawer. Both count toward the
  chip cap and the `+N` badge, in block mode and page mode.
- The drawer edits a boolean with the checkbox the page Properties table uses.
- Settings › Properties offers `boolean` as a definition type (the backend's
  `validate_property_def_shape` already accepted it).

**Bug fixed:** adding a ref property from the drawer or the page Properties table
always failed on the real backend. `buildInitParams` wrote `{ valueRef: null }`,
which `validate_set_property` rejects for a non-reserved key ("found 0"), while the
mock accepted it. A ref is now a draft row, written only once a page is picked; the
test that pinned the bad write is replaced.

**Not built:** refs to tags. The picker and title resolution are page-only; storage
would take any live block id in the space.

**Shown red:** the ref branch of the projection removed; the chip reading the store
without subscribing (the rename assertion); navigating with the key instead of the
target; the Yes/No inverted; the boolean click wired to the editor; ref and boolean
chips filtered from the cap; the drawer's boolean branch reverted; the all-null
branch put back; `boolean` removed from Settings; and in the e2e spec the boolean
projection, the navigation target and the drawer checkbox.

**Still to land:** a real-backend spec for adding a ref (testing invariant 4; the
mock can't show the rejection), and the mock's missing exactly-one-value check on
`set_property`.
