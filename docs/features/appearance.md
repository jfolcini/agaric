# Appearance

How notes look: the text size, right-to-left text, printing, and your own stylesheet. Everything here is a per-device setting under Settings › Appearance and never syncs.

## Note text size and headings

*Note text size* (Small, Medium, Large: 14, 16, 18 px) sets `--agaric-font-size` on `<html>` (`src/hooks/useFontSize.ts`). Headings are multiples of it, so h1 to h3 keep their rank over body text at every size: from the `sm` breakpoint up h1 1.5×, h2 1.25×, h3 1.125×, h4 1×, h5 0.875×, h6 0.75×, which at Medium is 24 / 20 / 18 / 16 / 14 / 12 px; below it, on a phone, they step down to 1.25×, 1.125×, 1.0625×, 0.875×, 0.875×, 0.75×. The editor, the static render and page mode read the same `--heading-N-size` tokens in `src/index.css`, as do the first-line boxes the gutter controls centre on. `e2e/heading-font-size.spec.ts`.

## Right-to-left text

Each paragraph of block text runs in the direction of its first strong letter (`unicode-bidi: plaintext` on block text and on its paragraphs, list items, headings and table cells), so an Arabic, Hebrew or Persian paragraph sits on the right of its box with its punctuation in place, while English blocks, the gutter controls and the rest of the app stay left to right. A block-mode list item's bullet moves to the right with its text; page mode's list markers stay on the left. `e2e/rtl-text.spec.ts`.

## Printing

A print stylesheet (`@media print` in `src/index.css`) prints the page alone: no sidebar, header, page toolbar, formatting toolbar or gutter controls, and the app's fixed-height scroll boxes let the page run onto as many sheets as it needs. The page prints on the light palette whatever the theme (`useTheme` swaps on `beforeprint`). A long page prints whole in either editing mode: page mode renders every block, and block mode fills in the rows it keeps as placeholders off screen when `beforeprint` fires (`useViewportObserver`); rows past the *Show more* boundary of a very long page stay out. A heading is kept on the sheet of what follows it, and an external link prints its address after its text. *Print…* in the page menu calls `window.print()`; it is absent on Android. On macOS Tauri routes that call through its own print command, which the desktop capability allows (`core:webview:allow-print`). Not yet run on WKWebView or WebView2: whether the dialog opens and offers PDF, and whether `beforeprint` fires there (without it a dark theme prints dark and block mode prints only the rows near the screen); the checks are on #6514 and #6515. `e2e/print-page.spec.ts`.

## Custom CSS

Settings › Appearance › *Custom CSS* takes a stylesheet of your own, written into one `<style>` element after the app's stylesheet (`src/hooks/useCustomCss.ts`), so your rule wins a tie. The switch beside it turns the stylesheet off; it is read before the stylesheet is applied. If a stylesheet hides the app, open `agaric://settings/safe-mode`: it turns the switch off and opens Settings › Appearance, with the stylesheet kept for you to fix. On Android the link is `https://agaric.app/o/settings/safe-mode`. A remote `@import` or web font does not load: the app's content security policy blocks both.

Override a token on `:root`, which beats every theme:

```css
:root {
  --background: oklch(0.97 0.02 85);
  --font-sans: 'Iowan Old Style', serif;
  --radius: 0.25rem;
}
```

To change one theme only, scope the rule to its class on `<html>`: `.dark` (also set with Solarized Dark, Dracula and One Dark Pro), `.theme-solarized-light`, `.theme-solarized-dark`, `.theme-dracula`, `.theme-one-dark-pro`; the light theme has no class.

### What is a promise

The tokens listed below are the compatibility promise: each is defined in every one of the six themes, and none is renamed or removed without a new version of this list and a note in the release. Everything else can change in any release: selectors, class names, `data-*` attributes, the DOM structure, and any token not on the list. `src/lib/__tests__/custom-css-tokens.test.ts` fails when a listed token is no longer defined in a theme or can no longer be overridden.

### Token list, version 1

<!-- custom-css-tokens:start -->
Colour:

- `--background`, `--foreground`: the page ground and its text
- `--card`, `--card-foreground`: cards and settings panels
- `--popover`, `--popover-foreground`: menus, popovers and dialogs
- `--primary`, `--primary-foreground`: primary buttons
- `--secondary`, `--secondary-foreground`: secondary buttons
- `--muted`, `--muted-foreground`: quiet surfaces and secondary text
- `--accent`, `--accent-foreground`: hovered and selected rows
- `--destructive`, `--destructive-foreground`: delete and error
- `--brand`, `--brand-foreground`: the logo red on the journal's today marks and the capture button
- `--border`, `--input`, `--ring`: borders, input borders, focus rings
- `--sidebar`, `--sidebar-foreground`, `--sidebar-border`, `--sidebar-accent`, `--sidebar-accent-foreground`: the sidebar

Radius:

- `--radius`: the base corner radius every control and surface derives from

Typography:

- `--font-sans`: the interface and note font
- `--font-mono`: code

Spacing:

- `--indent-width`: the indent per nesting level
- `--block-row-gap`: the space between blocks
<!-- custom-css-tokens:end -->

Not offered: a file watched on disk, a theme gallery, a font picker, syncing the stylesheet.
