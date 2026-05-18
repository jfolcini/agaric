<!-- markdownlint-disable MD060 -->
# Search

Agaric ships with three complementary search surfaces:

- **In-page find (`Ctrl+F`)** — browser-style find-in-page toolbar that highlights matches in the current page (this surface; see [In-page find](#in-page-find) below).
- **Find across pages (`Ctrl+Shift+F`)** — the full-text-search view that scans every block and page title in the current space.
- **Palette (`Cmd/Ctrl+K`)** — quick navigation across pages and recent blocks (see [Quick palette](#quick-palette) below).

For the across-pages surface: open the panel from the sidebar (or with `Ctrl+Shift+F`), type a query of three or more characters, and results stream in grouped by page. Matches inside snippets are highlighted; the page header doubles as a navigation target so you can jump straight to the parent. Structured filters can be typed directly into the input (`tag:#urgent path:Journal/*`) or added via the `+ Filter ▾` button above the chip row — see [Filter syntax](#filter-syntax) below.

For an in-app reference, click the `?` button in the search toolbar — it opens a help dialog mirroring the section list below.

## Quick palette

`Cmd/Ctrl+K` opens a lightweight dialog (Sheet on mobile) for fast navigation. It complements the find-across-pages view: the palette is for jumping to a page or block you already have in mind; the view is for systematic searches. The palette intentionally has no filter chips and no `Aa` / `Ab|` / `.*` toggles — type, see results, jump.

Behaviour:

- **Empty input** surfaces your recent pages (the same list `SearchPanel` shows). Selecting one navigates to it.
- **Typed query** fires two parallel `searchBlocks` calls in one keystroke window:
  1. A page-only query (`blockTypeFilter = 'page'`, cap 8) that anchors the result groups by page name.
  2. An unrestricted blocks query (cap 40) that supplies content matches.
  The frontend merges them by `page_id`, caps each group at 2 block matches, and caps the total to 8 page groups. Surplus matches inside a group surface as a "+N more in this page" pill; surplus pages do not render — the escalation footer is the user's path to more.
- **Ranking** uses the FTS5 candidate set, then post-FTS reorders by a 4-band rule (exact title → prefix title → contains-in-title → content-only) blended with a hand-rolled Jaro-Winkler similarity on the page title (`0.7 * band + 0.3 * JW`). The JW boost forgives typos like `alfa` → `Alpha` without filtering anything out — fuzzy is additive.
- **Click behaviour.** Plain click navigates the active tab; `Cmd/Ctrl+click` (or middle-click) opens the target in a new tab.
- **Keyboard.** `↑` / `↓` walk the flattened result list (page header → its block hits → next page header). `Enter` activates; `Cmd/Ctrl+Enter` activates in a new tab. `Esc` closes.
- **`[[page]]` autocomplete.** Typing `[[` followed by ≥ 1 character switches the palette into page-link mode: only the pages query fires, and `Enter` inserts `[[Page Title]]` into the **previously focused block** (the editor block that had focus when Cmd+K opened) and closes the palette. If there's no editor focus when the palette opens, the link-insertion path silently no-ops; you still get to navigate. If no page matches, the palette surfaces an inline "No page named …" hint.
- **Debounce** is ~80 ms (palette UX is type-ahead — VSCode's `Cmd+P`, Linear, Raycast all run sub-100 ms). The find-across-pages view's 300 ms debounce is deliberately different — it's a deliberate-refinement surface, not a type-ahead one.
- **Escalation footer.** "Search in all pages with toggles → Ctrl+Shift+F" — clicking opens the find-across-pages view with the current query pre-filled. Note that the binding is `Ctrl+Shift+F` (PEND-52 reclaimed `Ctrl+F` for in-page find).

The palette does not surface tags, parentless blocks, or recent blocks (only recent **pages**). Future iterations may extend this — see PEND-51 §"Phase split" for the locked-in scope of v1.

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

### Browser compatibility for visual highlighting

The yellow highlight that paints over matches is rendered via the **CSS Custom Highlight Registry** (`CSS.highlights` + `Highlight` + `Range`). It's the modern, DOM-mutation-free way to paint over text. The matcher, counter, and `F3` / `Shift+F3` navigation work on every supported platform; only the visual highlight depends on the Custom Highlight API.

| Platform | Min Agaric version | WebView | Highlight visible? |
|---|---|---|---|
| Windows 10 1803+ | yes | WebView2 (auto-updates) | yes |
| macOS 11 Big Sur | yes | Safari 14–16.6 | **no** |
| macOS 12 Monterey | yes | Safari 15 (or 17.4 on macOS 12.3+ via update) | maybe |
| macOS 13 Ventura | yes | Safari 17.4+ available | yes |
| macOS 14 Sonoma+ | yes | Safari 17.4+ shipped | yes |
| Ubuntu 22.04 / Debian 12 | yes | webkit2gtk 2.40 | **no** |
| Ubuntu 24.04 / Fedora 39+ | yes | webkit2gtk 2.46+ | yes |
| Android (Chrome WebView) | yes | Chrome 105+ on 2020+ devices | yes |

Users on the **no**-highlight rows still get a fully functional in-page find: the counter updates, `F3` cycles matches, the editor scrolls to each match. The yellow background just doesn't paint. Updating the OS or distribution to a recent version (or installing a current Safari) restores the highlight.

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
| `state:VALUE` | Block's `todo_state` is `VALUE`. | Repeats OR-combine (`state IN (…)`). Custom states allowed. `state:none` matches `todo_state IS NULL`. |
| `not-state:VALUE` | Block's `todo_state` is **not** `VALUE`. | NULL-inclusive inversion: `(todo_state IS NULL OR todo_state NOT IN (…))`. Repeats AND-extend the exclusion set. `not-state:none` flips to `todo_state IS NOT NULL`. |
| `priority:VALUE` | Block's `priority` is `VALUE`. | Repeats OR-combine. `priority:none` matches `priority IS NULL`. |
| `not-priority:VALUE` | Block's `priority` is **not** `VALUE`. | Symmetric to `not-state:` — NULL-inclusive inversion. |
| `due:RANGE` | Block's `due_date` matches `RANGE`. | See *Date predicates* below. |
| `scheduled:RANGE` | Block's `scheduled_date` matches `RANGE`. | Same shape as `due:`. |
| `prop:KEY=VALUE` | Block has property `KEY` with the given value (matches across `value_text` / `value_num` / `value_date` / `value_ref`). | Multiple `prop:` tokens AND-combine. `prop:KEY=` (empty value) matches "block has the key at all". |
| `not-prop:KEY=VALUE` | Block does NOT have that property/value. | AND-joined exclusion. |
| `"phrase"` | Quoted phrase passed verbatim to FTS5. | Bypasses the trigram length filter. |
| `AND` / `OR` / `NOT` | Boolean operators (uppercase, FTS5 syntax). | Outside filter tokens. |

### Autocomplete

Typing a recognised filter prefix (`state:`, `priority:`, `due:`, `scheduled:`, `tag:#`, `prop:`, `path:`, `not-path:`) in the search input opens a small popover anchored next to the caret. The popover lists value suggestions filtered by the partial value typed after the prefix. Focus stays in the input throughout — the popover is a passive guide, never a focus trap; typing, deleting, and caret movement all keep working as normal.

| Prefix | Source | Notes |
|---|---|---|
| `state:` / `not-state:` | Static: `TODO`, `DOING`, `DONE`, `WAITING`, `CANCELLED`, `none` | Same vocabulary the parser accepts. |
| `priority:` / `not-priority:` | Static: `A`, `B`, `C`, `none` | Same. |
| `due:` / `scheduled:` | Static bucket list: `today`, `yesterday`, `overdue`, `this-week`, `this-month`, `next-week`, `older`, `none` | Bucket keywords only — explicit ISO dates and comparison operators aren't suggested. |
| `tag:#` / `#` | `listTagsByPrefix` IPC (150 ms debounce) | Returns up to 20 tags matching the typed prefix. |
| `prop:` / `not-prop:` (key side) | Shared property-keys cache — `block_properties` `DISTINCT key`s for the current space | Lazily fetched on first `prop:` open per session+space; invalidates on `block:properties-changed`. |
| `prop:KEY=` (value side) | Not yet suggested — open as a follow-up. | The popover stays closed for `prop:KEY=` until value suggestions land. |
| `path:` / `not-path:` | Per-space MRU of past path globs (localStorage `agaric:pathHistory:v1:<spaceId>`) | Newest-first, dedup-with-jump-to-top, capped at 30 entries per space. Recorded on submit when the query contains `path:` or `not-path:` tokens. |

Keyboard model:

- `↑` / `↓` — move the highlight up / down. Wraps both directions.
- `Enter` — apply the highlighted value, replacing the typed value portion of the token and appending a trailing space.
- `Tab` — same as `Enter`. UX convention; Tab does NOT move focus while the popover is open with a highlighted value.
- `Esc` — close the popover. Focus stays in the input. Typing another character re-opens the popover.
- Picking a value via mouse click also fires the same insertion + trailing space.

`↑` / `↓` cycle through search history only when the input is empty AND the popover is closed. The popover wins when both conditions could apply.

When the `.*` toggle is on, autocomplete is disabled: the user's input is the regex pattern verbatim, so `state:` and friends inside a regex don't trigger value suggestions.

The input declares ARIA 1.1 combobox-with-listbox semantics:

- `role="combobox"`, `aria-autocomplete="list"`, `aria-haspopup="listbox"`.
- `aria-expanded` toggles with the popover's visibility.
- `aria-controls` references the live listbox id; `aria-activedescendant` follows the highlighted option's id. Both ids are generated by `cmdk` (the underlying combobox library) and surfaced via a small bridge so the input stays the canonical accessible name for the combobox.

Caret-anchored autocomplete renders on all platforms today, but the caret-tracking math is desktop-tuned; iOS Safari / Android touch UX will get a dedicated review in PEND-62 (unified mobile search).

The popover anchors at the start of the value portion (the character after the prefix's colon or `#`), so it stays put as the user types more characters. Moving the caret outside the active token closes the popover.

### Date predicates

`due:` and `scheduled:` accept three shapes:

- **Bucket keyword** — one of `today`, `yesterday`, `overdue`, `this-week`, `this-month`, `next-week`, `older`, `none`. Resolved against today's date in Rust at query time; week starts on Monday (mirrors the agenda view's convention).
- **Absolute ISO date** — `due:2026-05-17` is equivalent to `due:=2026-05-17` (calendar-validated).
- **Comparison form** — `<`, `<=`, `=`, `>=`, `>` followed by an ISO date: `due:>=2026-01-01`.

Invalid dates surface as a red chip with the typed error `InvalidDateFilter: …`.

### Property filter typing (PEND-64)

`prop:KEY=VALUE` matches across the four user-facing typed columns automatically (`value_text`, `value_num`, `value_date`, `value_ref`). The backend parses `VALUE` into each variant and binds `NULL` for the variants that don't parse, so only intentional matches fire:

- `prop:priority=1` matches `value_num = 1`.
- `prop:due-date=2026-05-17` matches `value_date = '2026-05-17'`.
- `prop:author=01HKQ2RWWWGM34RTGFE9XCRYZ4` matches `value_ref = '01HKQ…'` (ULID column, uppercased at bind time).
- `prop:status=draft` matches `value_text = 'draft'` (v1 behaviour).

The mutually-exclusive `exactly_one_value` CHECK on `block_properties` (migration `0062`) means at most one branch ever fires per row. `value_bool` is internal (not user-typed) and remains out of scope.

**Property keys are case-sensitive** — `block_properties.PRIMARY KEY (block_id, key)` has no `COLLATE NOCASE`. `prop:Foo=...` and `prop:foo=...` are distinct queries. Autocomplete shows keys verbatim.

### Scheduled-date semantics for repeating tasks

`scheduled:` matches the literal `blocks.scheduled_date` column. Repeating-task `next_repeat` resolution is owned by the agenda projection; threading the dynamically-computed occurrence into search would duplicate that logic and is deferred to a follow-up plan. Today: a task with a literal `scheduled_date = 2026-05-17` matches `scheduled:this-week` only when 2026-05-17 falls in this week.

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
| `state:TODO priority:1 due:this-week` | High-priority open tasks due this week. |
| `state:TODO state:DOING due:overdue` | Anything overdue that isn't done. |
| `not-state:DONE due:overdue` | Overdue items that haven't shipped, including no-state blocks. |
| `scheduled:none state:TODO` | Open tasks with no schedule yet. |
| `prop:status=blocked not-prop:archived=true` | Blocked items, excluding archived. |
| `prop:assignee=` | Blocks that carry an `assignee` property (any value). |

### Behavioural error states

- `path:[unclosed` → invalid chip with `InvalidGlob: unbalanced bracket`.
- `path:{a,{b,c}}` → invalid chip with `InvalidGlob: brace nesting not supported`.
- `tag:` (no value) → invalid chip with `tag: value required`.
- `foo:bar` (unknown prefix) → invalid chip with `unknown filter key 'foo:'`.
- `due:tomorrowish` → invalid chip with `InvalidDateFilter: unknown date 'tomorrowish'`.
- `due:>=2026-13-99` → invalid chip with `InvalidDateFilter: expected YYYY-MM-DD …`.
- `prop:status` (no `=`) → invalid chip with `prop: expected 'key=value'`.
- `prop:=value` (empty key) → invalid chip with `prop: key cannot be empty`.

Invalid chips render with destructive styling, an `aria-invalid` marker, and the typed error as the hover tooltip. The frontend keys on the `InvalidGlob:` prefix returned by the backend so the same message can also originate from a server-side rejection.

### Migrating from the old chip UI

PEND-54 replaced the legacy `+ Page` and `+ Tag` popover chips. There is one **documented behavioural change**:

- The old `+ Page` chip filtered by a single exact page ULID. The new `path:` filter matches against the page **title** with substring semantics by default. `path:Project Alpha` matches `Project Alpha`, `Project Alpha 2`, and `Old Project Alpha`. To preserve exact-page-filter semantics, use the page's inline link form `[[Project Alpha]]` in the query (FTS5 matches verbatim) or pair `path:` with a unique substring.

The new model is a strict superset of every other previous use case — copy-paste of a query string round-trips, and the chip row is recomputed from the AST on every keystroke.

## Toggles

The toggle row sits to the right of the search input — three pressable buttons matching VS Code's find-in-files family:

| Toggle | Icon | Effect |
|---|---|---|
| **Case-sensitive** | `Aa` | The post-FTS filter narrows results to case-sensitive matches. The FTS5 trigram index is `case_sensitive 0`, so enabling this toggle forces a regex pass over the candidate set even when no other toggle is on — i.e. it has a non-zero cost on every keystroke. |
| **Whole word** | `Ab\|` | The post-FTS filter wraps the query in ASCII word boundaries (`(?-u:\b)`). **CJK content does NOT match** — CJK characters are not ASCII word characters, so the boundary never asserts. Documented v1 limitation. |
| **Regex** | `.*` | The query string is treated as a Rust [`regex`] pattern verbatim. The FTS5 MATCH path is **bypassed entirely** — there's no FTS-index acceleration; wall-time scales with the structurally-filtered block count. |

Toggle state persists in `localStorage` (`agaric:searchToggles:v1`) so opening a fresh window restores your preference. State does NOT survive a save — a saved search is `(query, toggles)`, not just `(query)`.

## Regex syntax

The find-across-pages view uses the Rust [`regex`] crate. Key differences from JavaScript's `RegExp`:

- **Linear-time guarantees** — there is no catastrophic backtracking.
- **No lookaround** — `(?=…)`, `(?!…)`, `(?<=…)`, `(?<!…)` are not supported.
- **No backreferences** — `\1`, `\k<name>` are not supported.
- **`\b` is ASCII-only by default.** Use `(?u:\b)` for Unicode word boundaries. The whole-word toggle wraps the query in the ASCII variant.
- **Inline flags** `(?i)` / `(?m)` / `(?s)` / `(?x)` work as expected. The case-sensitive toggle injects `(?i)` (disabled) or `(?-i)` (enabled) at the start of the composed pattern.
- **Unicode classes** like `\p{Han}` work; precompile UCD tables ship with the binary.

### Regex caps

To bound worst-case compile time and matched-output size, the backend applies four caps:

| Cap | Value | Reason |
|---|---|---|
| Pattern length | 1 KiB | Rejected up-front before invoking `RegexBuilder`. Surfaces as `AppError::Validation("InvalidRegex: pattern length N exceeds cap 1024")`. |
| `RegexBuilder::size_limit` | 10 MiB | Bounds the compiled regex's in-memory size. Surfaces as `AppError::Validation("InvalidRegex: …")`. |
| `RegexBuilder::dfa_size_limit` | 10 MiB | Bounds the lazy-DFA cache at runtime. |
| Match offsets per block | 50 | Caps per-row IPC payload. A `.` regex against a long block returns the first 50 matches; trailing matches are silently dropped. |
| Pre-filter row count | 1000 | Bounds the regex-mode SQL scan. Most-recent-first ordering by `b.id DESC` (ULID prefixes are time-sortable; the `blocks` table doesn't carry `created_at`). |

Regex compile errors surface inline next to the input with a red border; the error message follows the `InvalidRegex:` prefix.

### Regex-mode trade-off

In regex mode the FTS5 candidate set is unused; the SQL scan returns the 1000 most-recent blocks (within the structural filters: tags, paths, space) and the regex is applied to each. **Recommend a literal seed term (≥3 chars) for tight queries.** Without a seed, the regex runs over the full 1000 candidates.

### Regex differences between surfaces

See [Regex differences between surfaces](#regex-differences-between-surfaces) above for the in-page find vs find-across-pages comparison. The summary:

- **In-page find** uses JavaScript `RegExp` (lookaround + backreferences supported, backtracking).
- **Find across pages** uses the Rust `regex` crate (linear-time, no lookaround / backreferences).

For portable patterns, stick to the intersection: literal text, anchors (`^`, `$`), character classes, quantifiers, alternation, ASCII-only `\b`.

## Boolean operators

Non-regex queries pass through the FTS5 sanitiser, which preserves three operators (case-insensitive on input, uppercase on the wire):

- `AND` — explicit intersection (FTS5's default, but useful for clarity).
- `OR` — union, e.g. `cats OR dogs`.
- `NOT` — negation, requires a following token: `meeting NOT cancelled`.

Quoted phrases bypass the trigram length filter: `"sprint plan"` matches the exact phrase, including 2-char tokens (`OR`, `2x`) that would otherwise be dropped.

Boolean operators **don't work inside regex mode** — there the entire query is the regex pattern; `AND` / `OR` are matched as literal text.

## Tips

- **Recall recent queries with `↑` / `↓`.** When the input is empty and focused, the history dropdown surfaces the last 20 submitted queries (most-recent first). `↑` walks backward, `↓` forward; pressing past the newest entry clears the input. Per-space partitioning — queries from another space stay invisible.
- **History dedupes.** Submitting the same query twice doesn't accumulate duplicates; the existing entry moves to the front.
- **Clear history.** The dropdown's footer wipes the per-space MRU list. Other spaces stay untouched.
- **Toggle state persists, history is per-space.** A `tag:` reference is space-specific, so cross-space recall would silently no-match. Toggle preferences are global because their effect (case / whole-word / regex semantics) is space-agnostic.
- **Filter syntax is sanitiser-friendly.** `tag:#name` survives a literal-mode round-trip; recalling a `tag:` query from history rebuilds the chip row exactly.
- **Inline filter syntax is not regex-aware.** In regex mode, `tag:#urgent` is interpreted as a literal regex pattern (the `:` is a literal colon). Filter chips and regex compose at the *query* level, not inside the regex pattern. To use filters + regex together, type the filters first, then prepend the regex (e.g. `tag:#urgent ^TODO` with the `.*` toggle on — the FTS bypass keeps the `tag:` filter ineffective, **the structural filters still apply via the regex-mode SQL path**; this is a known sharp edge).

[`regex`]: https://docs.rs/regex/latest/regex/
