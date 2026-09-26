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

Markdown shortcuts trigger as you type (`#`, `##`, ``` ` ```, `**bold**`, `_italic_`, `~~strike~~`, `==highlight==`, `1.`, `-`, `>`, `[ ]`, `[/]`, `[x]`, `[-]`).

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

Page kebab → *Edit as Markdown* swaps the page's blocks for one text box holding the page as markdown: a `-` bullet per block, children indented two spaces, `key:: value` property lines (a repeating task's `repeat`, `repeat-until` and `repeat-count` among them), `[ ]` / `[x]` tasks, and each block's `^ID` anchor at its end. The title, front-matter and attachments keep their own UIs and are not in it.

- **Anchors keep blocks.** A bullet with a `^ID` stays that block: edit its text, or move the bullet to reorder or re-nest it. Typing after the `^ID`, or on a line under it, keeps the block too: the anchor is read wherever the edit left it and taken out of the text. Removing a bullet deletes its block, a bullet without a `^ID` creates one, and joining two bullets deletes the first block.
- **The buffer reads as markdown** (the grammar in [import-export.md](import-export.md#import-settings--data)): `-`, `*`, `+`, `1.` and `1)` all start a block, nested by the marker's content column; a bare paragraph is a block, and a heading typed without a bullet owns what follows it. A line under a bullet that would read as a marker, a heading or a `key:: value` property is written with a leading `\`, which the save removes again. A fence left open in a block ends at the next bullet carrying a `^ID`, and the save warns which fence it closed.
- **Property lines** read as import reads them, with one difference: `key::` with no value, with or without a trailing space, deletes the property. A key names the built-in key or definition it matches ignoring case and `-`/`_`, and a ref-typed value is a block's `^ID`, a `[[Title]]` or a plain title in the space. A value its definition refuses refuses the save, and the message names the line.
- `[[Page]]` and `#tag` resolve in the page's space as import resolves them ([import-export.md](import-export.md#import-settings--data)): exact title, then a unique case-insensitive title, then a unique alias, else created; the `[[` picker's `[[text]]` rule follows the same order over the full title, namespace included.
- `[[Page|label]]` links `Page` and shows `label` in its place, stored as `[[ULID|label]]` so the link still follows a rename; a label equal to the title is not stored. `[[Page#Heading]]` links the page titled `Page#Heading` when one exists, else `Page` (it never creates `Page#Heading`). Ctrl+K on a selected link chip opens the link popover on its label.
- **Save** (or `Ctrl+Enter`) writes the whole buffer as one change, so one page-level `Ctrl+Z` undoes it. Saving an empty buffer asks first, since it deletes every block. **Cancel** throws the buffer away.
- **If the page changed elsewhere** (another device, an agent, another tab) since you opened the buffer, Save lists what changed there instead of saving. *Merge* saves your text with those changes folded in, as one change, and closes the buffer like Save. Where both sides changed the same lines of a block differently, your version is saved as a new block just before the page's; a block you removed that was changed or moved to another parent there stays; a block you changed or moved to another parent that was removed there comes back as a new block; a block moved differently on each side keeps the page's parent, and children reordered differently on each side keep your order. Each of these shows a warning. *Reload* swaps your text for the page as it is now, *Keep editing* leaves your text so you can copy it out, and *Overwrite* saves your text over those changes: edits made there are reverted, blocks added there are deleted, blocks deleted there come back as new copies, and a page renamed there is linked by its old name, which creates a new page.
- **Unsaved text is kept** on this device as a draft and restored the next time you open *Edit as Markdown* on that page, until you Save or Cancel. A restored draft still catches what changed on the page since.

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
- **Pasting text of more than one line pastes blocks, spliced like a text editor.** It reads as a markdown import does (HTML from a web page gives the same tree): the first block joins the block at the cursor (at the start of a plain paragraph it brings its task state, list style and properties; after text, and in a heading or a quote, whose marker counts as text, it joins as the text you pasted, so the block keeps its type), the text after the cursor ends the last one (after a code block, on a block of its own), a selection is replaced, and the caret ends up just before that text. One undo takes back the paste and nothing typed before it, and the "Pasted N blocks" toast offers *Undo* and *Paste as text* (the lines as they are, as `Ctrl+Shift+V` pastes them). A single line pastes into the block as before.
- **A block splits on blur only when the edit added blocks** beyond what it was loaded with. So a block loaded with N paragraphs stays one block when one paragraph is deleted and another added, and likewise when N paragraphs are pasted over it: the same trade, taken so that a typo fix never splits a block that was stored that way.
