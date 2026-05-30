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
| Heading levels | Toolbar → Heading popover, or slash menu (`/h1` … `/h6`) |
| Blockquote | Toolbar, or slash menu (`/quote`) |
| Code block | Toolbar (with language picker), or slash menu (`/code`) |
| Divider | Slash menu (`/divider`) |
| Callout | Slash menu (`/callout`); types: tip / note / info / warning / error |
| Ordered / unordered list | Toolbar, or markdown shortcut (`1.`, `-`) |
| Table | Slash menu (`/table 4x6` for 4 columns × 6 rows) |

Markdown shortcuts trigger as you type (`#`, `##`, ``` ` ```, `**bold**`, `_italic_`, `~~strike~~`, `==highlight==`, `1.`, `-`, `>`).

## External links

- **Add a link to selected text**: `Ctrl+K` opens the **LinkEditPopover**. Enter the URL; the selection becomes a clickable link.
- **Add a link by pasting**: paste a URL while text is selected — the selection becomes the link's label.
- **Edit an existing link**: click the link → LinkEditPopover opens for edit.
- **Remove a link**: open the popover → *Remove*.
- **Hover preview** (desktop): hovering a link shows a tooltip with the page's title and favicon (cached locally; first hover triggers a fetch).
- **Long-press copy** (mobile): long-press a link to bring up *Copy URL*.

## Block operations

| Action | Trigger |
| --- | --- |
| Split block | `Enter` |
| Soft line break inside a block | `Shift+Enter` |
| Merge into previous | `Backspace` at start of block |
| Indent | `Ctrl+Shift+→` |
| Dedent | `Ctrl+Shift+←` |
| Move block up | `Ctrl+Shift+↑` |
| Move block down | `Ctrl+Shift+↓` |
| Collapse / expand children | `Ctrl+.` (or click the chevron) |
| Open Property Drawer | `Ctrl+Shift+P` |
| Set priority directly | `Ctrl+Shift+1` / `Ctrl+Shift+2` / `Ctrl+Shift+3` (P1 / P2 / P3) |
| Open Date Picker | `Ctrl+Shift+D` (due) / `Ctrl+Shift+S` (scheduled) |
| Cycle task state | `Ctrl+Enter` |
| Multi-select adjacent blocks | `Shift+Click`, `Ctrl+Click`, `Ctrl+A` (within page) |
| Delete block | Toolbar → *Delete*, or `Ctrl+Backspace` on an empty block |
| Drag to reorder | Drag the gutter handle |
| Swipe-to-delete (touch) | Swipe left on a block |
| Zoom into a block | Toolbar → Zoom, or click the block-zoom breadcrumb |

`Tab` and `Shift+Tab` are intentionally **not** bound to indent / dedent — they remain browser focus navigation so the app stays keyboard-accessible.

## Drag and drop

Drag-handle on the left gutter (or anywhere with a long-press on touch). The drop indicator shows the projected nesting depth — horizontal offset during drag determines whether you're moving the block as a sibling, a child, or to an outer level. Offscreen blocks become zero-height placeholders to preserve scroll position. Auto-scroll engages when dragging near the top or bottom of the viewport.

You cannot drop a block into its own subtree.

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

Code blocks support a curated set of languages (matching common usage: JavaScript / TypeScript / Python / Rust / Go / Ruby / SQL / Bash / JSON / YAML / Markdown / HTML / CSS / and a handful more). Pick the language from the toolbar's code-block popover. The block shows its language name in the corner.

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
