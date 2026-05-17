<!-- markdownlint-disable MD060 -->
# Search

Agaric ships with three complementary search surfaces:

- **In-page find (`Ctrl+F`)** — browser-style find-in-page toolbar that highlights matches in the current page (this surface; see [In-page find](#in-page-find) below).
- **Find across pages (`Ctrl+Shift+F`)** — the full-text-search view that scans every block and page title in the current space.
- **Palette (`Cmd/Ctrl+K`)** — quick navigation across pages, tags, and recent blocks. (Reserved for PEND-51.)

For the across-pages surface: open the panel from the sidebar (or with `Ctrl+Shift+F`), type a query of three or more characters, and results stream in grouped by page. Matches inside snippets are highlighted; the page header doubles as a navigation target so you can jump straight to the parent. Structured filters can be typed directly into the input (`tag:#urgent path:Journal/*`) or added via the `+ Filter ▾` button above the chip row — see [Filter syntax](#filter-syntax) below.

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

The find-across-pages view supports a small filter vocabulary that mixes freely with free-text and the FTS5 boolean operators. The query string is the canonical model — every chip the UI renders is a projection of the parsed AST, and copy-pasting a query reproduces every filter exactly.

### Token vocabulary

| Token | Meaning | Notes |
|---|---|---|
| `tag:#name` | Block carries the tag `name`. | Repeats AND-combine. |
| `#name` | Bare alias for `tag:#name`. | Equivalent shape. |
| `path:GLOB` | Page-name glob include. | Comma-separated entries OR-combine inside one token. |
| `not-path:GLOB` | Page-name glob exclude. | AND-joined with `path:`. |
| `"phrase"` | Quoted phrase passed verbatim to FTS5. | Bypasses the trigram length filter. |
| `AND` / `OR` / `NOT` | Boolean operators (uppercase, FTS5 syntax). | Outside filter tokens. |

### Glob matching

Page-name globs use SQLite's native `GLOB` syntax against `pages_cache.title`:

- `*` — zero or more characters.
- `?` — exactly one character.
- `[abc]` / `[a-z]` — character class.
- `{a,b,c}` — top-level brace expansion (no nesting; max 64 expanded patterns per token).

Bare tokens without metacharacters (e.g. `path:Journal`) wrap automatically to `*Journal*` for a substring match. Globs are **case-insensitive** by default — the SQL clause uses `LOWER(pages_cache.title) GLOB LOWER(?)`.

### Worked examples

| Query | Effect |
|---|---|
| `TODO path:Journal/2026-* tag:#urgent` | TODO mentions in 2026-Journal pages, tagged urgent. |
| `tag:#meeting not-path:Archive/**` | Meetings outside the archive subtree. |
| `path:{Journal,Notes}/*` | Pages in either `Journal/` or `Notes/`. |

### Behavioural error states

- `path:[unclosed` → invalid chip with `InvalidGlob: unbalanced bracket`.
- `path:{a,{b,c}}` → invalid chip with `InvalidGlob: brace nesting not supported`.
- `tag:` (no value) → invalid chip with `tag: value required`.
- `foo:bar` (unknown prefix) → invalid chip with `unknown filter key 'foo:'`.

Invalid chips render with destructive styling, an `aria-invalid` marker, and the typed error as the hover tooltip. The frontend keys on the `InvalidGlob:` prefix returned by the backend so the same message can also originate from a server-side rejection.

### Migrating from the old chip UI

PEND-54 replaced the legacy `+ Page` and `+ Tag` popover chips. There is one **documented behavioural change**:

- The old `+ Page` chip filtered by a single exact page ULID. The new `path:` filter matches against the page **title** with substring semantics by default. `path:Project Alpha` matches `Project Alpha`, `Project Alpha 2`, and `Old Project Alpha`. To preserve exact-page-filter semantics, use the page's inline link form `[[Project Alpha]]` in the query (FTS5 matches verbatim) or pair `path:` with a unique substring.

The new model is a strict superset of every other previous use case — copy-paste of a query string round-trips, and the chip row is recomputed from the AST on every keystroke.

## Toggles

<!-- Section reserved for PEND-55 (toggle row + history). -->

## Regex syntax

<!-- Section reserved for PEND-55 (toggle row + history). -->

## Boolean operators

<!-- Section reserved for PEND-55 (toggle row + history). -->

## Tips

<!-- Section reserved for PEND-55 and later follow-ups. -->
