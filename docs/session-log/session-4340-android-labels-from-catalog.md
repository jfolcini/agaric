# Session 4340: the Android scripts read their labels from the catalog

The scheduled `android-launch` lane failed (run 44309605975). `scripts/android-e2e-safe-area.mjs` waited for the welcome dialog's "Get Started" button, which #6908's sentence-case sweep renamed "Get started". The device dump showed "Get started | Close" on screen, so the app was fine and the script's copy was stale.

## What shipped

- **`scripts/android-ui-labels.mjs`** exports `english(key)`, the value of `key` in `src/lib/i18n/common.ts`. Node strips the catalog's types on import, so no build step is needed. It throws on a missing key, so a renamed key fails loudly instead of matching nothing.
- **`android-e2e-safe-area.mjs`** reads the hamburger's label, the drawer markers and the first-run dismiss buttons through it. Its failure message no longer says the label is an unchecked copy.
- **`android-e2e-persist.mjs`** had the same stale "Get Started" and a copied "Add block"; both now come from the catalog.
- No other script matches the app's UI by an English string. The emoji group names in `generate-emoji-data.mjs` are Unicode's own, not the app's.

## What ran

- Matching logic, red then green: the old list `['Get Started', 'Got it']` does not contain the on-screen `Get started`; the list read from the catalog does.
- Both scripts load past their imports and stop at the missing `adb`. `english()` returns the catalog's values and throws on an unknown key.
- oxlint and oxfmt over the changed scripts.
- Not run: the emulator. The nightly `android-launch` lane is the check.
