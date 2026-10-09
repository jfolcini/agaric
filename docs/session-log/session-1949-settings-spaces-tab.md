# Session 1949 — a Spaces tab in Settings, with a launch space (#5362)

Spaces were managed in a dialog behind the last item of the space switcher,
Settings › General carried a "Reset spaces onboarding" row whose only job was
to bring back a banner in that dialog, and there was no way to choose the
space the app opens in.

What shipped:

- `src/components/settings/SpacesTab.tsx`, after General in the Workspace
  group: a short explanation of spaces, an *Open on launch* Select (Last
  used, or one space), the space rows (rename, accent, delete) and the create
  form. The row components moved from `SpaceManageDialog/` to
  `settings/SpacesTab/`.
- `PREFERENCES.defaultSpace` is per device. `reconcileCurrentSpaceId` opens
  the default on the first reconcile after launch, keeps the current space
  after that, and falls back to the default before the alphabetical first
  when the current space disappears. When the default space is gone (deleted
  here or on another device) the setting returns to Last used. The "space
  was deleted" toast now fires only when the previous space really is gone.
- The switcher's *Manage spaces…* and *Create another space* open Settings ›
  Spaces and close the mobile sidebar.
- Deleted: `SpaceManageDialog`, `SpaceOnboardingHint`, `ResetOnboardingRow`,
  the `spaceOnboardingSeen` preference and their i18n keys. The mock gains an
  opt-in `__mockWorkSpace` seed for the reload e2e.
- e2e: setting a default space survives a reload; the space, tag and link
  specs open the tab instead of the dialog.

Left as is: two Rust comments (`commands/spaces.rs`, `blocks/crud.rs`) still
name the dialog; they go with the next backend doc PR.

Verified: builder and reviewer falsified 21 + 17 cases on copies, including
each launch/fallback branch, both arms of the preference reset and of the
toast, and the reload e2e (all red, restored and `cmp`-checked). Full vitest
20,750 passed; Playwright 41/41 on spaces-management, tags-lifecycle,
link-chip-lifecycle, settings, settings-phone and spaces-coverage;
typecheck, knip, oxlint and oxfmt clean.
