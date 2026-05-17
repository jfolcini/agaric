<!-- markdownlint-disable MD060 -->
# Search

Agaric ships with three complementary search surfaces:

- **In-page find (`Ctrl+F`)** — browser-style find-in-page toolbar that highlights matches in the current page (this surface; see [In-page find](#in-page-find) below).
- **Find across pages (`Ctrl+Shift+F`)** — the full-text-search view that scans every block and page title in the current space.
- **Palette (`Cmd/Ctrl+K`)** — quick navigation across pages, tags, and recent blocks. (Reserved for PEND-51.)

For the across-pages surface: open the panel from the sidebar (or with `Ctrl+Shift+F`), type a query of three or more characters, and results stream in grouped by page. Matches inside snippets are highlighted; the page header doubles as a navigation target so you can jump straight to the parent. The same panel exposes the legacy `+ Page` and `+ Tag` filter chips while the inline filter syntax is in flight.

For an in-app reference, click the `?` button in the search toolbar — it opens a help dialog mirroring the section list below.

## In-page find

`Ctrl+F` (or `Cmd+F` on macOS) opens a thin toolbar anchored at the top of the page. It highlights every match in the currently-rendered page (Journal, PageEditor, …) in real time as you type. The current match gets a stronger accent and the page auto-scrolls to keep it in view.

### Bindings

| Key | Action |
|---|---|
| `Ctrl+F` | Open the in-page find toolbar. The current text selection (if any) seeds the query; otherwise the previous query is restored. |
| `Ctrl+Shift+F` | Open the find-across-pages view (formerly the only `Ctrl+F` target). |
| `F3` / `Shift+F3` | Next / previous match — works while the toolbar is open, even with focus outside the input. |
| `Enter` / `Shift+Enter` | Next / previous match — when the toolbar input is focused. |
| `Esc` or the toolbar `✕` button | Close the toolbar; focus returns to the element you were on before. |

### Toggles

The toolbar exposes the same toggle row as the across-pages search view so the two surfaces feel coherent:

- **`Aa` — Match case.** Disabled by default. ASCII letters fold via `String.prototype.toLocaleLowerCase` (Unicode-safe in modern engines).
- **`Ab|` — Whole word.** Restricts matches whose boundary letters are word chars (`[A-Za-z0-9_]`). Wraps around literal queries and post-filters regex matches.
- **`.*` — Regular expression.** Uses the JavaScript native `RegExp` engine. Compiles with the `gu` flags by default (`giu` when case-insensitive). Inline `(?s)` / `(?m)` flags are supported per pattern.

Matches do NOT span block boundaries — each ProseMirror text node is searched independently. A query like `end of paragraph 1 start of paragraph 2` will not match across the boundary, same as VSCode's editor.

### Regex caps

Because JavaScript's `RegExp` is backtracking-based, an adversarial pattern could otherwise hang the page. The toolbar applies three caps to bound the worst case:

1. **Pattern length** — patterns longer than 1 KB reject with an inline error.
2. **Text-node length** — text nodes longer than 10 KB are skipped in regex mode. The toolbar surfaces a "{n} long passages skipped" notice once per walk.
3. **Cooperative chunking** — the matcher walks the DOM in 50-node batches via `requestIdleCallback`, yielding between chunks. Typing again before the walk completes aborts the in-flight pass.

For long pages, anchor your regex (`^foo`, `bar$`, or `\bword\b`) to keep matches fast.

### Regex differences between surfaces

The in-page find toolbar and the find-across-pages view use different regex engines, with different feature sets. **This is a known limitation.** Patterns may behave differently in the two surfaces:

- **In-page find** uses JavaScript's native `RegExp`:
  - Supports lookaround (`(?=…)`, `(?<=…)`, `(?!…)`, `(?<!…)`).
  - Supports backreferences (`\1`, `\k<name>`).
  - `\b` / `\d` / `\w` are Unicode-aware by default (we set the `u` flag).
  - Backtracking-based — the caps above bound worst-case time.
- **Find across pages** uses the Rust `regex` crate (when PEND-55's regex mode lands):
  - Linear-time guaranteed (no catastrophic backtracking).
  - **No lookaround**, **no backreferences**.
  - `\b` is ASCII-only by default; use `(?u:\b)` for Unicode word boundaries.

Pattern portability between the two surfaces is roughly the intersection of these feature sets. If you're going to share a pattern across surfaces, stick to the Rust subset.

## Filter syntax

<!-- Section reserved for PEND-54 (inline filter syntax + glob/tag). -->

## Toggles

<!-- Section reserved for PEND-55 (toggle row + history). -->

## Regex syntax

<!-- Section reserved for PEND-55 (toggle row + history). -->

## Boolean operators

<!-- Section reserved for PEND-55 (toggle row + history). -->

## Tips

<!-- Section reserved for PEND-55 and later follow-ups. -->
