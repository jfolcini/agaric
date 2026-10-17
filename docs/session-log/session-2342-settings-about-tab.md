# Session 2342 — The Settings tab in the Help group is called About

#5714: the Help group's first tab was also labelled "Help", so the Settings
sidebar read "Help › Help". The maintainer approved renaming the tab. It is
now "About" (Report a bug and Updates). The tab id stays `help`, so
`?settings=help`, `agaric://settings/help` and the palette's deep links are
unchanged. Only the English catalogue defined the label.

The existing tests built the tab name from `t('settings.tabHelp')`, so they
passed with either label. A new SettingsView test asserts a tab named
"About" inside the Help group and no tab named "Help"; it failed on the old
label. The settings Playwright spec looks the tab up by its new name.

Gates: vitest over `src/components/pages`, `src/components/settings` and
`src/lib/i18n` (1,389 tests), `npm run typecheck`, `npm run lint`, and the
settings Playwright specs (20).
