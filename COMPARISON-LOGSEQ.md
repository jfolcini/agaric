# Agaric and Logseq

> **As of November 2026.** Agaric is described as it is on `main`, from its code and [docs/FEATURE-MAP.md](docs/FEATURE-MAP.md). Logseq is described from its own README, documentation and announcements ([Sources](#sources)); it was not installed or run. A Logseq claim that could not be confirmed there was left out.

Agaric started as its author's replacement for Logseq, and the two share an outline of blocks, a daily journal, `[[links]]`, tags, properties, tasks and queries. This page says where they differ, where each is the better tool, and what an import from Logseq keeps. The sibling page compares [Agaric and Obsidian](COMPARISON-OBSIDIAN.md).

## Which Logseq

Logseq is two products today:

- **The file version** ("Logseq OG") stores a graph as Markdown or Org files on disk. Its team keeps it maintained with security and Electron upgrades and adds no new features.
- **The DB version** stores a graph in SQLite and is where development happens. Its README calls it a beta, calls the new mobile app and the real-time sync alpha, and warns that data loss is possible.

Rows below say which one they mean where it matters.

## The differences that decide it

| | Logseq | Agaric |
| --- | --- | --- |
| Where notes live | File version: Markdown or Org files, which any tool can read. DB version: a SQLite database | A SQLite database. A Markdown mirror folder is optional and desktop only |
| Sync | DB version: through a server, over the internet, with real-time collaboration between users. A paid feature for Open Collective backers and sponsors, or self-hosted. File version: its docs describe Logseq Sync, a paid beta for the same contributors; the files can also be carried by any file-sync tool | Directly between your own paired devices on one local network. Free, with no account and no server. Android syncs only in the foreground. Single user |
| Phones | File version in the App Store and on F-Droid. For the DB version a native iOS app is in testing with backers, and Android testing has been announced | Android as a sideloaded APK. No iOS |
| Extending it | A plugin API and marketplace, custom CSS and JS, a CLI, a local HTTP API, an MCP server | No plugins or scripting. A custom stylesheet, rebindable keys, and an MCP server |
| Data model | DB version: tags are classes with inherited properties; properties are typed and can hold several values | Tags are labels. Properties are typed, one value each |
| Who makes it | A team funded by its backers, with a large community | One maintainer, pre-1.0 |

## Feature by feature

The table is the summary. [The feature matrix](COMPARISON-LOGSEQ-MATRIX.md) has the row-by-row detail, with a status and the code behind each Agaric cell, and ends with a [scorecard](COMPARISON-LOGSEQ-MATRIX.md#scorecard): the rows counted by status, and each product scored by category. In points Agaric comes out slightly ahead of Logseq's DB version, inside the margin of such a sum, and well ahead of the file version; by category it leads on journal, search, spaces, sync, data integrity and agent access, and trails on linking, properties, tags, queries and ecosystem.

| Area | Logseq | Agaric |
| --- | --- | --- |
| Outline | An outliner. The file version writes a block's collapsed state into the file (`collapsed::`) | An outliner whose blocks nest to `MAX_BLOCK_DEPTH`. Collapse state is per device and does not sync |
| Writing a page as one document | An outliner throughout: a page is edited block by block | Block mode, plus page mode (one editor for the page, off by default) and *Edit as Markdown* (the page as plain text) |
| Block references | File version: `((uuid))`. DB version: blocks are referenced with `[[ ]]` like pages | `((id))` shows a one-line chip with a hover peek, not the block's content |
| Embeds | An embed shows the whole block | An embed shows a block or page live, text only: no checkboxes, properties or attachments in its rows. Text is editable in place after an unlock; structure is not |
| Properties | DB version: Text, Number, Date, DateTime, Checkbox, Url and Node types; several values per property; defaults and choices; properties that list their reverse side | Text, number, date, select, reference, boolean and URL. One value per property. Definitions are per space, sync, and can be renamed, merged and retyped |
| Tags | DB version: a tag is a class ("supertag") whose properties its nodes inherit, with parents through `Extends` | A tag is a label with a colour and its own listing page. `/` in a name is a naming convention with prefix search. No classes |
| Queries | Simple queries and Datalog advanced queries with custom views and result transforms. DB version: a query builder, and table, list and gallery views with filter, sort and group | A visual builder with nested AND / OR / NOT, sort, group and summaries; query blocks typed in the search syntax; results as a list, a table or a board. No Datalog, no custom transforms, no gallery, and a query reads one space |
| Tasks | File version: `TODO`/`DOING` or `LATER`/`NOW` markers and more, A/B/C priorities, scheduled and deadline dates, repeaters, time tracking. DB version: statuses you can add to, and a status history with time spent | Four fixed states, three priority levels, due and scheduled dates, repeat rules with an end date or count. No time tracking and no custom states |
| Seeing your tasks | Queries, and tables on tag pages in the DB version | An Agenda with filters, sort and grouping that also lists future occurrences of repeating tasks; Due and Done panels on each journal day; optional due-date notifications on desktop |
| Journal | A journal page per day. The DB version no longer reads the journal title format setting | Day, week, month, stream and agenda views; a journal template; a choice of display date formats |
| Search | Full-text search; the DB version's changelog adds local semantic search | Full-text search with typed filters (`tag:`, `state:`, `due:`, `prop:`), find and replace in a page, and replace across pages. No semantic search. A term under three characters is not searched |
| Contexts | Separate graphs | Spaces inside one database, each with its own journal, pages, tags, property definitions and tabs |
| Plain files | File version: the files are the notes. DB version: Markdown export, and an announced read-only Markdown projection with two-way sync in development | Export to Markdown; on desktop an opt-in mirror folder that is written and read back. The database stays the source of truth |
| Import and export | File version exports EDN, JSON, Markdown, OPML, Roam JSON and HTML. DB version imports file graphs, SQLite and EDN, and its EDN export captures the whole graph | Imports Markdown, Logseq graphs, Obsidian vaults, Org, Notion, Evernote, Joplin and bibliographies. Exports Markdown with attachments and property definitions, which a folder import restores without history. No structured dump |
| Backups | DB version: automatic backups on desktop and in the browser | A daily copy of the database beside it, which nothing in the app restores; the export ZIP is the restore path |
| PDF | PDF annotation, on desktop in the file version; the DB version keeps annotations as tagged nodes under the PDF's block | Highlights and pinned comments become blocks under the PDF's block on save |
| Flashcards | Yes; the DB version uses FSRS | None |
| Whiteboards | File version only; removed from the DB version | None |
| Zotero and Org-mode | File version only; both dropped from the DB version | BibTeX / CSL-JSON import; Org files import as an outline and are not an editing format |
| Publishing | File version: export public pages as a site. DB version: hosted Logseq Publish, paid | None |
| Agents and automation | An MCP server and HTTP API on a local port with a token, a `logseq` CLI, scripting | An MCP server on a local socket: an agent per client with its own token, read-only or read-write mode and spaces; edits attributed in History; `agaric-mcp call` for scripts |
| History | The DB version's docs describe a status history on tasks; no history of other edits was found in them | Every change is an operation: per-block and per-page history, restore to a point, undo across a page. Old operations are compacted after a retention period |
| Platforms | Desktop on Electron; mobile as above; a browser build | Desktop on Tauri (the system webview); Android. No browser build |

## Where Logseq is the better tool

- **You want your notes as files.** The file version is the only one of the three whose notes are plain files on every platform.
- **You model data.** Classes, inherited and multi-value properties, and table views on a tag are well ahead of Agaric's flat tags and single-value properties.
- **You write queries.** Datalog reaches joins and transforms that Agaric's builder cannot express.
- **You depend on plugins**, custom JS, flashcards, whiteboards (file version), publishing or time tracking.
- **Your devices are not on one network**, you need an iPhone, or you work with other people.
- **You want a team behind the tool.**

## Where Agaric is the better tool

- **Sync between your own devices with nothing in the middle.** No subscription, account or server, and concurrent edits merge through a CRDT with no conflict files, attachments included. The limit is the local network.
- **Tasks without writing queries.** The Agenda, the Due and Done panels, repeat rules with end conditions and projected occurrences are built in.
- **The journal** has week, month and stream views, and a template applied however a day is created.
- **Writing longer text.** Page mode and *Edit as Markdown* edit a page as a document.
- **Search and replace**, with typed filters and replace across pages.
- **Separate work and personal notes** in one app, with spaces.
- **Rename safety and history.** Links, tags and references hold ids, and every change can be inspected and reverted.
- **Scoped agent access.** Each MCP client is limited to a mode and a set of spaces, and its edits are named in History.

## Moving from Logseq

Pick a graph folder in Settings › Data. [docs/features/import-export.md](docs/features/import-export.md) has the full rules.

**Kept:** pages with their namespaces; journals as journal days, and links to them by Logseq's journal titles; page properties, aliases and tags; block properties; `id::` anchors, so `((uuid))` references and `{{embed ((uuid))}}` resolve across the graph's files; task keywords, `[#A]` priorities, `SCHEDULED` and `DEADLINE` with repeaters; admonition and quote blocks; `^^highlight^^`; image sizes; the files a page embeds or links.

**Changed or lost:**

- Custom task keywords fold into the four fixed states (`WAITING` becomes `TODO`, `NOW` becomes `DOING`); the set is fixed by decision (#1431).
- `:LOGBOOK:` clock entries are dropped, with a warning (#6745).
- `{{query}}` macros and advanced queries stay as text; they are not translated (#6754).
- Whiteboards and the `logseq/` config folder are not imported.
- A `((uuid))` to a block outside the import is stripped and counted in the warnings.
- Blocks nested past the import's depth cap (`MAX_IMPORT_DEPTH`) are flattened to it.
- `collapsed::` folds the block only on the device that imported it (#6756).
- Links become ids. Every text surface (export, copy, *Edit as Markdown*, the mirror) writes them back as `[[Title]]`.

Import on one device and let sync carry the result; two devices that each import the same graph end up with doubled pages.

### What you will miss, or trip over, at first

- **Your notes stop being files.** No `git log`, no `grep`, no other editor, no Syncthing over the graph folder. The desktop mirror gives files back as a copy Agaric keeps current; it is off by default and starts from an empty folder (#6540).
- **A block reference is a chip, not the block.** `((ref))` shows one line and a hover peek. To see the content in place you embed the block, and an embedded task shows its text without a checkbox (#6746, #6747).
- **A tag is not a page.** `#project` and `[[project]]` are two things: a tag has a listing page you cannot write on, and no properties that its blocks inherit (#6755). If your graph leans on tags-as-pages, decide per tag which one it becomes.
- **Your queries need rebuilding.** `{{query}}` macros and Datalog arrive as text (#6754). The builder, or `{{query tag:#work state:TODO}}`, covers filters (#6742); nothing covers custom views or result transforms (#6757).
- **Task habits change.** `LATER`, `NOW` and `WAITING` become `TODO` and `DOING`, there are no keywords of your own (#1431), and clock entries are dropped (#6745).
- **Links and tags are picked, not typed as text you can edit later.** In a block they are chips; *Edit as Markdown* is where a page reads as `[[Title]]` again.
- **Folding is per device** (#6756), and there is no pane to keep a second page open beside the first (#6550).
- **No plugins, themes from a marketplace, flashcards or whiteboards.** A stylesheet of your own is the one styling hook.
- **Sync means the same Wi-Fi, with the phone's app open** (#6519, #6740). There is no iPhone app (#6739).

## Sources

Logseq, read in November 2026:

- The DB version's repository and README: <https://github.com/logseq/logseq>
- The file version's repository: <https://github.com/logseq/og>
- The documentation repository, <https://github.com/logseq/docs>: `db-version.md`, `db-version-changes.md`, the CLI page, and the file version's pages on tasks, queries, plugins, export and sync
- "Logseq is splitting into two versions": <https://logseq.io/p/e3YDyX5AYr>
- Open Collective updates on sync access and the native mobile apps: <https://opencollective.com/logseq>
- The DB changelog on the forum, for the Markdown projection and semantic search: <https://discuss.logseq.com/t/logseq-db-changelog/30013>
- The App Store and F-Droid listings

Not confirmed from those sources, and so not claimed above: how the file version's search handles CJK text, which platforms semantic search runs on, whether a Google Play listing exists, and whether the Markdown projection is in a release.
