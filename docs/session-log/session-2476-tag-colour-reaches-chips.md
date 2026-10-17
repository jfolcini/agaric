# Session 2476 — a tag's colour reaches its chips

The #5736 e2e sweep found that a colour picked for a tag in the Tags view
never showed anywhere but the Tags view.
- **The static chip** (`renderTagRef`) never read tag colours.
- **The editor chip** wrote `${color}20` and `color` directly. For a preset
  token such as `accent-rose` that is invalid CSS, so the browser dropped it
  and the chip stayed grey.

**Changed:**
- **`tagColorStyle(value)`** in `tag-colors.ts` is the one style for a
  coloured chip or badge. It returns three properties:
  - `--tag-color`: the accent token or custom hex.
  - text: the colour mixed half toward the ink, because bare rose on a white
    page is about 3:1;
  - a 15% tint for the background.

  An unset colour returns `undefined`, so uncoloured chips keep their CSS.
- **The static chip** is a small component that reads colours through
  `usePreference`, so it repaints when the colour changes.
- **The editor chip** sets the same three properties.
- **The Tags view badge** uses the same style.
- **Deleted:** `tagColorForeground`, `pickReadableForeground`,
  `parseHexToRgb`, `ACCENT_FOREGROUND` and the presets' `fg` field, which had
  no users left, along with their tests.
- **Header comment corrected:** `useTagColors` does write the tag's `color`
  property, but nothing reads it back.

**Contrast:** measured in Chromium against the built CSS.
- Light and Dark, with and without `prefers-contrast: more`: coloured chips
  clear AA and beat the uncoloured chip.
- The old Tags-view badge was below AA for blue, violet, rose and slate.
- Some alternate themes are lower:
  - Solarized Light: amber 3.06, up to blue 3.95.
  - One Dark Pro and Solarized Dark under `prefers-contrast: more`: down to
    3.05.
- The repo checks chip text against AA only in Light and Dark, and the
  uncoloured chip is already below AA in Dracula, One Dark and Solarized
  Dark.
- A custom hex no longer gets black or white text picked for it. An extreme
  one drops to about 3.9:1 (near-white in Light) or 2.9:1 (near-black in
  Dark).

**Spec:** `e2e/tag-chip-color.spec.ts`. It picks rose for `work` in the Tags
view, then checks the chip's painted colour in four places:
- the static chip;
- the editor chip;
- the tag page's Blocks list;
- the static chip again, after following that list's link back.

The expected colour comes from an in-page probe styled with the same formula.

**Shown red:**
- **The spec, before the fix:** the static chip painted the default grey.
- **The spec, with only `tagRef.tsx` reverted:** the static chip.
- **The spec, with only `tag-ref.ts` reverted:** the editor chip.
- **The repaint unit test,** with the subscription swapped for a one-time
  read.
- **The helper tests,** with the unset guard dropped and with the raw value
  in `--tag-color`.

**Ran:**
- the new spec with `--repeat-each=3`;
- the tag, link and chip specs;
- vitest on the touched files and every chip and preference test;
- `npm run typecheck`, oxlint, oxfmt, knip and prek on the changed files.
