# Agaric and Obsidian

> **As of November 2026.** Agaric is described as it is on `main`, from its code and [docs/FEATURE-MAP.md](docs/FEATURE-MAP.md). Obsidian is described from its own help, site, changelog and roadmap ([Sources](#sources)); it was not installed or run. "Core" means Obsidian with its core plugins and nothing from the community directory. An Obsidian claim that could not be confirmed in those sources was left out.

Obsidian is the larger, older and more widely used tool, and for most people who already use it the answer is to stay. This page says where the two differ, who is better served by which, and what an import of a vault keeps. The sibling page compares [Agaric and Logseq](COMPARISON-LOGSEQ.md).

## One difference explains most of the others

- **Obsidian's unit is a file.** A vault is a folder of Markdown files that any other tool can read and change. Properties, links, tasks and embeds are text in those files, and a paragraph becomes addressable only once a `^id` is added to it.
- **Agaric's unit is a block.** Every paragraph is a row with its own id in one database, written as operations and merged through a CRDT. A page is a block that holds blocks, and links, tags and references store ids, not names.

Obsidian is ahead wherever files being the truth matters: other editors, any sync or backup tool, git, an agent that just reads the folder. Agaric is ahead wherever addressable blocks and recorded operations matter: properties and task state on any block, references that survive renames, history per block, and sync that merges without conflict files.

## The differences that decide it

| | Obsidian | Agaric |
| --- | --- | --- |
| Where notes live | Markdown files in a folder you choose | A SQLite database. A Markdown mirror folder is optional and desktop only |
| Licence and price | Closed source, free for personal and commercial use. Sync and Publish are paid subscriptions | Free software (GPL-3.0-or-later). Nothing to buy |
| Sync | Obsidian Sync: any network, through Obsidian's servers, end-to-end encrypted, with version history, selective sync and shared vaults. Or a third-party tool such as iCloud, Syncthing or git | Directly between your own paired devices on one local network. No account, no server, no subscription. Android syncs only in the foreground |
| Phones | iOS and Android, from the stores, with widgets and, on iOS, a share sheet and quick capture | Android as a sideloaded APK. No iOS |
| Extending it | A community plugin API and directory, themes, CSS snippets, a CLI and a URI scheme. Plugins are not sandboxed: they inherit the app's access | No plugins or scripting, so no third-party code runs in the app. A custom stylesheet, rebindable keys, `agaric://` links, and an MCP server |
| Who makes it | A company with paying customers and independent security audits | One maintainer, pre-1.0, unsigned desktop installers |

## Feature by feature

The table is the summary. [The feature matrix](COMPARISON-OBSIDIAN-MATRIX.md) has the row-by-row detail, with a status and the code behind each Agaric cell, and ends with a [scorecard](COMPARISON-OBSIDIAN-MATRIX.md#scorecard) that counts the rows by status. Counted that way, Agaric is behind Obsidian core in more rows than it is level or ahead; its leads are structural (addressable blocks, properties on any block, merging sync, history, the licence) and Obsidian's are reach and surface.

| Area | Obsidian | Agaric |
| --- | --- | --- |
| Editing | Live Preview, source mode and reading view over one file | Block mode with the Markdown syntax shown at the cursor; page mode (the whole page as one document, off by default, with a block cap per page); *Edit as Markdown* for the page as plain text |
| Outlining | Lists in a document | The whole app is an outline: indent, drag, zoom, collapse, multi-select and move blocks |
| Editor extras | Vim key bindings, multiple cursors, `%%comments%%`, highlight colours, slides | None of those. One highlight colour |
| Tables, math, diagrams, callouts, footnotes | All built in | All built in; callouts show in a fixed set of styles |
| Links | `[[Note]]`, `[[Note#Heading]]`, `[[Note#^id]]`; names in the file | The same forms can be typed; stored as ids and shown as chips. A rename changes no other block |
| Embeds | `![[Note]]`, headings, blocks, images, audio, video, PDF | Pages, headings and blocks, live, text only: an embedded row shows no checkbox, properties or attachments |
| Backlinks | Linked and unlinked mentions, and an outgoing links pane | Linked and unlinked references with filters. No outgoing links pane |
| Properties | In a note's YAML front matter, so per file: text, list, number, checkbox, date, date and time | On any block or page: text, number, date, select, reference, boolean, URL. One value per property: no list type and no date-time |
| Tables of notes | Bases: table, list, cards and kanban layouts over files, with computed columns ("formulas"), summaries and grouping; dragging a kanban card changes its property | Query blocks as a list or a table; Advanced Query with grouping, summaries and a board whose cards move from a menu, not by dragging. Rows are blocks. No computed columns (Bases calls them formulas), no cards layout, no editing in table cells |
| Tags | `#tag` and nested `#a/b` | `#tag`, renamed everywhere from one place; `/` in a name is a naming convention with prefix search; boolean tag queries |
| Tasks | Checkboxes and `task:` search in core. The help documents no due dates, priorities or recurrence for tasks; community plugins such as Tasks add them | States, priorities, due and scheduled dates and repeat rules on any block; an Agenda; due-date notifications on desktop. Reads and writes the Tasks plugin's emoji fields on import and export |
| Daily notes | A core plugin: one note per day from a template | A journal with day, week, month, stream and agenda views |
| Search | Operators (`file:`, `path:`, `tag:`, `task:`, `[property:value]`), regex, `OR`, negation, embedded queries | Full-text search with typed filters (`tag:`, `state:`, `due:`, `prop:`), regex, find and replace in a page and across pages, query blocks |
| Canvas | Core, saved as JSON Canvas | None |
| Graph | Global and local, with colour groups | Global and local |
| Windows | Tabs, stacked tabs, pop-out windows, saved workspaces | Tabs, back and forward. One page on screen at a time |
| Contexts | Separate vaults | Spaces inside one database, each with its own journal, pages, tags and property definitions |
| PDF | A viewer, and export of a note to PDF. Annotation is on the roadmap, not shipped | A viewer with highlights and pinned comments, each saved as a block. *Print…* hands a page to the system's print dialog; no export to PDF of its own |
| Voice | An audio recorder; voice capture on iOS | `/voice` records a voice note; the system voice reads a block or page aloud on macOS, Windows and Android. No transcription |
| Web capture | An official Web Clipper for the major browsers | None. Pasted HTML becomes blocks, and an `agaric://capture` link opens Quick Capture on desktop |
| Publishing and sharing | Obsidian Publish; shared vaults through Sync; real-time collaboration is on the roadmap | None; single user by design |
| History and recovery | File recovery snapshots on the device; version history in Sync | Every change is an operation: history per block and page, restore to a point, an in-app Trash. Old operations are compacted after a retention period. A daily copy of the database is kept beside it |
| Agents and automation | A CLI that drives the running app, `obsidian://` links, a headless Sync client. An agent can also edit the files directly. No first-party MCP server was found | An MCP server with an agent per client: its own token, read-only or read-write mode and spaces, edits named in History and undoable. `agaric-mcp call` for scripts |
| Importers | An official importer for Notion, Evernote, OneNote, Apple Notes, Google Keep, Bear, Roam, Logseq and more | Markdown, Obsidian vaults, Logseq graphs, Org, Notion, Evernote, Joplin, bibliographies |
| Languages | Many interface translations; right-to-left layout | English, with Spanish for error messages and a few settings. Right-to-left paragraphs in notes, not a right-to-left interface |
| Encryption at rest | None for the local vault | None for the local database |
| Telemetry | None | None |

## Where Obsidian is the better tool

- **You want your notes as files**, readable and editable by anything, with any backup or sync tool.
- **Your devices are not on one network**, or you use an iPhone or iPad.
- **You want plugins**, community themes, a CLI, or a workflow someone has already built.
- **You keep a database of notes**: Bases, list properties, cards and a draggable kanban.
- **You think visually**: Canvas, and drawing through plugins.
- **You clip the web, publish a site, or share a vault.**
- **You want Vim keys, multiple cursors, split or pop-out windows.**
- **You need the interface in your language.**
- **You want a company, security audits and store builds behind the tool.**

## Where Agaric is the better tool

- **Outliner first.** Blocks, zoom and references are the model, not a layer over a document.
- **Tasks and a journal without plugins.** States, dates, priorities, repeat rules, an Agenda and week, month and stream views come with the app.
- **Sync between your own devices at no cost and with no third party**, merging concurrent edits without conflict files. Only on one local network.
- **Properties and task state on any block**, with select and reference types.
- **Rename safety and history.** Links hold ids, and every change to every block can be inspected and reverted.
- **PDF highlights and comments as blocks**, today.
- **Scoped agent access.** Each MCP client has a mode and a set of spaces, and its edits are named and undoable.
- **Free software**, with no third-party code running inside it.

## Moving from Obsidian

Settings › Data has an *Obsidian vault* button. [docs/features/import-export.md](docs/features/import-export.md) has the full rules.

**Kept:** each note as a page, with folders as title namespaces (`Projects/Plan`); `[[wikilinks]]`, labels and aliases; `#Heading` and `#^id` anchors as references to those blocks; `![[Note]]` embeds; front-matter properties, tags and aliases; `- [ ]` tasks with the Tasks plugin's date, priority and recurrence fields; callouts; attached images and files, with image widths.

**Changed or lost:**

- The vault stops being files. On desktop the Markdown mirror writes every page back out as a `.md` file and reads edits in, but it starts from an empty folder: it does not adopt an existing vault in place.
- A YAML list becomes one comma-joined value, except `tags` and `aliases`.
- `.canvas` and `.base` files are not imported.
- Dataview, Templater and other plugin code blocks stay as text.
- `%%comments%%` have no equivalent and stay as visible text.
- A link becomes an id. Every text surface (export, copy, *Edit as Markdown*, the mirror) writes it back as `[[Title]]`.

An export from Agaric is Markdown that Obsidian reads: wikilinks, `^id` block links, `![[ ]]` embeds, front matter and Tasks-style fields.

### What you will miss, or trip over, at first

- **The vault is no longer a folder.** Git, iCloud, Syncthing, a second editor and every script that walks your files stop applying. The desktop mirror writes files back out, but cannot take over the vault you already have (#6540).
- **Every paragraph is a block.** A page is an outline, with a handle per paragraph, until you turn on page mode (off by default, #6536). There is no reading view, and long pages past the page-mode cap stay in blocks (#6224).
- **Your plugins do not come with you.** Dataview and Templater blocks arrive as code, and there is no Canvas, Excalidraw, or community theme. Tasks-plugin dates, priorities and recurrence are the exception: Agaric reads them as its own.
- **No folders.** A note in `Projects/Plan.md` becomes the page `Projects/Plan`; spaces, not folders, separate work from personal.
- **List properties flatten.** `authors: [a, b]` becomes one text value (#6741), and there is no date-and-time type (#6758).
- **One page at a time.** Tabs, but no split, no pop-out window, no saved workspace (#6550).
- **Editor habits.** No Vim keys, no multiple cursors, one highlight colour (#6759), and `%%comments%%` show as text (#6751).
- **Nested tags are names.** Searching `projects/` finds `projects/web`; searching the parent tag does not (#6760). A tag name holds no spaces.
- **Sync means the same Wi-Fi, with the phone's app open** (#6519, #6740), on Android only, installed from a file (#79). No iPhone or iPad (#6739).
- **Capture is thinner.** No web clipper (#6753) and, for now, nothing in Android's share sheet (#6555).
- **English**, mostly (#6750).

## Sources

Obsidian, read in November 2026:

- <https://obsidian.md/pricing>, <https://obsidian.md/sync>, <https://obsidian.md/license>, <https://obsidian.md/privacy>, <https://obsidian.md/security>, <https://obsidian.md/download>
- <https://obsidian.md/changelog> and <https://obsidian.md/roadmap>
- The help, from its source at <https://github.com/obsidianmd/obsidian-help>: storage, properties, internal links and embeds, Bases and its layouts, search, core plugins, file recovery, PDFs, Sync (security, plans, conflicts, selective sync, shared vaults, headless), plugin security, the CLI, the URI scheme, mobile, import, Web Clipper
- <https://github.com/obsidianmd/obsidian-releases>, for the statement that Obsidian is not open source

Not confirmed from those sources, and so not claimed above: whether community plugins run on mobile, whether search indexes attachment text, read aloud in Obsidian, and what the Tasks and Dataview plugins do beyond the fields Agaric's importer reads.
