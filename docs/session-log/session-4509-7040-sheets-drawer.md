# Session 4509 — one width for the block sheets, labelled drawer footer rows, Pages rows in step

Part of the #7040 UI review, items O3, O7, P5 and P11 (maintainer decision 23).

**What shipped**

- **One sheet width (O7).** Block properties opens at Block history's 512 px; it was 384.
- **Plain property names (O7).** `PropertyFieldLabel` (in `PropertyField.tsx`) writes a property's name as muted text with an icon for a built-in, not a bordered chip, in the drawer and the page's Properties table.
- **Dates read as dates (O7).** The built-in Due and Scheduled fields show "Nov 26" at rest (the year when it isn't this year) and the ISO date while focused for editing; the stored value is unchanged. `useDateInput` returns the display value and a focus handler; only `PropertyField` opts in.
- **Pages rows in step (P5).** On a touch phone a namespace child shows no bin, as the top-level rows already didn't (delete is in the page's ⋮). PageRow's checkbox, bookmark and bin use `hover-reveal` instead of three hand-rolled copies. The loading skeleton is one list card of divided rows, where the list sits.
- **Labelled drawer footer (P11).** Sync and Settings are two sidebar rows, the nav rows' component and height, with the sync state in words after "Sync": Offline, Syncing..., No devices paired, Failed (in the destructive tone), or the last-synced line. The sidebar's dot is gone; the phone header's drawer button keeps its own. In the desktop rail both fold to icons with their tooltips. New key `sidebar.syncStateFailed` in every locale.

**False premises in the issue**

- O3: the block date picker is a Radix dialog whose overlay already dims the whole window, sidebar and header included. The journal header's calendar is an anchored dropdown that dims nothing by design (#151). No change.

**Left as they are**

- The page Properties table's date editor and custom date-like keys still show ISO: its blur skips the date handler when the value is untouched, so a focus-only display would stick.
- The date field's parse preview still prints the ISO result while you type.
- Tree leaves have no bookmark toggle on desktop, which PageRow has; the item named only the bin.
- Offline, the Sync row's accessible name is "Offline" while it reads "Sync Offline"; the row is `aria-disabled` then.

**Review fixes**

- `syncDotClass` lost its `hasPeers` branch: its one caller left, the phone header, renders only when paired. `theme-contrast.test.ts` drops the unreachable no-peers pair and checks the idle and syncing dots on the header's background.
- `docs/features/sync.md` and the comments in DeviceManagement, useSyncEvents, useSyncTrigger, AppSidebar and App stopped describing the sidebar dot.

**Tests**

- e2e (mock lane): new `sheets-drawer-rows` — the shared sheet width, the plain label and the compact date, the skeleton card, a namespace child's bin hidden on a phone, the footer rows named and as tall as the nav rows. Each test red on the old code with the predicted assertion.
- vitest: `LoadingSkeleton`'s card, `PropertyField`'s ISO on focus, AppSidebar's failure row and the tooltip beside an expanded row.
- Falsified one mutation at a time: the sheet width, a border on the label, the raw ISO at rest, the old skeleton, the phone bin, the empty state word, the footer row's height, the Settings label; the reviewer re-ran five.
- **Edited to the new markup:** AppSidebar.test (the footer rows and their state words instead of the dot), App.test's three sync-dot tests (the state words), BlockPropertyDrawer.test and BuiltinDateFields.test (512, the label slot, the compact date at rest), LoadingSkeleton.test (h-4), `e2e/helpers` `syncButton`, `sync-events`, `sync-happy-paths` (the state words), `app-chrome` (two stacked rows, not one row of icons), the bridge spec `agenda-projected-repeat` (the drawer's compact date).
