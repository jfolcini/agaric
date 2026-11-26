# Appearance

How notes look: the text size, right-to-left text, printing, and your own stylesheet. Everything here is a per-device setting under Settings › Appearance and never syncs.

## Note text size and headings

*Note text size* (Small, Medium, Large: 14, 16, 18 px) sets `--agaric-font-size` on `<html>` (`src/hooks/useFontSize.ts`). Headings are multiples of it, so h1 to h3 keep their rank over body text at every size: from the `sm` breakpoint up h1 1.5×, h2 1.25×, h3 1.125×, h4 1×, h5 0.875×, h6 0.75×, which at Medium is 24 / 20 / 18 / 16 / 14 / 12 px; below it, on a phone, they step down to 1.25×, 1.125×, 1.0625×, 0.875×, 0.875×, 0.75×. The editor, the static render and page mode read the same `--heading-N-size` tokens in `src/index.css`, as do the first-line boxes the gutter controls centre on. `e2e/heading-font-size.spec.ts`. A table's cells, a code block and a callout's label sit a step under body text at 0.875× (`text-block-sm`), 14 px at Medium, read or edited. A block's chips (priority, dates, repeat, properties, counts) grow with their icons at 0.75× (`text-block-chip`), 12 px at Medium; page mode draws them as text at 0.6875×. A block's text in a list (the agenda, the due and done panels, search results, linked, unlinked and outgoing references, history and its diff, trash, tagged items, query results), an embedded block and a reference's peek take `text-block-sm` too; page names in navigation (the Pages list, the sidebar, tabs, breadcrumbs) and the app's own words stay fixed. `e2e/font-size-scaling.spec.ts`.

## Right-to-left text

A block's content runs in the direction of its first strong letter: its content root carries `dir="auto"` (the static render, an embedded block's row, the block's editor, and each page-mode block's text). An Arabic, Hebrew or Persian block sits on the right and mirrors through logical properties: a list's markers (`.1`, on the right, at rest and while edited), a numbered or bulleted block's marker, a quote's and a callout's bar, a callout's icon and label, and a table's column order, whose row handle, *Add column* and `Alt+Shift+←` / `→` follow it. Code stays left to right (`dir="ltr"`). A chip carries its own `dir="auto"`, so an English page title at the start does not turn a Hebrew block left to right. The task checkbox, the metadata chips under the text, the gutter and the rest of the app stay left to right, and an English block is laid out as before.

Each paragraph inside a block still runs and aligns in its own direction (`unicode-bidi: plaintext`), so a block holding an Arabic and an English paragraph shows each on its side in its editor and in page mode (the static render runs a block's paragraphs on one line); the block's own direction, from its first letter, decides its markers and bars. Edit as Markdown runs each line in its own direction the same way, and block text in a row of search, the palette, the references and the agenda takes `bidi-plaintext`, so Arabic mixed with an English word or a link reads in order and a truncated line keeps its start.

The arrows move the way they point: in an Arabic block `←` walks towards its end, across revealed Markdown markers and chips, and past it into the next block, and `→` past its start goes to the block before. Page mode's editor runs left to right, which ProseMirror reads to step over a marker or a chip on Chromium, so the Markdown reveal steps through right-to-left text there itself. A callout's `> [!NOTE]`, shown while the cursor is on its first line, reads left to right at the line's start and does not decide the block's direction. `e2e/rtl-text.spec.ts`.

## Printing

A print stylesheet (`@media print` in `src/index.css`) prints the page alone: no sidebar, header, page toolbar, formatting toolbar or gutter controls, and the app's fixed-height scroll boxes let the page run onto as many sheets as it needs. The page prints on the light palette whatever the theme (`useTheme` swaps on `beforeprint`). A long page prints whole in either editing mode: page mode renders every block, and block mode fills in the rows it keeps as placeholders off screen when `beforeprint` fires (`useViewportObserver`); rows past the *Show more* boundary of a very long page stay out. A heading is kept on the sheet of what follows it, and an external link prints its address after its text. *Print…* in the page menu's *Export* submenu calls `window.print()`; it is absent on Android. On macOS Tauri routes that call through its own print command, which the desktop capability allows (`core:webview:allow-print`). Not yet run on WKWebView or WebView2: whether the dialog opens and offers PDF, and whether `beforeprint` fires there (without it a dark theme prints dark and block mode prints only the rows near the screen); the checks are on #6514 and #6515. `e2e/print-page.spec.ts`.

## Custom CSS

Settings › Appearance › *Custom CSS* takes a stylesheet of your own, written into one `<style>` element after the app's stylesheet (`src/hooks/useCustomCss.ts`), so your rule wins a tie. The switch beside it turns the stylesheet off; it is read before the stylesheet is applied. If a stylesheet hides the app, open `agaric://settings/safe-mode`: it turns the switch off and opens Settings › Appearance, with the stylesheet kept for you to fix. Android has no such link yet ([agent-access.md](agent-access.md#agaric-deep-links)). A remote `@import` or web font does not load: the app's content security policy blocks both.

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
- `--brand`, `--brand-foreground`: the logo red on the capture button and the graph's current page
- `--border`, `--input`, `--ring`: borders, input borders, focus rings
- `--sidebar`, `--sidebar-foreground`, `--sidebar-border`, `--sidebar-accent`, `--sidebar-accent-foreground`: the sidebar

Radius:

- `--radius`: the base corner radius every control and surface derives from

Typography:

- `--font-sans`: the interface and note font
- `--font-mono`: code

Spacing:

- `--indent-width`: the indent per nesting level
- `--block-row-gap`: how far an indent guide reaches above its block
<!-- custom-css-tokens:end -->

Not offered: a file watched on disk, a theme gallery, a font picker, syncing the stylesheet.
