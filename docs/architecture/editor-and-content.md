<!-- markdownlint-disable MD060 -->
# Editor & Content

Companion to `docs/UI-MAP.md § Editor surfaces` (what the user sees) and `docs/UX.md § Editor architecture` (rules at point of edit). This file documents the **content format**, the **serializer contract**, the **roving-editor lifecycle**, the **FE/BE authority boundary**, and the **undo model**. For the list/block-composition model (list-ness as a block attribute rather than an in-block ProseMirror list), see `docs/architecture/list-ergonomics.md`.

## Storage format

Block text is stored and exchanged as Markdown, in two forms that share one grammar: the **stored content** of one block, and the **Document form**, the text of a page or of a run of blocks: the file an export writes, the buffer *Edit as Markdown* edits and an agent reads, the clipboard, the mirror's file, and what a Markdown import or a paste reads. The Document form is Obsidian's: YAML front matter for page properties, CommonMark and GFM for blocks, and the `key:: value` lines (Dataview) and signifiers (Tasks) those tools already use. Neither form changes the op log or sync: a Document text is a projection of the blocks, and stored content keeps its tokens.

### Stored block content

`blocks.content` is one block's text, written by the editor serializer:

- **Inline marks are a locked set:** bold, italic, code, strike (`~~x~~`), highlight (`==x==`), underline (`<u>x</u>`) and external link. A new mark is a deliberate addition to the serializer and its grammar.
- **Tokens:** `[[ULID]]` and `[[ULID|label]]` (page link), `#[ULID]` (tag), `((ULID))` (block ref), `[^label]` (footnote ref; a block whose text starts `[^label]:` defines the label), `$x$` (math) and `![alt|W](url)` with an `attachment:<id>` url for an attached image. `{{embed [[ULID]]}}`, `{{embed ((ULID))}}` and `{{query …}}` are text the renderer recognises.
- **Block constructs inside one block:** an ATX heading, a fence (the `language` attribute is the info string as written, trimmed), a `$$` math block, a quote, a callout `> [!TYPE]` with its `-` or `+` fold marker (the editor writes the type upper case and reads it in any case; the renderer maps every Obsidian, GitHub and GitLab type and alias onto its nearest style), a GFM table with its alignment, a `---` rule, and line breaks.
- **Not content:** a list marker (the `listStyle` property), a task checkbox and its priority and dates (the `blocks` columns), `key:: value` lines (`block_properties`) and the block's anchor. Text that opens like a list marker is stored after a `\`.
- **Escapes:** a character that would read as syntax is written after a `\`. Every escape the serializer writes has its decode in `src/editor/markdown-parse.ts`, in Rust's `is_escaped` and in the FTS strip.

Among the backend's readers of stored content are the FTS strip (`strip_for_fts_with_maps` in `src-tauri/agaric-store/src/fts/strip.rs`), which turns it into the text the editor shows, with escapes outside code decoded, markup removed, `[[ULID]]` and `#[ULID]` resolved to their targets' titles and `((ULID))` to its target's first line; the token regexes in `src-tauri/agaric-store/src/cache/mod.rs` (`ULID_LINK_RE`, `PAGE_LINK_RE`, `TAG_REF_RE`, `BLOCK_REF_RE`), which derive the link, tag and ref edges; and the writer and readers below, which turn tokens into names and back.

### The Document form

A Document text is a page's front matter, then its blocks. A reader accepts more than a writer writes: the second column is what every writer writes, the third what a reader also takes. A construct read only under the `LogseqOrg` dialect is marked so.

| Construct | Written | Also read |
|---|---|---|
| File | UTF-8, LF | CRLF, a lone CR, a leading BOM |
| Page properties | YAML front matter at byte 0: `aliases: [a, b]`, `tags: [a, b]`, then one `key: value` per property, quoted where YAML needs it; a ref-typed value is `"[[Title]]"` where the writer's Names policy writes its name, else its id | `alias:` and `tag:`; leading `key:: value` lines (`alias::`, `tags::` too); front matter after a leading `# Title` (older exports). TOML and JSON front matter are text |
| Title | none in a ZIP entry, whose path names the page; in a page export and a page copy `# Title` after the front matter; the agent read returns it as a field (`AgentPage`) | a leading `# Title` equal to the title derived from the file name, first or first after the front matter, is dropped (`strip_title_heading`), so an export imports as the page it was |
| Plain block | a paragraph; a blank line between blocks unless both open with a list marker | CommonMark paragraphs |
| Plain child | a `+` item at its parent's child column, the parent's line unchanged; a `+` item too for a first block that would read as front matter (`---`) or, in a file, as the title (`# Title`) | an indented paragraph after a blank line |
| List block | `- x`, and `N. x` numbered by its place in its run of siblings | `* x`, `N) x`; `+ x` is a plain block, never a bullet |
| Indent | spaces | tabs, at CommonMark tab stops |
| Heading | ATX; owns nothing, and starts a block wherever it stands | the same; under `LogseqOrg` outside a list it owns what follows it. Setext headings are text |
| Task | `- [ ]` TODO, `- [/]` DOING, `- [x]` DONE, `- [-]` CANCELLED; any other state is a `todo_state::` line | `[X]`; `TODO`, `DOING`, `[#A]`, `SCHEDULED:` and `DEADLINE:` under `LogseqOrg` only |
| Task fields | at the end of a task's first line, before its anchor, in the order `TASK_SIGNIFIER_KEYS` gives: `⏫` `🔼` `🔽`, `🔁 every …`, `⏳ YYYY-MM-DD`, `📅 YYYY-MM-DD`, and a done task's `✅ YYYY-MM-DD`; a field no signifier reads back as (a rule with a bound, a priority outside the levels) stays its `key::` line; a task's own text ending in a signifier is written with a `\` before it | the same on every surface; `🔺` as the first priority and `⏬` as the third |
| Non-task fields | `priority::`, `scheduled_date::`, `due_date::` and `repeat*::` lines | the same |
| Block property | a `key:: value` line at the block's text column; a value its line cannot carry (a line break, a space at either end, one already quoted) is a JSON string; a ref-typed value is `[[Title]]` as in front matter, else its id | the same; `key::` with no value deletes in a buffer save |
| Empty block | a line holding only `\` | the same |
| Anchor | `^ULID` after a space, ending the block's last line, or alone on the line after when the last line is code or empty | any `^word` in a Markdown file; only a block id in a paste or a buffer |
| Block-scoped file | in an export, a `+ [name](attachment:<id>)` child under its block; the page's own as paragraphs before the blocks | the same |
| Page link, tag, ref | `[[Title]]`, `[[Title\|label]]`, `#name` (`#[[name]]` where the bare form would not read back), a block ref `((ULID))` in a buffer, a file and a copy and `[[#^ULID]]` or `[[Title#^ULID]]` in an export; an embed `{{embed …}}`, its target named as a ref is in an export and as stored elsewhere; a `[[ULID]]` or `#[ULID]` where the name would not read back as the same page or tag | all of these, Obsidian `![[Note]]` embeds, and `((uuid))` under `LogseqOrg` |
| Code | a backtick fence, tildes for an info string holding a backtick | `~~~` fences |
| Rule | `---` | `***`, `___` |

A line inside a block that would read as anything but that line of the block is written after a `\` (`needs_document_line_escape`): a blank line, a list item, a `key::` line, a heading, a fence or a rule. Code lines are written as they are, but for one that would end its fence early. A fence is closed only by a run of its character at least as long, and nothing inside one is a bullet, heading or property; one left open ends with its list item, or with the document, and in a buffer before the next line that carries a block id.

### The `LogseqOrg` dialect

`ImportDialect` tells a file import which reading its source gets: a Logseq graph's pages and every `.org` file are `LogseqOrg`, everything else `Markdown`. Org files are first turned into outline text by `src/lib/org-import.ts`. `LogseqOrg` keeps the outline reading Logseq and Org files are written for: `-`, `*`, `+`, `1.` and `1)` all start a block and any indentation width nests by the marker's text column; a paragraph is one block, with a blank line between blocks and a single line break inside one; a heading outside a list owns what follows until the next of its level or higher, and one inside a list item owns nothing; Logseq's `key:: value` and continuation lines attach to their bullet, and an indented line after a blank line continues it, the blank line kept; a `TODO` keyword, a `[#A]` cookie, `SCHEDULED:` and `DEADLINE:` lines are read as task state, priority and dates; `#+BEGIN_X` blocks and a `:LOGBOOK:` drawer are rewritten or dropped; `id::`, `collapsed::` and `heading::` are bookkeeping, read after the scan by `read_logseq_bookkeeping`. A `Markdown` file is read as the Document form is, so an export imports as the blocks it was.

## Custom serializer

Four parts own the formats: the editor serializer for stored content, the Rust readers and writer for the Document form, their TypeScript mirrors, and the vector files that pin them.

### Stored content: the editor

The Markdown ↔ ProseMirror serializer lives on the frontend (`src/editor/markdown-parse.ts` and `src/editor/markdown-serialize.ts`, surfaced through the `markdown-serializer.ts` barrel). The editor needs lossless round-trips on every keystroke, and an IPC call per transaction would destroy typing fluency. It is property-tested with `fast-check` (`parse(serialize(parse(md))) == parse(md)`, and serialise idempotence); off-the-shelf parsers were rejected because none handled the locked mark set and the inline-ULID nodes losslessly.

### Document form: the Rust readers

Every reader is in `src-tauri/agaric-engine/src/import.rs` and reads CRLF, CR and a BOM. They differ in what they take from outside Agaric:

| Reader | Reads | Differs |
|---|---|---|
| `parse_markdown_file` | a `Markdown` file import (`parse_import_payload` in `src-tauri/src/commands/pages/markdown_import.rs`) | front matter and leading `key::` lines are the page's properties; a trailing `^word` is the block's anchor |
| `read_pasted_text` | a paste of text (`paste_blocks`), MCP `append_markdown` | no page properties; a front matter block at byte 0 is dropped with one warning; a trailing `^word` that is no block id stays text; depth is flattened past the import limit |
| `parse_document_outline`, `parse_document_text` | a page's own buffer: the *Edit as Markdown* save and MCP `edit_page_markdown` (`apply_page_source_inner`), Duplicate and the journal and meeting template copies; `parse_document_text` takes the ids that travel beside the lines | not foreign text: nothing is flattened, so a save refuses a depth past the limit; the page's properties come from the buffer's front matter |
| `parse_logseq_markdown` | a `LogseqOrg` file; `parse_vault_markdown` for a folder import's note | the outline reading above, then `read_logseq_bookkeeping` over the scanned blocks |

`pair_unanchored_lines` (`src-tauri/src/commands/pages/markdown_source_pair.rs`) gives the blocks of a text edited outside Agaric the ids they had when it was last written: an anchor names its block, and the rest pair against the last written text by their content. A re-import (`merge_into_page` in `src-tauri/src/commands/pages/markdown_import_merge.rs`) uses it to save a file over its page as an *Edit as Markdown* save does.

### Document form: the writer

`src-tauri/src/commands/pages/markdown_export.rs` is the one writer. A `RenderMode` is two policies:

- **Names.** `Names::Always` writes every id that resolves as a name, and a ref-typed value as `[[Title]]` when its target is a live page. `Names::ReadBack` writes a name only where it reads back as the same id (`humanise_refs_for_source`), and a ref-typed value as `[[Title]]` only where that is one link and its title names that page in the page's space (`ref_link`); a title the lower id of two pages holds, a page of another space, a deleted or non-page target and a title holding `]` keep the id. Every reader of a ref value takes a block id, `[[Title]]` or a title (`PropertyLines::read`), front matter on import as a `key::` line.
- **Anchors.** `Anchors::Addressed` writes `^ULID` on the blocks something addresses: a block ref or embed from any page, a ref-typed value, an attachment. `Anchors::Every` writes it on every block. `Anchors::Needed` writes none beyond what every policy writes: a block that leaves a fence open, or whose own text ends in a space, `^` and a block id, carries its anchor because it cannot read back without.

| Surface | Entry point | Names | Anchors |
|---|---|---|---|
| Export as Markdown, page copy, ZIP entry | `export_page_markdown_inner` (`render_page_markdown`) | Always | Addressed |
| Markdown mirror's file | `get_page_file_inner` (`render_page_file`) | ReadBack | Addressed |
| Copy blocks | `get_blocks_source_inner` (`render_clipboard_source`) | ReadBack | Needed |
| Edit as Markdown buffer, MCP `get_page_markdown` and `get_journal` | `get_page_buffer_inner`, `get_page_for_agent_inner` (`RenderMode::DOCUMENT`) | ReadBack | Every |
| Duplicate, template copies | `duplicate_block_inner`, `copy_page_blocks_in_tx` | ReadBack, with no name snapshot, so every id stays raw | Every |

The page copy and ZIP entry are one call: the ZIP drops the `# Title` line (`dropTitleLine` in `src/lib/export-graph.ts`) and resolves `attachment:<id>` refs to file paths, and the page copy resolves them to file names (`resolveAttachmentRefsForCopy`).

### HTML paste

HTML on the clipboard does not go through the Document reader. `src/editor/extensions/html-paste.ts` converts it with `htmlBodyToOutline` (`src/editor/html-to-blocks.ts`, inline marks through `createInlineTurndown` in `src/editor/inline-turndown.ts`) into blocks with depths and sends them as `PasteInput::Blocks`. Each block's content is kept as it comes; only a leading `- [ ]` checkbox is read as task state (`pasted_block`), and the first block pasted after text is taken verbatim.

### Mirrors

- **The TypeScript reader and writer:** `src/editor/source-buffer-document.ts` holds the Document grammar's twins: `parseDocument` for a buffer, `readPastedText` and `parsePastedText` for a paste, `parseMarkdownFile` for a Markdown file, and the writer's `DocumentLayout`, `pushDocumentLines`, `taskSignifier` and `writeTaskFields`. It follows the Rust grammar and defines none. The buffer editor (`src/editor/source-buffer-blocks.ts`) writes edited blocks with it, and page mode's paste reads text with it.
- **The Tauri mock** (`src/lib/tauri-mock/handlers/pages.ts`, `src/lib/tauri-mock/handlers/blocks.ts`) writes the export and the buffer with `renderPageDocument` and the copy (`get_blocks_source`) with the same layout, and reads with the mirrors above, `paste_blocks` through `readPastedText`. It writes no names, no attachment lines, and anchors only in the buffer. Its `import_markdown` models the `Markdown` reading alone.
- **Names and attachments:** `src/lib/name-tokens.ts` mirrors the name scan of `src-tauri/src/commands/pages/markdown_links.rs`, and `scanAttachmentRefs` in `src/lib/import-attachments.ts` the attachment refs of `detect_attachment_refs`.

### Pinned by

- `conformance/document-lines.vectors.json`: one case per hard case of the Document form, as the tree, the text a page holding it is written as and the id each line carries, plus `typed` and `pasted` texts with the tree they read as. Rust authors it (`the_document_lines_vectors_are_the_rows` in `src-tauri/src/commands/pages/markdown_document_tests.rs`, `CONFORMANCE_UPDATE=1`); `src/editor/__tests__/source-buffer-document.test.ts` asserts the TS reader and `src/lib/tauri-mock/__tests__/document-lines.test.ts` the mock's buffer.
- `conformance/block-content.vectors.json`: stored content and what Rust and the editor must agree it means. `src-tauri/src/commands/pages/markdown_source_tests.rs` authors the rows' reading and FTS text; `src/lib/__tests__/block-content-conformance.test.ts` runs the editor's save flush, parse and write-back over them.
- `conformance/reference-tokens.vectors.json` pins the name rules (`[[Name]]`, `#name`, heading anchors) and `conformance/attachment-refs.vectors.json` the attachment refs, each on both stacks.
- `conformance/fixtures/markdown_documents.json`, with the backend's renders beside it (`markdown_documents.export.txt`, `markdown_documents.clipboard.txt`): the export and the copy over one page. `markdown_imports.json` runs a Markdown import and a bibliography import on the backend alone; `import_markdown_plain.json` and `import_markdown_dialects.json` run one input on both stacks; `paste_blocks.json` and the `apply_page_source*.json` fixtures pin paste and the buffer save.
- The corpus under `src-tauri/agaric-engine/tests/markdown-corpus/`: real-shaped documents from each source tool. `corpus_documents_read_as_snapshotted` in `import.rs` snapshots each one's reading under `LogseqOrg`, as a buffer and as a paste (`src-tauri/agaric-engine/src/snapshots/`); the editor's property test round-trips each through the serializer.
- Property tests: `arb_document_forest` in `markdown_document_tests.rs` renders a page, reads it back and imports its export as a `Markdown` file; `src/editor/__tests__/markdown-roundtrip.property.test.ts` and `markdown-serializer.property.test.ts` hold the serializer's round trip.

A change to a written or read construct changes the Rust reader or writer, its TypeScript twin and the vector rows in one commit; `CONFORMANCE_UPDATE=1` re-authors the rows.

## Roving-editor invariant

Exactly one block hosts a `<EditorContent>` (TipTap) at any moment. Every other block renders as `StaticBlock` → `RichContentRenderer` (read-only). Focus changes unmount the editor from the previous block (persisting markdown via `persistUnmount`) and remount it in the new one.

This keeps:

- **Memory bounded** — editor instances scale with mounted `BlockTree`s, not with blocks.
- **Undo isolated** — each edit session has its own ProseMirror history.
- **DOM lean** — static blocks are pure presentational divs, not editor instances.

**The `Editor` is per mounted `BlockTree`, not per app.** The sentence above is about `<EditorContent>`: it is singular because focus is global, so at most one block anywhere is mounting the editor surface. The underlying `Editor` object is not a process-wide singleton — each `BlockTree` runs its own roving instance, and the journal week and stream views render one `DaySection` → one `BlockTree` per day (`src/components/journal/WeeklyView.tsx`, `src/components/journal/StreamView.tsx`, `src/components/journal/DaySection.tsx`); the month view renders a `MonthlyDayCell` calendar grid and mounts none. `useLazyRovingEditor` (`src/components/editor/useLazyRovingEditor.ts`) flips every mounted tree into constructing its own ~50-extension `Editor` on an idle callback, before any block in it is focused — up to 7 live editors in the weekly view (`WeeklyView.tsx` passes `lazyMount`, so a day gates its tree on entering the viewport). That is the bound the "memory bounded" line is really claiming: ~one editor per visible day, versus one per block.

This is why app-level editor access goes through the registry in `src/editor/active-editor.ts`, which holds the **most-recently-focused** editor and is published on the editor's `focus` event rather than on mount, "so the value tracks the caret rather than mount order". Code outside a tree — command-palette `[[Page]]` insertion, a global formatting action, a crash-flush — must read it (`getActiveEditor()`) and tolerate `null`. A module-level slot in `src/editor/` keyed on "the" editor and filled at mount time is won by mount order, and in a multi-day journal view will fire against the wrong day's document.

The `RovingEditorHandle` indirection (`src/editor/use-roving-editor.ts`) decouples the editor's lifecycle from React's render cycle.

## Picker plugins (inline references)

Five inline pickers share one mechanism (`src/editor/extensions/picker-plugin.ts` + `SuggestionList`): `BlockLinkPicker` (`[[`), `TagPicker` (`@`), `BlockRefPicker` (`((`), `SlashMenu` (`/`), `PropertyPicker` (`::`). Each is a TipTap extension that:

1. Registers an InputRule on the trigger character.
2. Mounts `SuggestionList` via `ReactRenderer` in a popup placed by `suggestion-placement.ts`, anchored to the trigger.
3. On select, inserts a node at the captured `insertPos`.

**Capture before await.** Every picker captures `insertPos = editor.state.selection.from` BEFORE its async IPC call. After the await, if `insertPos > editor.state.doc.content.size` (the doc shrank), it falls back to inserting at the current cursor. This is the documented contract; missing the guard is a classic stale-position bug.

**Never `instanceof TextSelection` / `NodeSelection` in app code.** `@tiptap/pm/state` can resolve to a *different module copy* than the one a given selection object was constructed from (multiple entry points re-export ProseMirror), so `selection instanceof TextSelection` is silently **always false** even for a genuine text selection. This broke the bubble menu once already. Duck-type on structural properties instead: `'node' in selection` distinguishes a `NodeSelection`; gate text-selection logic on `selection.empty` / `selection.from` / `selection.to`. The same hazard applies to any `instanceof` against a ProseMirror class (`Node`, `Mark`, `Fragment`). Always run the editor e2e (`npx playwright test e2e/*.spec.ts --workers=1`) locally before pushing a bubble-menu / selection change — unit tests mock the editor and miss this.

**Chip deletion.** Pressing `Backspace` immediately after a picker-inserted chip deletes the whole chip atom in one keystroke. The `tag-ref` / `block-link` / `block-ref` node types implement this on `Backspace`. (It does not re-expand to source text: the `@` / `[[` / `((` suggestion plugins only reopen on a user-typed trigger char, so re-inserting text would leave an inert string behind — the user retypes the trigger to open the picker again.)

## Auto-split on blur

When a block's content (after editing) contains newlines outside code fences, blur splits it into multiple blocks. `shouldSplitOnBlur(markdown)` returns true when the post-parse doc has more than one top-level node; the store action `splitBlock(blockId, markdown)` performs the split.

Code blocks and headings are exceptions: a heading-marker (`#`) or fence (` ``` `) at the start of an empty block converts that block in place rather than splitting.

## FE / BE authority boundary

The single load-bearing rule of editor architecture:

- **FE is authoritative for in-progress local edits.** Until you blur, your changes live in TipTap state + (debounced) `block_drafts`. They are not yet a committed op.
- **BE is authoritative for post-flush state.** On blur, the editor unmounts, the FE serialises to markdown, and the store dispatches the right op (`edit_block` / `splitBlock` / `merge` / etc.). The op is the authoritative record.
- **Handover is unmount — plus idle-debounced checkpoints (#2600).** Blur (unmount) is still the final commit, but content is *also* committed on a short idle debounce while typing (`useDebouncedContentCommit`, ~700 ms), so the op log is checkpointed mid-session rather than only at unmount. There is still **no per-keystroke IPC** and no live-merge of your in-flight (post-last-debounce) keystrokes; the debounce just shrinks how much un-committed text the window holds.

Edge cases the contract acknowledges:

- **Until you blur, your edits are not durable.** A hard kill mid-edit recovers from `block_drafts` on next boot (Recovery step 3). A power failure mid-keystroke can lose at most the typing since the last debounce.
- **Typing during sync.** No pause-sync-while-typing lock; the FE editor and the sync daemon run independently. Remote ops applied during your edit are written to the underlying block; on blur, your FE markdown becomes the new committed content. **This is effectively block-level last-write-wins for the un-committed tail (#2459):** a remote edit that landed on the block you were typing in can be superseded by the next commit of your content — the two are not character-merged in-session, because your not-yet-committed keystrokes were never individual ops. **#2600 shrinks this window:** because content is now committed on a short idle debounce (not only at blur), each commit's `to_text` is diffed against a much fresher base, so far less overlap is lost — but the window is not zero (the keystrokes since the last debounce tick are still un-committed). The CRDT's character-level merge (`apply_edit_via_diff_splice`) governs *committed* concurrent edits: two devices editing different regions and committing frequently converge losslessly; only the un-committed in-session tail resolves at block granularity. The superseded version persists in `op_log` for undo / history view. This is the deliberate trade for a keystroke-latency-free editor with no per-keystroke IPC.

`useEditorBlur` enforces a five-step guard chain before unmount: (1) no active block → no-op; (2) blur from a stale element → no-op; (3) early-persist (debounced save); (4) portal + visible-element scan via the single `[data-editor-portal]` attribute selector (replaces the legacy 8-class array); (5) unmount + save-or-split.

## Keyboard

Two hooks with similar names; the split matters:

- `src/editor/use-block-keyboard.ts` — attaches a capture-phase DOM listener on `editor.view.dom.parentElement`. It pre-empts ProseMirror for keys that must fire before the editor (Enter to split, Backspace at start to merge, indent/dedent).
- `src/components/block-tree/use-block-action-orchestration.ts` — the high-level action handlers (`handleEnterSave`, `handleDeleteBlock`, …). Re-entrancy refs (`enterSaveInProgress`, `deleteInProgress`) guard against double-fire from rapid keystrokes.

Suggestion-popup passthrough: when a picker is visible, `Enter / Tab / Escape / Backspace` go to the picker, not the block handler. The block handler checks `isSuggestionPopupVisible()` before processing.

`Tab` / `Shift+Tab` (#912) ARE bound to indent / dedent the focused block — the universal outliner restructure key (Logseq, Workflowy, Roam, Notion). `Ctrl+Shift+→` / `Ctrl+Shift+←` is the secondary alias. #3276 — suppressed inside a table (falls through to `@tiptap/extension-table`'s own `goToNextCell`/`goToPreviousCell` keymap) and inside a code block (falls through to browser/keymap focus handling), same guard as the Enter rule above.

`flushSync` on blur: when `handleBlur` calls `edit()` or `splitBlock()`, wrap in `flushSync()` so the store update renders before the editor unmounts. Otherwise the editor disappears before the save completes.

## Multi-selection

`useBlockStore.selectedBlockIds: string[]` carries the selection set. `Shift+Click` extends, `Ctrl+Click` toggles, `Ctrl+A` selects all visible. Keyboard focus is kept apart from the selection, as in a WAI-ARIA multi-select listbox: `selectionFocusId` is the cursor (`selectCursorBlockId` falls back to the last selected block), `Ctrl+↑` / `Ctrl+↓` move it and `Ctrl+Space` toggles it, both only while focus is in the tree's rows, `Shift+Arrow` ranges from it and `Ctrl+A` leaves it where it is. The cursor row holds DOM focus, and every change of the selection count, the first selection and the clear included, is spoken through `announce()` (a subscription in `src/stores/blocks.ts`). Editing a block clears selection — modes are mutually exclusive on purpose (you're either editing one block or selecting many).

## Undo / redo

Two-tier:

- **In-editor undo**: ProseMirror history. Scoped to one edit session. Survives only until the editor unmounts.
- **Page-level undo**: `UndoStore` over the op log. Reversed via `src-tauri/agaric-engine/src/reverse/` (one reverse-op per source op type; see table below). Coalesces consecutive ops within `UNDO_GROUP_WINDOW_MS`; redo stack capped at `MAX_REDO_STACK`. Both constants live in `src/stores/undo.ts`.

### Addressing model (#2468)

Page-level undo is **op-ref addressed**: each mutating command returns the `OpRef`s it produced (`WithOps<T> = T & { op_refs: OpRef[] }`, captured backend-side via the `LAST_APPEND` task-local, so the refs are exactly this invocation's appends — never "latest"). `UndoStore` entries carry those refs; Ctrl+Z submits them to `undo_op` (single) or `undo_ops` (coalesced group, one atomic transaction, `NonReversible` aborts the whole set). This kills the positional-offset race class (#2446): an op appended between the user's intent and the IPC cannot shift the target. The backend verifies each ref in-transaction — local (`is_replicated = 0`, the #2481 implicit-undo scoping: replicated foreign ops are only revertible through the explicit History-view `revert_ops` path), forward (`is_undo = 0`), and not already reversed (via `op_log.reverses_device_id/reverses_seq` provenance, migration 0101; a target is "currently reversed" while an unreversed reverse of it exists, so undo→redo→undo cycles stay legal).

The **positional** path (`undo_page_op` / `undo_page_group`, `LIMIT 1 OFFSET undoDepth` — the documented invariant-#3 carve-out) survives as the fallback for call sites that do not thread refs and for history predating ref tracking; `undoDepth` is display/fallback state only. Redo is unchanged: the redo stack already held refs, and a redone group's `new_op_ref`s are pushed back as one ref entry.

Reverse-op table (canonical):

| Source op | Reverse op |
| --- | --- |
| `create_block` | `delete_block` (soft delete) |
| `edit_block` | `edit_block` with the text the edit overwrote (`prior_text` when recorded, else the text its `prev_edit` names); for a page or tag, refused while another live page or tag of its space holds that name (#6051) |
| `delete_block` | `restore_block`; refused while another live page or tag of the space holds the name of a page or tag it would revive (#6051) |
| `restore_block` | `delete_block` |
| `purge_block` | **non-reversible** |
| `move_block` | `move_block` to the parent + slot the move recorded (`prior`); **non-reversible** when it recorded none and the op log holds none, and refused while that parent is trashed, under the block, or in another space than the block (#6047) |
| `set_property` | `set_property` with the value the set recorded (`prior`), or `delete_property` if the key was absent; for `space`, a move back, refused while another live page or tag of that space holds the moved page's or tag's name (#6099) |
| `delete_property` | `set_property` with the value the delete recorded (`prior`) |
| `add_tag` | `remove_tag` |
| `remove_tag` | `add_tag` |
| `add_page_alias` | `remove_page_alias` |
| `remove_page_alias` | `add_page_alias`; refused while another page holds the alias |
| `add_attachment` | `delete_attachment` |
| `delete_attachment` | conditional: `add_attachment` with captured metadata if available; otherwise non-reversible |
| `set_property_def` | `set_property_def` with `def` and `prior` swapped |
| `rename_property_key` | `rename_property_key` back; refused while the space declares or holds the old key |
| `rename_property_option` | `rename_property_option` back, under the key the definition has now; refused, as the rename is, when the definition is gone, is no longer a select, lists the old name again, or a block holds it |
| `rewrite_properties` | `rewrite_properties` with each write's new and prior state swapped; a merge's definitions refused as a `set_property_def` reverse is. The swapped writes are absolute, so a merge's undo puts each moved value back under the merged key and the target key's prior value (none, where the block held none) back under the target, over an edit made to the moved value since. A type change's writes back each value the change converted to another form, over a value written since; any other value re-reads under the old type: a string lands in its column, or in `value_text` when the type does not take it, and a number or boolean keeps its column |

Each op records what it overwrites, read from the materialised state in its transaction, because the op log cannot always supply it: a value a peer set or deleted, a block a peer created or moved, and a peer's edit arrive through the engine with no local op behind them (#5918, #6014, #6046). A `set_property` or `delete_property` records the value as `prior` (all five slots empty when a set found the key absent); a `move_block` records the block's parent and slot as `prior`; an `edit_block` points `prev_edit` at the newest op whose text is the block's live content, and records that text as `prior_text` only when no op holds it, as after a Loro merge. A reverse `set_property` or `move_block` that an undo or redo appends records its `prior` the same way (`with_recorded_prior_in_tx` in `commands/history.rs`), so undoing it restores what was live when it ran. A reverse falls back to the op log only for an op that records nothing, such as one written before the field existed. A reverse `set_property` is also fitted to the type its key has now (`fit_reverse_to_declared_type`, #5841): a value set before the key changed type is converted as the type change converted the key's other values, and one the type does not take goes back in the slot of its own kind, a string as text, as the projection keeps it (#6206); a value whose slot the type takes is written as it is, a select value outside the options included, as an options edit leaves such a value shown. A reverse `set_property` or `delete_property` is written under the key its value lives under now (`forward_property_key` in `reverse/property_ops.rs`, #5841): the op's key followed through each rename and merge of the block's space after the op, a peer's included, in log order, the batch's own reverses among them. A rename is its own inverse on its two names: a walk on its target, whose value was gone before it, takes the name it vacated rather than landing on the value it moved. A merge moves the key with a value it moved; a value it dropped, and the empty key a merge moved another key's value into, stay where they are. A reverse `set_property`'s value follows each `rename_property_option` of the key as walked so far, from the old name to the new one only: no block held the new name when the rename ran, so a value equal to it is an older, different one. A reverse `rename_property_option` follows the space's key renames the same way (`forward_definition_key`), not its merges, which delete the definition they merge away, and is appended under the key it renamed under. A group of moves that recorded their placement is reverted newest-first; the ascending `(parent, slot)` order is kept for moves rebuilt from the op log.

## Recurrence

Repeating tasks rely on a shared per-block projection function (`src-tauri/agaric-store/src/recurrence_math.rs::project_block_dates`) that both the cache rebuild (`projected_agenda_cache`) and the on-the-fly fallback (`list_projected_agenda_on_the_fly`) call. The function owns: rule parsing (`+` / `.+` / `++` mode dispatch), `plus_plus` catch-up + pre-emit, `until_date` / `remaining` end conditions, the 10 000-iter safety bound, and `[range_start, range_end]` clipping. The two callsites disagreed once on `.+1w` projection — the parity test `projected_agenda_cached_equals_on_the_fly` pins agreement.

Marking a repeating task DONE rolls it forward: a synthetic new occurrence is generated, `repeat-seq` increments, the previous occurrence stays as a completed entry in History.

## Viewport rendering

The block tree uses an `IntersectionObserver` placeholder pattern (`SortableBlockWrapper`): offscreen blocks become zero-height placeholders to preserve scroll position, while keeping the React tree mounted. The focused block is never virtualised — its editor state must survive scroll. DnD overlays the placeholder pattern with `WhileDragging` measurement so drag-and-drop sees real depths.

A tree renders only its first `INITIAL_WINDOW_ROWS` (30, `BlockListRenderer`) rows in full when they mount; every row that mounts past them, on the first commit or later (an expanded parent's children), mounts as a placeholder at the `StaticBlock` minimum height, carries `data-placeholder`, and is seeded off-screen when it attaches, so the observer's first callback hydrates only the rows that intersect instead of a 500-block page rendering all 500 once (#5329). Hydration (placeholder → block) is spread over animation frames, `HYDRATION_ROWS_PER_FRAME` (4, `useViewportObserver`) per frame in report order; flipping a row off-screen stays synchronous. The scroll-parent walk that picks the observer root runs once per commit, not once per attaching row (#5330). Measured row heights outlive the tree: a row is measured when it scrolls out and, if still on screen, as it detaches, so a page the user returns to lays its placeholders out at the heights they left and the #754 scroll restore lands on the same row. A navigation that focuses its target renders that row in full on the same commit, so a placeholder target needs no observer round-trip. A scroll to a block it does not focus (the page outline) jumps the block to the top: a smooth scroll hydrates every row it passes, each grows past its estimate, and the scroll lands short.

Note the phrase "keeping the React tree mounted": the IntersectionObserver pattern above is a *paint* optimization, not a *mount* one. An offscreen block stops painting, but its `SortableBlockWrapper` fiber, hooks, and listeners stay live. On a large flat page (or one the user hasn't collapsed) that means one mounted fiber per block regardless of viewport — see § Mount envelope below for the FE-side bound on that.

## Mount envelope (#2467)

The backend has a precise, bench-validated envelope (`docs/architecture/operations.md` § Memory footprint & scaling envelope; `interactive_slo.rs` gates the **weekly** `bench-slo` lane at 100K blocks/space — not a per-PR check; see `src-tauri/benches/AGENTS.md`) and a hard per-page load cap (`PAGE_SUBTREE_MAX_BLOCKS = 10_000` in `commands/pages/listing.rs`, surfaced to the user via `blockTree.truncatedNotice`). Until #2467, the frontend had no counterpart: every block `load_page_subtree` returned was mounted as a React component, so a page anywhere near the backend's 10K cap meant 10K mounted fibers — the "full-tree mounting" cliff the frontend architecture review flagged.

**What exists today (this slice):** `useBlockMountLimit` (`src/components/block-tree/use-block-mount-limit.ts`) caps how many of the collapse-filtered rows actually mount, applied in `BlockTree.tsx` immediately after `useBlockCollapse` and before zoom/DnD/keyboard-nav — everything downstream of that point only ever sees the capped set, so the mount cap composes with collapse instead of conflicting with it.

- **`INITIAL_MOUNT_LIMIT = 500`** rows mount on first render of a page.
- **`MOUNT_LIMIT_STEP = 500`** more rows mount per click on the boundary row (`BlockListRenderer`'s `block-tree-mount-boundary`), which reports how many rows remain hidden (`blockTree.mountBoundary`, i18n-pluralised).
- Rows beyond the limit are **not mounted at all** — not placeholders, absent from the DOM — until revealed. The limit resets when the page changes (`rootParentId`), mirroring the per-page collapse-state reset (#752); BlockTree is not remounted on page switch (journal week/month views swap pages in place), so without the reset an expanded limit on one large page would leak into the next.

**Measured envelope (#2467 Measure phase).** The bench fixture that produces the numbers below is `src/components/editor/__tests__/BlockTree.scale-envelope.test.tsx` — it renders the real `SortableBlockWrapper` fiber per row (the mount cost `useViewportObserver`'s placeholder pattern does *not* shrink, per § Viewport rendering above) through `BlockListRenderer`, with only the leaf `SortableBlock` stubbed out, at 1,000 / 10,000 flat blocks/page (the 5,000 row below is from the original three-size Measure run). It records `buildFlatTree` time, the store-array copy + `splice` every mutating reducer performs (mirrors `createBelow` in `page-blocks-reducers.ts`), the one-time initial mount, and the incremental re-render once one more block is spliced in (the steady-state "user created/edited a block" cost). The re-render figure is a deliberate **upper bound**: the fixture passes fresh props that bust `SortableBlockWrapper`'s `memo`, so it re-reconciles every mounted row rather than only the changed one — real incremental edits re-render far fewer fibers, so the true steady-state cost is lower than the table's re-render column (this only strengthens the "500 is conservative" conclusion below). Representative numbers from a happy-dom run on CI-class hardware:

| Blocks/page | `buildFlatTree` | splice (copy+insert) | Initial mount | Re-render after splice |
| --- | --- | --- | --- | --- |
| 1,000 | ~0.7 ms | ~0.03 ms | ~275-400 ms | ~150-185 ms |
| 5,000 | ~2.2-3.2 ms | ~0.02-0.03 ms | ~625-870 ms | ~460-660 ms |
| 10,000 | ~4.4-6.6 ms | ~0.03-0.07 ms | ~1,200-1,565 ms | ~800-970 ms |

**Provenance, and how much these absolute numbers mean.** This table is a *transcription of the #2467 Measure-phase run*, not a live view of the fixture: running the test does not refresh it, so treat the figures as one recorded machine, not as current. Run-to-run jitter on a fixed machine is roughly ±15%, but the machine-to-machine and load spread is far larger — over three runs a 16-core developer box near idle measured 0.4 ms / 130-144 ms / 85-93 ms at 1K and 2.0-2.1 ms / 672-824 ms / 393-530 ms at 10K (roughly *half* the table), while the same box at load average 22 measured 2.6-2.9 s for the 10K mount (roughly *double* it). The table is therefore useful as an order-of-magnitude, slower-end reference; re-run the fixture and note the machine if you need current numbers. What does *not* move with the machine is the shape of the curve, and #4013 pinned that shape as exact load-invariant read counts inside the fixture (`7n - 2` for `buildFlatTree`, `34n` for mount and for re-render) — the conclusions below rest on those, not on the milliseconds.

**Interpretation.** `buildFlatTree` and the splice itself are not the bottleneck at any of these scales — both stay under ~7 ms even at 10K, three orders of magnitude below the mount/re-render numbers; the entire scale-envelope story is React mount/reconciliation cost, not the flat-tree derivation or array surgery. That cost grows *sub-linearly* with block count (roughly 4-5x from 1K→10K, not the ~10x a linear relationship would predict, and nowhere near the ~100x an O(n²) regression would produce) — there is no sudden cliff in this range, just steadily increasing absolute cost. The knee that matters is in absolute terms: at 1,000 blocks, mount already costs ~275-400 ms and a single post-mount edit ~150-185 ms — both at the edge of what reads as instantaneous; by 5,000-10,000 blocks (approaching the backend's `PAGE_SUBTREE_MAX_BLOCKS` cap) mount costs over a second and every edit costs several hundred milliseconds — a clearly perceptible stall on each block creation. `INITIAL_MOUNT_LIMIT = 500` sits below every measured scale here, so its extrapolated cost (roughly half the 1,000-block numbers, i.e. low hundreds of ms for mount and under ~100 ms per edit) stays comfortably clear of the 5K-10K knee where lag becomes obvious to a user. The numbers therefore justify `500` as a genuinely conservative cap rather than an arbitrary one — there is measurable headroom to raise it (the sub-linear curve suggests 1,000-2,000 would still be tolerable) but 500 was already sitting on the right side of the cliff, not guessing at where the cliff was.

**What this does NOT cover** (left for later phases, per #2467's suggested scope):

- **No true virtualization.** Rows within the cap still cost a full mounted fiber each; this only bounds the ceiling, it doesn't reduce steady-state cost below it. Real windowed rendering (DOM recycling) for non-focused static rows remains open.
- **No fold-aware lazy loading via `load_page_subtree` depth limits.** The backend command is unchanged — it still returns (and the store still holds) every block up to `PAGE_SUBTREE_MAX_BLOCKS` in one shot; the mount cap only bounds what renders from that already-loaded set. Adding a `limit`/depth parameter to `load_page_subtree` so the backend itself streams a page incrementally is a natural next phase and was deliberately left alone here (Rust command surface, out of scope for this slice).
- **No store-level chunking.** `usePageBlockStore`'s `blocks` array still holds the full loaded set; only the render path is capped.
- **Batch metadata IPCs are not scoped to the mounted set.** `useViewportWindow`'s `windowedBlocks` (properties/attachments/link-resolve batching, #1268) conservatively treats any never-measured block as "in window" — including mount-cap-excluded blocks, which are never measured because they're never mounted. This is a pre-existing characteristic shared with manually-collapsed subtrees (same gap, smaller blast radius before this change); scoping it to the mounted set is a cheap, low-risk follow-up.
- **DnD across the mount boundary is not specially handled.** Dropping "after the last mounted row" is a valid position (it lands immediately before the first hidden block), so no special-casing was needed for the common case, but dragging a mounted block whose subtree extends past the boundary won't visually carry its unmounted descendants during the drag (the backend move itself is still correct — children move via `parent_id`, independent of what the FE had mounted).

## Zoom-in

Block zoom is a per-block focus mode. The breadcrumb in the page header shows `Page › Section › Block`; clicking a breadcrumb segment zooms out. Zoom state is ephemeral (not persisted, not synced) — closing the page or navigating away resets to the page root.
