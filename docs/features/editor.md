<!-- markdownlint-disable MD060 -->
# Editor

The editor is a block-based outliner built on TipTap (ProseMirror). Only the focused block is editable at any moment — every other block renders as a read-only static block. This *roving editor* keeps memory bounded and undo history isolated per edit session.

## Surfaces around the focused block

Above the focused block sits the **FormattingToolbar** — always visible. It carries icon buttons grouped by purpose: refs+blocks, structure, metadata, history. Low-priority buttons collapse into a `MoreHorizontal` overflow popover when the container is narrow.

When you select text inside a block, the **SelectionBubbleMenu** appears next to the selection. It hosts the six mark toggles (Bold / Italic / Code / Strike / Highlight / Underline) plus an External Link button. It only appears on non-empty selections so it doesn't get in the way of typing.

## Markdown surface

Type, paste, or use the toolbar:

| Mark / structure | Trigger |
| --- | --- |
| Bold | `Ctrl+B` |
| Italic | `Ctrl+I` |
| Inline code | `Ctrl+E` |
| Strikethrough | `Ctrl+Shift+S` |
| Highlight | `Ctrl+Shift+H` |
| Underline | `Ctrl+U` (stored as `<u>…</u>`) |
| Heading levels | `Ctrl+Alt+1` … `Ctrl+Alt+6`, toolbar → Heading popover, or slash menu (`/h1` … `/h6`) |
| Blockquote | Toolbar, or slash menu (`/quote`) |
| Code block | Toolbar (with language picker), or slash menu (`/code`) |
| Divider | Slash menu (`/divider`) |
| Callout | Slash menu (`/callout`); types: tip / note / info / warning / error |
| Ordered / unordered list | Toolbar, or markdown shortcut (`1.`, `-`) |
| Table | Slash menu (`/table 4x6` for 4 rows × 6 columns) |
| Task | A checkbox and a space typed at the start of the block, with or without a `-` and a space before it: `[ ]` TODO, `[/]` DOING, `[x]` or `[X]` DONE, `[-]` CANCELLED. The marker disappears and the block takes the state; `Ctrl+Enter`, the checkbox and the toolbar cycle it from there. `TODO` stays a word |

Markdown shortcuts trigger as you type (`#`, `##`, ``` ` ```, `**bold**`, `_italic_`, `~~strike~~`, `==highlight==`, `[text](url)`, `1.`, `-`, `>`, `[ ]`, `[/]`, `[x]`, `[-]`). A mark delimiter follows CommonMark's flanking rule, typed, pasted or stored alike: one with a space on its inner side stays text, so `5 * 3 = 15 and 2 * 4 = 8` is not italic, while a mid-word `un*break*able` is. A delimiter run never closes the mark it opened, so `a====b` stays text.

## External links

- **Add a link to selected text**: `Ctrl+K` opens the **LinkEditPopover**. Enter the URL; the selection becomes a clickable link.
- **Add a link by pasting**: paste a URL while text is selected — the selection becomes the link's label.
- **Edit an existing link**: click the link → LinkEditPopover opens for edit.
- **Remove a link**: open the popover → *Remove*.
- **Hover preview** (desktop): hovering a link shows a tooltip with the page's title and favicon (cached locally; first hover triggers a fetch).
- **Long-press copy** (mobile): long-press a link to bring up *Copy URL*.

## Block operations

[keyboard.md](keyboard.md) is the source of truth for bindings; this table is the editor's action inventory.

| Action | Trigger |
| --- | --- |
| Split block | `Enter` |
| Leave the block | `Escape` keeps what you typed and selects the block, so the block-selection keys act on it; a second `Escape` clears the selection, and `Ctrl+Z` undoes the edit like any other. An empty block is not selected: leaving tidies it away, as a click elsewhere does. The toolbar's *Discard changes* throws the edit away instead |
| Continue a list | `Enter` on a bullet / numbered block creates the next block with the same list style; `Enter` on an *empty* styled block leaves the list instead |
| Line break inside a block | `Shift+Enter`, or the toolbar's *New line* button (virtual keyboards have no Shift+Enter). A single line break is a line of the same block, stored as one newline and shown as a break; a blank line separates blocks |
| Merge into previous | `Backspace` at start of block. On a bullet / numbered block the first `Backspace` clears the list style; the second merges (or, on an empty block, deletes it) |
| Indent / dedent | `Tab` / `Shift+Tab`, or `Ctrl+Shift+→` / `Ctrl+Shift+←` |
| Move block up / down | `Ctrl+Shift+↑` / `Ctrl+Shift+↓` |
| Collapse / expand children | `Ctrl+.` (or click the chevron) |
| Open Property Drawer | `Ctrl+Shift+P` |
| Set priority directly | `Ctrl+Shift+1` / `Ctrl+Shift+2` / `Ctrl+Shift+3` (P1 / P2 / P3) |
| Insert a date at the cursor | `Ctrl+Shift+D` |
| Set a due / scheduled date | Toolbar (no default keyboard binding) |
| Cycle task state | `Ctrl+Enter` |
| Multi-select adjacent blocks | `Shift+Click`, `Ctrl+Click`, `Ctrl+A` (within page) |
| Delete block | Toolbar → *Delete*, or `Ctrl+Backspace` on an empty block |
| Drag to reorder | Drag the gutter handle |
| Swipe-to-delete (touch) | Swipe left on a block |
| Zoom into a block | `Alt+.`, toolbar → Zoom, or click the block-zoom breadcrumb (`Escape` zooms out) |

`Tab` / `Shift+Tab` indent and dedent by default. If you'd rather keep them as plain focus navigation, turn off *Tab indents blocks* in Settings → Editor; either way they're suppressed while a picker popup is open.

## Drag and drop

Drag-handle on the left gutter (or anywhere with a long-press on touch). The drop indicator shows the projected nesting depth — horizontal offset during drag determines whether you're moving the block as a sibling, a child, or to an outer level. Offscreen blocks become zero-height placeholders to preserve scroll position. Auto-scroll engages when dragging near the top or bottom of the viewport.

You cannot drop a block into its own subtree.

## Edit as Markdown

Page kebab → *Edit as Markdown* swaps the page's blocks for a plain-text editor holding the page as markdown: the page's own properties, aliases and tags as YAML front matter when it has any, then a `-` bullet per block, children indented two spaces, `key:: value` property lines (a repeating task's `repeat`, `repeat-until` and `repeat-count` among them) and `[ ]` / `[x]` tasks. Every line shows its markdown exactly as typed, with no formatting and no shortcut turning it into something else. The title and attachments keep their own UIs and are not in it.

- **Each line keeps its block.** The line a block starts on carries the block's id out of sight, and keeps it while you edit the text. Cut a line with its line break and paste it where a line starts to move or re-nest its block. Removing a bullet deletes its block and a new bullet creates one. Enter keeps the id on the line where the text it splits starts, so the line it opens is a new block. Joining two lines (Backspace at the start of one, or Delete at the end of the one before) keeps the first line's block and deletes the second's. A copy pasted is a new block, and so is text pasted from anywhere else: a `^ID` in it is text. Copying out of the buffer gives the lines as plain text, without ids.
- **Enter continues a list.** On a `-`, `*`, `+`, `1.` or `1)` line it starts the next line with the same indentation and marker, numbered one up, and a task line goes on as `- [ ]`. Enter on a line holding only its marker removes the marker, ending the list, and `Shift+Enter` breaks a line without one. `Ctrl+Z` and `Ctrl+Shift+Z` undo and redo in the buffer a run of typing at a time.
- **The block editor's keys work on lines** ([keyboard.md](keyboard.md#edit-as-markdown)), through the same bindings and your rebinds. `Tab` and `Shift+Tab` (or `Ctrl+Shift+→` / `Ctrl+Shift+←`) indent the lines at the cursor two spaces and take up to two spaces or a tab off them; with *Tab indents blocks* off in Settings → Editor, Tab moves focus instead. `Ctrl+Shift+↑` / `Ctrl+Shift+↓` move the line with the lines indented under it past its sibling, a selection's siblings together, so the save moves those blocks; they stop at the top and bottom of the parent and at the front matter. `Ctrl+Enter` steps a list line's task as the block editor does: none, `[ ]`, `[/]`, `[x]`, `[-]`, none. Every line keeps its block through all of these, and one `Ctrl+Z` undoes each. `Escape` leaves the buffer.
- **Pickers write markdown.** `[[` opens the page picker and the page picked is written `[[Title]]`; `#`, where a tag can start (at the start of a line or after a space, not in a fenced code block), opens the tag picker and writes `#name`, or `#[[name]]` when the bare form would read as another tag; `((` searches blocks and writes `((ID))`. *Create* writes the name as typed, and the save creates the page or tag. An open picker takes `Enter`, `Tab` and `Escape`.
- **The buffer reads as markdown** (the grammar in [import-export.md](import-export.md#import-settings--data)): `-`, `*`, `+`, `1.` and `1)` all start a block, nested by the marker's content column; a bare paragraph is a block, and a heading typed without a bullet owns what follows it. A line under a bullet that would read as a marker, a heading or a `key:: value` property is written with a leading `\`, which the save removes again. A fence left open in a block ends at the next line that starts a block, and the save warns which fence it closed.
- **Property lines** read as import reads them, with one difference: `key::` with no value, with or without a trailing space, deletes the property the block holds; for a key it does not hold, the line stays in the block as text. A key names the built-in key or definition it matches ignoring case and `-`/`_`, and a ref-typed value is a block's `^ID`, a `[[Title]]` or a plain title in the space. A value its definition refuses refuses the save. A value its line cannot hold as it is (one with a line break, which an agent can set, a space at either end, or one that is itself a quoted string) is written as a JSON string: `note:: "two\nlines"`, with `\"` for a quote and `\\` for a backslash inside. A value typed in double quotes is read the same way; any other value, backslashes included, is taken as it is.
- **A refused save names the line.** The message starts with `line N:`, the buffer line of the block the save stopped at, counted from the top of the buffer, and that line is selected so the cursor is on it. A depth or size limit names the line of the block where it was reached the same way.
- **Page properties** are the front matter at the top of the buffer, the export's and Obsidian's form: `---`, then `aliases: [a, b]`, `tags: [a, b]` and one `key: value` line per property, then `---`; a value with a line break is written `key: |`, its lines indented two spaces under it. Typing one on a page that has none creates it, and Logseq's `key:: value` lines above the first bullet (`alias::` and `tags::` among them) are read too, a quoted value as a block's is. Save writes what changed as the page's property table, alias list and tag list write it: a key left out is deleted, a tag no tag of the space names is created. The keys the property table does not show (`created_at`, `template` and the like) are not written, so leaving them out deletes nothing. A line that is not a `key: value` pair, a key the app keeps, a key written twice, a `---` nothing closes and a value its definition refuses each refuse the save, and the message names the line, the `---` being line 1.
- `[[Page]]` and `#tag` resolve in the page's space as import resolves them ([import-export.md](import-export.md#import-settings--data)): exact title, then a unique case-insensitive title, then a unique alias, else created; the `[[` picker's `[[text]]` rule follows the same order over the full title, namespace included.
- `[[Page|label]]` links `Page` and shows `label` in its place, stored as `[[ULID|label]]` so the link still follows a rename; a label equal to the title is not stored. `[[Page#Heading]]` links the page titled `Page#Heading` when one exists, else `Page` (it never creates `Page#Heading`). Ctrl+K on a selected link chip opens the link popover on its label.
- **Save** (`Ctrl+S`) writes the whole buffer as one change, so one page-level `Ctrl+Z` undoes it. Saving an empty buffer asks first, since it deletes every block. **Cancel** (or `Escape`) closes the buffer; when it is not the page as loaded, in its text or in which line carries which block (a restored draft included), it asks first, and *Keep editing* goes back to the text.
- **A save leaves a report** with *Undo*, which reverts the whole save while it is still the page's latest change; after that it says so and reverts nothing. A save that deleted blocks (the report then counts what it deleted, created, edited and moved), created pages or tags for names nothing matched (listed as links, so a typo in a `[[Name]]` shows), or saved something differently than written (one line each) keeps its report until you dismiss it; any other save shows *Markdown saved* for a few seconds.
- **If the page changed elsewhere** (another device, an agent, another tab) since you opened the buffer, Save lists what changed there instead of saving. *Merge* saves your text with those changes folded in, as one change, and closes the buffer like Save. Where both sides changed the same lines of a block differently, your version is saved as a new block just before the page's; a block you removed that was changed or moved to another parent there stays; a block you changed or moved to another parent that was removed there comes back as a new block; a block moved differently on each side keeps the page's parent, and children reordered differently on each side keep your order. Each of these shows a warning. *Reload* swaps your text for the page as it is now, *Keep editing* leaves your text so you can copy it out, and *Overwrite* saves your text over those changes: edits made there are reverted, blocks added there are deleted, blocks deleted there come back as new copies, and a page renamed there is linked by its old name, which creates a new page.
- **Unsaved text is kept** on this device as a draft, with the block each line carries, and restored the next time you open *Edit as Markdown* on that page, until you save or discard it. A restored draft still catches what changed on the page since. A draft kept by an earlier version, whose blocks were `^ID` anchors in its text, is not loaded into the buffer: it shows read-only above it with *Copy earlier edits*, until editing, saving or discarding the buffer replaces it.
- A line pasted from another page's buffer still carries its block's id; the save keeps that block where it is and saves the line as a new block, with a warning naming the line. The front matter's lines carry no id.

## File attachments

- **Drag-and-drop** files into the editor.
- **Paste** images directly into a block.
- **Click** an image in the editor to open the **ImageLightbox** (full-screen viewer with keyboard navigation).
- **Drag the corner handle** of an image to resize.
- **PDF attachments** open in the **PdfViewerDialog**.
- Files render with type-specific icons (PDF, Word, Excel, image, generic).

## Drafts (autosave)

Edits to the focused block save locally on every interaction — both on blur and on a debounced timer while typing. If the app crashes or you close it mid-edit, the draft restores on next open. Drafts that never resolved against a real block are swept periodically.

## Code blocks

Code blocks support a curated set of grammars rather than the full highlight.js bundle — the exact list lives in `src/lib/lowlight-curated.ts`. Pick the language from the toolbar's code-block popover; the block shows its language name in the corner.

Syntax highlighting is local. Fenced markdown imports respect the language hint.

## Mermaid diagrams

Fence a code block as `mermaid` and the editor renders the diagram inline. Edit-on-click swaps back to the source; click outside to re-render.

## Inline references and queries

See [pickers-and-slash.md](pickers-and-slash.md) for the trigger characters and [tags-and-links.md](tags-and-links.md) for the resolution model and inline query blocks.

## Pitfalls to know

- **The editor focuses one block at a time.** Clicking a different block flushes the current one's content before unmounting; if you bind a custom UI to "the focused block", be aware that the focused block changes on click.
- **Markdown shortcuts don't trigger after the cursor moves to a non-start position.** `#` at the start of an empty block becomes a heading; mid-paragraph it stays literal.
- **`Ctrl+Z` inside the editor undoes typing.** `Ctrl+Z` outside the editor (i.e. when you've clicked away) undoes the previous page-level operation (block create / delete / move / etc.). The two undo stacks are intentionally separate.
- **Paste of a URL only creates a link when text is selected.** Otherwise it inserts the URL as plain text. Use the LinkEditPopover for a no-text link.
- **Pasting text of more than one line pastes blocks, spliced like a text editor.** It reads as a markdown import does (HTML from a web page gives the same tree): the first block joins the block at the cursor (at the start of a plain paragraph it brings its task state, list style and properties; after text, and in a heading or a quote, whose marker counts as text, it joins as the text you pasted, so the block keeps its type), the text after the cursor ends the last one (after a code block, on a block of its own), a selection is replaced, and the caret ends up just before that text. One undo takes back the paste and nothing typed before it, and the "Pasted N blocks" toast offers *Undo* and *Paste as text* (the lines as they are, as `Ctrl+Shift+V` pastes them). A single line pastes into the block at the caret with its markdown read (`**bold**`, `[text](url)`, `![alt](src)`, `$math$`, …); a task line and a bare URL keep their own paste.
- **A block splits on blur only when the edit added blocks** beyond what it was loaded with. So a block loaded with N paragraphs stays one block when one paragraph is deleted and another added, and likewise when N paragraphs are pasted over it: the same trade, taken so that a typo fix never splits a block that was stored that way.
