# Agaric vs Logseq: Feature Comparison

> **Revision 2026-11-11.** Agaric rows were re-checked against `origin/main` at `db1628007`
> (v0.23.0); Logseq rows against upstream repository pages, raw files in `logseq/docs` and
> `logseq/marketplace`, Open Collective and the App Store on the same day. This was one audit, not
> three, and it did not re-read every row. A row counts as re-verified where it cites a symbol or PR
> this revision checked; [Part 10](#part-10-corrections-log) lists what was carried forward from
> 2026-10-21 as it stood. Claims that could not be verified are labelled **unverified**.
>
> **Still deliberately less flattering, to both sides.** The 2026-08-30 revision corrected an
> overclaiming predecessor (Agaric 154, Logseq 127), and the 2026-10-21 revision corrected that one in
> both directions. This revision does the same to 2026-10-21. That revision said Agaric has no backup
> of any kind, when it keeps copies of the database before each migration. It left Logseq's local
> HTTP port unverified, when the docs state it. It also described an Agaric that has since shipped a
> Logseq graph importer, a Markdown mirror, an export that a folder import restores, and property
> definitions that sync. See [Part 10](#part-10-corrections-log).
>
> **Agaric rows describe `main`, which is 59 commits past the 0.23.0 release.** A second pass on the
> same day, with full history, found that the half of the mirror that reads files back, read aloud
> on Android, the pinned export restore and versioned derivations were all merged on 2026-11-11 and
> are in no release. Rows say so where it matters, and the scorecard counts 0.23.0 only, as it counts
> 2.0.2 and not Logseq's master.
>
> Goal: Agaric is meant to fully replace Logseq for the author's personal workflow. This document
> maps every Logseq capability to what Agaric has, what is missing, and what Agaric claims to have but
> does not. Its sibling [COMPARISON-OBSIDIAN.md](COMPARISON-OBSIDIAN.md) does the same against
> Obsidian.

**Status key:**

| Label | Meaning |
| ------- | --------- |
| **Done** | Fully implemented and shipped |
| **Partial** | Implemented but incomplete |
| **Gap** | Not implemented |
| **Dead** | Code exists but no user can reach it |
| **Design choice** | Intentionally different from Logseq |
| **Better** | Agaric implementation exceeds Logseq's, verified |

---

## Part 0: Read This First

### 1. There are two Logseqs

- **Logseq OG**, the file/Markdown version at `github.com/logseq/og`. Its only release is **1.0.0
  (2026-04-15)**, and its last commit was **2026-05-28** (an Electron 41.7.1 bump), about 24 weeks
  before this audit. It has 352 stars, 19 open issues and 13 open PRs. The team's statement that OG
  "will receive security and Electron … upgrades, but no new features" is in its own announcement of
  the split (logseq.io, 2026-04-24), not only in the forum post the last revision cited.
- **Logseq 2.0**, the DB version at `github.com/logseq/logseq`. **2.0.2 (2026-10-07) is still the
  latest release**, still titled "(Beta Testing)", five weeks on. The README still warns: *"The DB
  version is in beta status while the new mobile app and RTC is in alpha. This means that **data loss
  is possible**."* No GA date is published.

Every row below says *which* Logseq it compares against. OG is frozen. 2.0 is a beta that removed
whiteboards, slides, Excalidraw, built-in Zotero, org-mode, `{{query}}` macros and the journal-title
format. About 23% of marketplace packages declare DB support. Whether 2.0 also removed `((uuid))`
syntax is **unverified** (Part 6).

### 2. What changed since 2026-10-21, in both directions

**Agaric** merged **432 PRs** (391 non-bot, 41 Dependabot; GitHub search) and went from **0.20.0 to
0.23.0: three releases in 21 days**, against 14 in the 54 days before. It shipped:

- a **Markdown mirror** that writes every page as a file (#5363): desktop only, off by default. In
  0.23.0 it only writes. Reading outside edits, new files, renames and moves back was merged on
  2026-11-11 (#6474, #6483, #6504) and is on `main`, in no release;
- **one text format** (#6277): import, paste, Edit as Markdown, copy, export, the mirror and MCP now
  share one reader and one writer, and a folder import of an export restores it;
- importers for a **Logseq graph folder** (journals, namespaces, block refs across files), Notion
  exports and Org files, and a re-import that updates a page in place (#6033);
- page mode's toolbar, touch support and the journal's Daily view (#5691);
- property definitions per space that sync, with rename, merge and retype (#5841);
- link navigation into tabs, a page preview on `Ctrl` + hover, footnotes, meetings with recordings
  and transcripts, read aloud;
- a settlement for names two devices created while apart (#6278);
- a release APK that is launched on an emulator before it publishes (#6050).

Also on `main` and in no release: read aloud on Android (#6484), an export restore that keeps
templates and done dates and is pinned by a test (#6496, #6502), and versioned derivations (#6497).

The costs are quieter than last time. The sync engine's format went to 6, and devices on different
formats do not sync until both update. Page mode and the mirror are both off by default. `loro` is
held at 1.13.6 for a quadratic merge path (#3161).

**Logseq** made no release. It merged 81 PRs since 2026-10-21 (83 by the evening), some into a
`refactor/lui` branch and not master; one is a `feat` (CLI page rename, #13931). Beyond that:

- master gained a dry-run preview for file-graph import and import of plain Markdown folders
  (2026-10-29), unreleased;
- a native Android app (Jetpack Compose) opened to backer sign-ups on 2026-11-04, with testing
  announced for the week of 2026-11-09 (whether it began is **unverified**);
- the native iOS app stays invite-only, and the App Store still serves 0.10.9;
- sync pricing is unchanged: $5/month Backers and $15/month Sponsors.

`logseq/db-test` rose from 274 to 288 open issues. **OG had no commits.**

### 3. This revision corrects the last one, in both directions

The 2026-10-21 revision got these wrong:

- It said Agaric has **no backup**. It keeps a copy of the database before each migration, newest
  three retained (`MAX_KEPT_BACKUPS` in `src-tauri/src/db/pool.rs`). There is still no scheduled
  backup and no one-step restore.
- It said Logseq import drops blocks past depth 19. They are flattened to that depth.
- It left Logseq's local HTTP server port unverified. The docs give `127.0.0.1:12315`.
- It attributed OG's maintenance statement to a forum post only. The team's own announcement says it.
- It counted marketplace packages by hand (~625). A script over `plugins.json` gives 642 today.
- It called the Agaric repository private. It is public on 2026-11-11, with 20 stars; whether that was
  already so on 2026-10-21 is not known.

[Part 10](#part-10-corrections-log) lists every correction.

---

## Part 1: Context — Three Animals

**Logseq OG 1.0.0** (frozen, 2026-04-15) is ClojureScript on Electron, with plain `.md`/`.org` files
on disk. It gets security and dependency patches only, and none since 2026-05-28. Its chronic weakness,
performance at scale, will not be fixed, because the fix *was* the DB rewrite. Binaries (2026-08-30
figures): Linux AppImage 187 MB, macOS arm64 dmg 190 MB, Windows exe 221 MB, Android APK 32.9 MB.

**Logseq 2.0.2** (beta, 2026-10-07) is SQLite + DataScript, with typed properties, tags-as-classes
with multiple inheritance, and a real views system. It is more capable than OG in data modelling, and
riskier:

- 288 open issues in `logseq/db-test`, with 2.0.2 regressions on large graphs filed on 2026-11-10;
- RTC sync in alpha per the README;
- iOS in invite-only testing;
- Android as a GitHub-release APK, plus a native app taking backer sign-ups;
- an official data-loss warning.

Binaries (2026-10-21 reading; the asset list did not load on 2026-11-11): Linux AppImage 168 MB,
macOS arm64 dmg 169 MB (x64 163 MB), Windows NSIS 146 MB, Android APK 42.1 MB.

**Agaric 0.23.0** is Rust + React on Tauri 2, SQLite from the start, and the Loro CRDT engine, with
peer-to-peer sync on one network (plus an opt-in relay). It has a single maintainer, is pre-1.0 and
has a public repository with 20 stars. Its engineering discipline is heavy for a personal project:

- 6,284 Rust test functions, 903 frontend and e2e test files and 8 fuzz targets (2026-08-30 counts,
  not recounted; today there are 311 Playwright specs and 127 real-backend specs);
- a 100K-block benchmark SLO gate;
- SLSA provenance;
- a required real-backend e2e lane (#5996) that a release must pass before it publishes.

Its product surface is narrower than 2.0's on data modelling and ecosystem. Its riskiest areas are
sync beyond one network and long-horizon durability, since nothing backs it up on a schedule.

**Project health, for calibration (2026-11-11):**

| | Logseq OG | Logseq 2.0 | Agaric |
| --- | --- | --- | --- |
| Stars | 352, 69 forks | 45.6k, 2.9k forks | 20, 1 fork |
| Activity since 2026-10-21 | 0 commits | 81 merged PRs, some into `refactor/lui` | 432 merged PRs (391 non-bot) |
| Releases since 2026-10-21 | 0 | 0 | 3 (0.21.0 → 0.23.0) |
| Distinct authors | — | not recounted | one maintainer (authorship of the 391 not recounted) |
| Open issues | 19 + 13 PRs | 801 + 224 PRs; 288 in `db-test` | 13 |
| Funding | $4.1M seed (2022) + Open Collective: est. annual budget $232,161, balance $33,975 | same | none |
| Bus factor | — | ~4 (2026-08-30 estimate) | **1** |

---

## Part 2: Feature-by-Feature

Where OG and 2.0 differ materially, the Logseq column says so. Agaric evidence is a PR number, a
commit hash, or a repo-rooted `path:symbol`.

### 1. Block Model

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Everything is a block | Yes. 2.0 unifies blocks and pages as "nodes" | Yes. `blocks` table, tree via `parent_id` + `position`. `block_type` is a closed enum: `content \| tag \| page` | Done |
| Block nesting depth | Unlimited in practice | **Capped at 20** (`MAX_BLOCK_DEPTH` in `src-tauri/agaric-store/src/block_descendants.rs`), enforced backend-side; import caps at 19 | Partial |
| Block IDs | UUID v4 (random, unsortable) | ULID (Crockford base32, sortable, time-encoded) | Better |
| Block references | `((uuid))` renders the source block's **content** inline, live; hover shows breadcrumb + children; **reference-count badge** on the source block. 2.0.2: refs to deleted nodes show as broken (#13551) | `((ULID))` renders a chip with the target's **first line, 60 chars**. A **peek** (350 ms dwell or `Alt+↓`) shows full content, a space › page breadcrumb, the ref count, Open and Copy reference (`src/components/BlockRefPeek.tsx`, #4947); unresolved refs are labelled (e385ff0f0). No inline content, no children, no badge on the source, no peek on touch | Partial |
| Block embeds | `{{embed ((uuid))}}`: full subtree, **editable in place**. 2.0: unified `/Node embed`; 2.0.2 applies embed actions to the embed (#13099) | `{{embed ((ULID))}}` via `/embed` or the picker, the block and its subtree rendered live (#4572), editable in place behind a per-embed unlock (#4809). Rows show **content only**: no checkbox, priority, date chips, properties or attachments. Depth ≤ 3, 32 rows (`MAX_EMBED_DEPTH`, `EMBED_MOUNT_LIMIT` in `src/lib/embed-token.ts`); arrows do not descend; no structural edits; not unlockable in page mode | Partial |
| Block properties | `key:: value` parsed from content; 2.0: typed property rows | `block_properties` with **7** typed values; `::` name autocomplete; inline chips incl. ref and boolean (#5862); BlockPropertyDrawer | Done |
| Collapse/expand | State persisted **in the block** (`collapsed::`), so it travels between devices | Chevron + `Ctrl+.`, persisted in `localStorage` per page, shared by page mode: **device-local, not synced**. Imported `collapsed::` applies on the importing device only (#5214) | Partial |
| Zoom into block | `Alt+Right`, a real route with a URL | Zoom with breadcrumb, but ephemeral `useState`: **not deep-linkable, not in the back-stack**; page mode has no zoom | Partial |
| Move block up/down | `Alt+Shift+Up/Down` | DnD (depth-projecting, cap-aware, subtree-safe) + `Ctrl+Shift+Up/Down`; gutter drag in page mode (#6015) | Done |
| Block-level multi-select | `Esc` + arrows; 2.0 adds bulk set-property / bulk tag | Ctrl+Click, Shift+Click, Ctrl+A, and a keyboard selection cursor (`Ctrl+Space`, `Ctrl+Arrow`; 44215a97a). Batch actions: **three**: set todo state, cycle priority, delete. No batch indent, move or tag; `CANCELLED` missing from the batch menu | Partial |
| Subtree copy/paste | Yes; 2.0.2 keeps the subtree when copying or moving an ancestor | Indented-Markdown outline grammar; refs preserved; `[[Name]]`/`#tag` internalized on paste (#5153, #5154, #5166); cut/paste in page mode keeps ids and refs (#6019) | Done |
| Cross-block undo | Session-level `Ctrl+Z`, no history UI | Op-level undo/redo, per-page depth + redo stack, HistoryView with batch revert and word-level diff. Caveat: page mode's `Ctrl+Z` does not revert task state, dates, properties or attachments (`docs/features/editor.md`; runtime unverified) | Better |
| Turn into | Slash commands per block type; 2.0.2 adds "Clear heading" | Toolbar menu, block menu, `/turn`, `Ctrl+Shift+L` (#5760; key moved by #6022), page mode (#6027): H1–H3, quote, code, lists, callout | Done |

### 2. Page Model

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Pages as containers | One file per page (OG); node entity (2.0) | `blocks` with `block_type = 'page'`, content = title | Done |
| Page properties | First block holds `key:: value` | `block_properties` on page blocks; PagePropertyTable; front matter in Edit as Markdown (#5220) | Done |
| Page aliases | `alias:: JS, ECMAScript` | `page_aliases` + header badges; alias edits are ops, so undoable and synced (#5563); MCP `set_page_aliases` (#5570) | Done |
| Namespaced pages | `Project/Backend/API`; 2.0 replaces namespaces with tag hierarchy | Tree view in PageBrowser, breadcrumbs, create-under flow (#4734, #4874) | Done |
| Page tags via property | `tags:: book, fiction` → page refs. 2.0: tags are classes | `block_tags` + picker; `tags::` read on import (#5214) and `tags:` in Edit as Markdown front matter (#5220). No in-page `tags::` syntax | Partial |
| Unique names per context | 2.0: page names unique **per tag** (`Apple #Company` vs `Apple #Fruit`); 2.0.2 rejects creating a page tagged `#Tag` (#13221) | Titles and aliases unique **per space** under one folded name key (`reject_duplicate_page_title` in `src-tauri/src/commands/blocks/crud.rs`, #4782, #6278); tags too (#5281). Names two devices created while apart are settled after a sync: the newer page is renamed `Name (2)` with a toast, two same-named tags merge into the older, two pages for one journal day merge (#6278, `e2e-tauri/page-name-tie-sync.e2e.ts`). Command-level only, no DB constraint; pages without a space exempt | Done |
| Auto-created pages from links | Clicking `[[New Page]]` creates it | `[[` picker "Create", typed `[[text]]`; the New page dialog lists similar names (#5645); a broken-link chip is removed on click, `Ctrl+Z` restores (#5863) | Done |
| Move page between contexts | Multi-graph = separate folders | **Move to space** from the kebab and batch-move from the Pages view; closes the page in every tab (#5753). It lists the property values the destination defines differently and drops them only once confirmed, and one undo restores them (#5841) | Better |
| **Edit as Markdown** | OG: the page *is* a Markdown file. 2.0: no editable source | Page kebab or page mode's footer → a full-page Markdown buffer in the one text format (#6277): front matter, a paragraph per plain block, `-` / `1.` / `- [ ]` only on list and task blocks, `key::` lines, block ids carried out of sight. The block toolbar, the pickers and the block keys work in it; Edit / Preview / Changes; merge on a stale save (#5159); save report with Undo; draft recovery | Done |
| **Plain Markdown files on disk** | OG: the files are the store, on every platform. 2.0: Markdown Mirror writes files **one-way**. The team's 2026-04-24 post lists it under current work and says of supporting Markdown files in the DB version that it is "the plan, but we are still researching the best way to do this"; master fixed its incremental render on 2026-11-09 (#13943) | **Markdown mirror** (#5363; Settings → Data; `src-tauri/src/mirror/mod.rs`): every page of every space as a `.md` file, kept current. **That is all 0.23.0 does: it writes, one way, and lists a file changed outside as diverged.** On `main` since 2026-11-11, in no release: a file edited outside Agaric is read back once it settles, as are a new file, a rename and a move between space folders (`src-tauri/src/mirror/ingest.rs`; #6474, #6483, #6504). Each ingest is one undo, and a block both sides changed is kept twice with a warning. **Fenced:** off by default, desktop only, one device per folder; text only (no attachment handling found in the module); a file deleted outside is written again, so deleting a file does not delete its page; an empty page saved with a final newline or BOM stops mirroring (#6506, open) | Tie vs 2.0 in 0.23.0 (one-way). Two-way on `main`, unreleased. Short of OG |

### 3. Editor & Formatting

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Markdown support | Full Markdown (OG) | **Subset**, one grammar shared by import, paste, Edit as Markdown, copy, export, the mirror and MCP (#6277). Ships bold, italic, code, strike, highlight, underline, headings, backtick and tilde fences, math, tables with column alignment, quotes/callouts, ordered/bullet/task lists, images, rules, autolinks and, since 2026-10-21, **footnotes** (#6033). **Missing:** setext headings, which read as text (`docs/architecture/editor-and-content.md`). Indented code, reference links, definition lists, inline/block HTML (only `<u>`) and sub/superscript were listed missing on 2026-10-21 and not re-read | Partial |
| Markdown round-trip | Files are the source of truth | **Normalizing in the database, form-keeping in the mirror.** Stored text is the editor's form (#5148, #5161, #5164, #6277): CRLF → LF, underline as `<u>`, another tool's highlight and math rewritten to Agaric's. On `main`, in no release, a mirrored file keeps its own bullets, numbering and indents, and only the lines of changed blocks are rewritten; property tests read every mirrored file back with no change and converge edits from both sides (#6505, #6507). Unknown editor nodes are dropped **with a once-per-session toast** (`src/editor/markdown-serialize-toast.ts`) | Partial |
| Org-mode | Full `.org` (OG only; 2.0 dropped it) | Not an editing format. `.org` files import as an outline (#6033): headlines, TODO keywords including `#+TODO` sets, `[#A]`, SCHEDULED/DEADLINE, drawers, tags and links. Org emphasis stays text, and there is no `.org` export | Design choice |
| Bold / italic / strike / highlight / code | `**` `*` `~~` `^^text^^` `` ` `` | `**` `*` `~~` `==` `` ` ``, each with a shortcut; CommonMark flanking rules (#5208, #5210); inline code `Ctrl+Shift+K` (#6022) | Done |
| Underline | No dedicated mark | Underline mark, `Ctrl+U` | Better |
| Headings | `# H1`–`###### H6`; 2.0.2 "Clear heading" slash | `/h1`–`/h6`, `Ctrl+Alt+1..6`; Turn into offers H1–H3 only | Done |
| Code blocks | Fenced, syntax-highlighted | Fenced with lowlight; the language is picked in the block toolbar or page mode's code bubble (`docs/features/editor.md`) | Done |
| Math / LaTeX | `$$…$$` native; 2.0.2 math-block save fix (#13672); a forum report of LaTeX breaking in 2.0.2 is unverified | `$…$` inline + `$$…$$` block, KaTeX lazy-loaded, raw-source node view (#5642, #5704) | Done |
| **Mermaid diagrams** | **Plugin only** | ```` ```mermaid ```` fences render inline in editor and renderer, raw-source toggle, lazy-loaded (#5642, #5690) | **Better** |
| Tables | Markdown tables | Pipe tables that keep their column alignment (#6277); `/table` opens a size grid (#5774); row/column ops in the block toolbar and in page mode's table bubble | Better |
| Callouts | Plugin/CSS convention | 5 built-in styles, `> [!TYPE]` shape, type chosen from the block menu (#5694). Obsidian's, GitHub's and GitLab's types show in the nearest style and keep their name; `-` / `+` fold a callout to its title, not saved (#6033, #6277) | Better |
| Lists | Outline bullets are the list | Real ordered/bullet/task list nodes, plus `listStyle` bullet and numbered *blocks* with Enter/Backspace continuation (#4552, #4807) in both modes (#5825) | Done |
| Slash commands | ~20+; 2.0.2: `/code`, `/calc`, `/quote` on a non-empty block insert a new block (#13736) | Base commands plus sub-options surfaced as you type, recents band; includes `/embed`, `/voice`, `/turn` and `/meeting` (#5364). Page mode runs the same handlers (#5866) except `/duplicate`, `/template` and `/meeting` | Better |
| Inline pickers | `[[`, `((`, `/`, `#` | **Eight**: `[[`, `@`, `#` (#5205), `((`, `/`, `::`, `:` (emoji), `{{` (query) | Better |
| Formatting toolbar | None (keyboard only) | Standing bar with Format and Turn-into popovers, link/ref/tag/query/emoji/table/priority/date/todo/property controls, undo/redo, width-aware overflow, plus a selection bubble. Since 2026-10-21 the same bar sits above page mode and the Edit as Markdown buffer, pinned above the keyboard on touch (#5691) | Better |
| Property value autocomplete | Suggests previously-used values | **Only in the search DSL's `prop:key=value`.** The `::` picker completes keys only | Partial |
| **Page mode** | Block-at-a-time editing in both versions (2.0.2 still a per-block textarea, #13211) | One WYSIWYG document per page, saved per block, ids kept (#5721, #5691). Since 2026-10-21: the block toolbar, a grip and chevron per block, bubble menus for links, tables and code, touch support, and the journal's Daily view. `Ctrl+E` or Settings › Editor. **Fenced:** off by default (`EDIT_MODE_PREFERENCE` in `src/lib/preferences.ts`); pages over 1000 blocks (`PAGE_MODE_BLOCK_CAP` in `src/editor/page-mode/page-mode-fit.ts`) and the journal's week and stream views stay in blocks (#6079, parked); every block is drawn, so a key costs more the longer the page (#6224, open); no zoom, `/template`, `/duplicate`, `/meeting` or embed unlock; markers commit when the caret leaves a block | Done (opt-in) |
| **Markdown reveal** | The block being edited *is* raw source (textarea) | WYSIWYG that shows the syntax around the caret: the markers of bold, italic, code, strike and highlight, a heading's `#`, an external link, chips and, to read only, a quote's `>`, a callout's first line, code fences, math `$` and footnote brackets. Not lists, tables or underline (`src/editor/extensions/markdown-reveal.ts`; #5699, #5750, #5988, #6020, #6024, #5691). On by default | Done |
| **Markdown paste** | Not re-verified this revision | Multi-line Markdown splices into blocks; HTML goes through the same reader; `Ctrl+Shift+V` pastes plain; a toast offers Undo and "Paste as text" (`src/components/block-tree/paste-into-block.ts`, `src/editor/html-to-blocks.ts`; #5154, #5166, #6019). A paste also reads Obsidian Tasks fields, `![[Note]]` embeds and Logseq's `^^highlight^^` (#6277, #6033) | Done |
| Typed tags and task markers | `#tag`, `TODO` typed in text are native | `#name` becomes a tag on a boundary or save (#5205, #5215, #5777); `[ ]`, `[/]`, `[x]`, `[-]` become task states (`src/editor/extensions/task-paragraph.ts`) | Done |
| **Obsidian-style chords** | Own keymap (`g n` / `g p`, `Alt+Right` zoom), configurable | `Ctrl+E` page mode, `Ctrl+1..9` tabs, `Ctrl+Shift+T` reopen tab, `Ctrl+O` quick switcher, `Ctrl+P` palette, `Ctrl+Alt+←/→` back/forward, `Alt+1..9` spaces (#6022, `src/lib/keyboard-config/catalog.ts`); all rebindable | Done |
| Images and media | Images; 2.0.2 resizable video embeds, JPEG XL | Resize handle (#5343), collapsible (#4859), voice notes (#5484, #5833). A recording block pairs its audio with a transcript whose timestamps seek the player (#5410); `/meeting` makes a dated meeting page from a template (#5364); the OS voice reads a block or page aloud on macOS and Windows, not Linux; Android is on `main`, in no release (#5745, #6484, `src-tauri/src/commands/speech.rs`) | Done |

### 4. Linking System

Still Agaric's weakest domain against Logseq. Since 2026-10-21 it gained link navigation into tabs, a
page preview and typed heading anchors. Block references are still chips.

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Page links | `[[page name]]`, human-readable in the raw file; 2.0.2 rename updates link mirrors | `[[ULID]]` chips, title resolved at render. Robust to renames, and opaque only inside the database: Edit as Markdown, copy, export, the mirror and MCP all write `[[Title]]` (#6277). A typed `[[Page#Heading]]` or `[[Page#^id]]` stores a reference to that block (#6033). `Ctrl+click`, a middle click and `Alt+Enter` follow a link, the first two into a background tab (#5691). Picker searches **pages only**. An unresolvable target reads `[[01HZAB12...]]` as a removable chip (#5863) | Partial |
| Block references | Live inline content + count badge + hover breadcrumb/children | Chip + peek (see §1). The peek shows full content, but nothing renders inline, and there are no children and no in-place editing | Partial |
| Hover preview | Breadcrumb + children on hover | The block-ref peek (`src/hooks/useBlockRefPeek.ts`), and a preview of a page's first blocks on `Ctrl`/`Cmd` + hover over a page link (#5691). Pointer only: on touch a chip opens its target | Done |
| Block embeds | `{{embed ((uuid))}}`, editable in place | Content-only rows, editable behind an unlock (see §1) | Partial |
| Page embeds | `{{embed [[page]]}}` | `{{embed [[ULID]]}}` renders the page's top-level blocks, with the block-embed limits (`src/lib/embed-token.ts`, #4572) | Partial |
| Custom link labels | `[label](((uuid)))` and `[text]([[page]])` | `[[Page\|label]]`, stored as `[[ULID\|label]]` (#5175); `[[Page#Heading]]` links the heading block (#5178). Logseq's `[label]([[Page]])` is read on import and paste and keeps its label (`docs/features/import-export.md`); its `[label](((uuid)))` form was not found in the reader | Partial |
| Reference counter | Per-block count badge on the source block | Page totals in the Linked References header, per-day badges in journal views, and a count in the peek. **No badge on a referenced block** | Partial |
| Linked references | Grouped by page, filter bar; 2.0.2 shows them on tag pages (#13440) | Grouped by source page, paginated, server-side filters, with an All / Page links / Block refs toggle (#4943). On a **block** only while it is zoomed (`src/components/backlinks/LinkedReferences.tsx`, #4945) | Partial |
| Unlinked references | Plain-text mentions; 2.0.2 matches aliases (#13706) | "Link it" conversion, grouped, paginated. Pages only (`src/components/pages/PageEditor.tsx`); absent from journal days | Partial |
| Link kinds distinguishable | Refs and links are distinct entities | `block_links` carries a kind (`src-tauri/migrations/0119_block_links_kind.sql`, #4943); a block embed counts as a block ref, a page embed as a page link | Done |
| Backlink filtering | Simple filter bar | Server-side `FilterExpr` tree with And/Or/Not and keyset pagination; Created date and source-page include (#5595), sort picker (#5702) | Better |
| Graph view | Local + global; 2.0 ships Graph View V2 | Global force-directed graph plus local graph (#5459), select-and-walk (#5537), labels (#5540), restored layout (#5514). The edge set is capped (`PAGE_LINKS_EDGE_CAP`) | Done |
| Link fidelity on export | Files already contain the names; 2.0.2 exports a ref to a missing block as `((uuid))` (#13717) | Export, copy and the mirror write `[[Title]]`, `#name`, a label as `[[Title\|label]]`, a block ref as `[[Page#Heading]]` or `[[Page#^id]]`, an embed as `![[…]]` and a ref-typed value as a link (#6277, #6457). A folder import of an export restores block refs and embeds, pinned by a test (#6502) | Better |

### 5. Properties

Logseq 2.0 turned this into its strongest domain. Agaric is behind, not ahead.

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Typed values | OG: untyped text. **2.0: typed** Text, Number, Date, DateTime, Checkbox, Url, Node, and the `:schema :type` registry lists more (e.g. `:page`), with correct numeric sort; 2.0.2 adds Number defaults (#13724) | **7 types**: text, number, date, select, ref, boolean, **url** (`src-tauri/migrations/0120_property_definitions_allow_url.sql`, #5142) | Done |
| Schema registry | 2.0: properties are pages with their own config | `property_definitions` **per space** (`src-tauri/migrations/0129_property_definitions_per_space.sql`), synced as ops with the later change to a key winning (#5841). Settings › Properties shows how many live blocks use each key, renames a key, merges it into another, changes its type with a preview, renames a select option, and lists, converts or moves the values that do not fit (#5841, #6206). The built-ins are code constants (`BUILTIN_PROPERTY_DEFS` in `src-tauri/agaric-store/src/op.rs`) and locked (`BuiltinPropertyLocked`, #6017) | Done |
| Multi-value | OG: opt-in comma splitting. **2.0: first-class multi-value on most types** | **Absent.** `PRIMARY KEY (block_id, key)` makes it structurally impossible | Gap |
| Default values / choices | 2.0: default value, enum choices with icons + ordering, per-tag scoping, checkbox-state mapping | `select` options only; `todo_state` and `priority` options now frozen (#6017) | Partial |
| Property display control | 2.0: UI position, hide-by-default, hide-empty | Fixed layout: inline chips (ref and boolean chips, #5862) + drawer | Gap |
| Constrained references | 2.0: a Node property can be constrained to nodes carrying a given tag | `ref` type accepts any page | Partial |
| Bidirectional properties | 2.0: reverse lists surface on the target automatically | **Absent** | Gap |
| Built-in properties | ~15 editable + ~8 hidden | **15 code-defined built-ins**: `todo_state`, `priority`, `due_date`, `scheduled_date`, `created_at`, `completed_at`, five `repeat*` keys, `space`, `is_space`, `listStyle` and, since #5364, `meeting_date`. `status`, `url`, `effort`, `assignee`, `location` are the editable definitions a new space starts with | Done |
| Property-based queries | Simple `(property k v)` + full Datalog | 10 operators across number, date, text and ref values in the query builder (#4569, `src/components/PageBrowser/add-filter/vocab.ts`); the Pages browser filter still offers 4; boolean is existence-only | Done |

### 6. Tags

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Inline tag syntax | `#tag` / `#[[multi word]]`: tags are pages | `#[ULID]` chip with resolved name; typed `#name` becomes a tag on blur or save (#5777), by Obsidian's rule that a tag starts the text or follows whitespace. A new tag name holds no whitespace, so `#[[multi word]]` becomes `multi-word` (`docs/features/tags-and-links.md`) | Done |
| Tags as pages | Yes. **2.0: tags are classes/supertags**: properties on a tag are inherited by tagged nodes; 2.0.2: tags extending Card are flashcards (#13540) | Tags and pages are separate `block_type`s. The read-only tag page lists tagged pages and blocks (#5695); tag colours sync as the tag's `color` property (#6544) | Design choice |
| Tag hierarchy | OG: `/` naming. **2.0: `Extends`, with multiple inheritance and a tag tree** | Prefix convention (`work/meeting`) matched with `LIKE` | Partial |
| Boolean tag queries | Via query DSL | `TagExpr` with Tag/Prefix/And/Or/Not, depth-gated, compiled to one pushed-down id-set subquery | Better |
| Tag inheritance in queries | 2.0: inherited class properties are queryable | Reachable from the Tags view's "include inherited" toggle (off by default; `src/components/filters/TagFilterPanel.tsx`, #4925), the `under:#tag` search token behind the tag page's "Search everything under #tag" (#5797), and MCP `search`. **Not** in `FilterPrimitive`, inline `{{query}}`, agenda filters or Advanced Query. Cache vs SQL agreement audited (#5671) | Partial |
| Tag usage counts | Shown in UIs | `tags_cache.usage_count` | Done |

### 7. Query System

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Simple queries | OG: `{{query (and [[page]] (task TODO))}}`, filters `and/or/not`, page ref, free text, `between`, `property`, `task`, `priority`, `page`, `namespace`, `page-property`, `page-tags`, `all-page-tags`, `sample`, `sort-by`. **2.0 replaces `{{query}}` with `/Query` nodes** and drops `all-page-tags` and `sort-by`; 2.0.2 isolates query errors (#13767) | `{{query …}}` blocks plus a **structured `v2:<base64url(JSON)>` payload** carrying an arbitrary `FilterExpr`; legacy text queries reroute onto the rich engine when translatable; the `backlinks` query type lists results again (#5815) | Done |
| Filter vocabulary | See above | **23 primitives** (`FilterPrimitive` in `src-tauri/agaric-store/src/filters/primitive.rs`): Tag, TagOrRef, ChildOf, PathGlob, HasProperty, LastEdited, Space, Priority, State, BlockType, DueDate, Scheduled, Created, **LinksTo, LinkedFrom, HasParentMatching**, Orphan, Stub, HasNoInboundLinks, Regex, CaseSensitive, WholeWord, Snippet | Better |
| Graph traversal | Full Datalog: arbitrary joins, variable-length paths, rules | **One hop plus ancestors.** `LinksTo`/`LinkedFrom` take a concrete id; `HasParentMatching` recurses (depth ≤ 50). No transitive closure, joins or rules | Partial |
| Result transforms | `:result-transform` and `:view` evaluated by SCI (sandboxed Clojure) | **Absent.** Five fixed folds (count/sum/avg/min/max) | Gap |
| Grouping | 2.0: group-by in the Views system | All 7 group keys reachable in the builder (#4804, `src/components/AdvancedQuery/QueryControlsBar.tsx`); groups show a bounded preview with no expand | Done |
| Aggregation | `{{function (sum :qty)}}` + arbitrary SCI functions | count/sum/avg/min/max, global + per-group; the target can be a property (#4804) | Partial |
| Sorting | `sort-by`, table-header sort; 2.0.2 sorts missing values last (#13485) | Multi-key over a closed column set + bm25 relevance | Done |
| Query result table | `query-table:: true` + column picker; 2.0: Table/List/Gallery views with pinned, resizable columns and inline editing | Columns derived from the loaded rows' properties until picked; a column picker chooses and orders them, kept in the block; no widths or inline editing | Partial |
| Live-updating results | Yes (DataScript reactivity) | Inline queries refetch on property and graph-structure events, including ones arriving by sync (`src/hooks/useQueryExecution.ts`, #5316) | Done |
| Saved queries | Query nodes live in the graph | Saved views were invisible after a space migration until #5828; they are now per-space `localStorage`, **not synced**, and old views stay invisible | Partial |
| User-facing query language | Text you can read, diff, paste, version | **Partial.** A query block takes the search box's filter syntax as typed text (`{{query tag:#work state:TODO}}`, `src/lib/query-text.ts`), its tokens joined by AND, with no OR, groups, relative dates or free text yet; the builder still writes `v2:<base64url(JSON)>` (#6628) | Partial |
| Cross-space queries | Multi-graph search is manual | **Impossible.** `space_id` is mandatory, including MCP `query` | Gap |

### 8. Task Management

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Task markers | OG: `LATER/NOW/DONE` or `TODO/DOING/DONE` + `CANCELED`, `WAIT/WAITING`, configurable. **2.0: one customizable, user-extensible set** | `none → TODO → DOING → DONE → CANCELLED → none`, locked in `src/lib/task-states.ts`, and since #6017 `todo_state` is a locked built-in. No WAITING | Partial |
| Priority levels | `[#A] [#B] [#C]`, fixed | **Fixed 1/2/3** (`PRIORITY_LEVELS` in `src/lib/priority-levels.ts`). #6017 removed the configurable levels; out-of-range legacy values get a neutral badge. Click-to-cycle, slash, `Ctrl+Shift+1/2/3`. On par with Logseq, **a regression from Better** | Done |
| Due / scheduled dates | Org-style `DEADLINE:` / `SCHEDULED:` lines | `due_date` / `scheduled_date` columns, slash commands, date pickers | Done |
| Recurrence | Repeaters `+` / `.+` / `++`, `Nd/Nw/Nm`. OG's `.+` advances from the *original* timestamp, contradicting its docs. 2.0.2: repeats advance in the local calendar, monthly without drift (#13615) | Modes `+` / `.+` / `++`; daily/weekly/monthly/**yearly**, `+Nd/+Nw/+Nm/+Ny`; end conditions; write-time validation; MCP `set_property` on `todo_state` recurs like the app (#5919, #5957). Completing creates a **new sibling**, so a daily habit accumulates one block per occurrence | Better |
| Recurrence projection | None | Projected occurrences in the Due Panel **and** the Agenda's Projected list (b5ac3a590) | Better |
| Task dashboard | OG: a "Scheduled tasks and deadlines" section + two default queries; no real agenda. 2.0: tag pages carry a Table view | Agenda with 8 filter dimensions, sort, group, cursor pagination; DonePanel; DuePanel; `UnfinishedTasks` rollover | Better |
| Time tracking | **OG: built-in, on by default** (`:LOGBOOK:` clocks). **2.0: status-change history with time spent** (display fix #13695) | **Absent** | Gap |
| Effort tracking | Arbitrary custom properties | `/effort`, a fixed 6-option select; `effort` is now a removable, non-built-in definition | Done |
| Overdue accumulation | Via embedded queries | DuePanel overdue section + the `UnfinishedTasks` rollover | Better |
| Deadline warning period | `:scheduled/future-days` | Configurable 0–90 days in **Settings → Tasks & reminders** (#5635) | Done |
| Task / deadline notifications | Plugins only | **Desktop, while running, off by default** (#4806, `ReminderSettings` in `src-tauri/src/reminders.rs`): one notification per open task on its `due_date`. Nothing with the app closed, on Android, for `scheduled_date`, ahead of time or as catch-up; #5839 fixed the job running every other tick | Partial |
| Calendar integration | Plugins only | **Absent, deliberately reverted** (migration 0091). No CalDAV, no ICS | Gap |

### 9. Daily Journal

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Auto-created daily page | On launch; 2.0.2 keeps date-only `createJournalPage` on that day (#13597) | On launch with template applied; pages created in Stream or by the date picker reach Day mode (db7452269) | Done |
| View modes | One scrollable view; 3 journals, +7 per scroll, not configurable | **5 modes**: Daily, Weekly, Monthly, Agenda, Stream; the week view copies, cuts and pastes a selection across days (2a6d1adbc) | Better |
| Date navigation | `g n` / `g p`, date picker | Prev/next per mode, `Alt+Left/Right`, `Alt+T`, calendar with 4 content-dot types, a global date-jump header | Better |
| Drag-to-reschedule | No | Drop zones on weekly day sections, with a keyboard equivalent | Better |
| Configurable date format | **OG: `:journal/page-title-format`. 2.0 REMOVED the knob** | A 5-value allowlist in Settings → Appearance; display-only, stored identity stays ISO | Partial |
| Natural language dates | In date pickers | `today`, `tomorrow`, `next <weekday>`, `in N days`, `end of month`, `+Nd`, ISO and more (`src/lib/parse-date.ts`). Missing: `last <weekday>`, `this week`, `next month`, `+Ny` | Partial |
| Journal templates | `:default-templates {:journals …}`. 2.0: apply-template-to-tag | Template pages applied wherever a day is created (app, MCP, Quick Capture) in the caller's transaction, so one undo reverts both, with properties carried (#5373, #5395). The per-space override was retired (#5405) | Better |
| "On this day" | Possible via Datalog | **Absent** | Gap |

### 10. Search

Agaric's strongest domain. Its index advantage now holds against OG only.

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Full-text search | **OG**: FTS5 with the default `unicode61` tokenizer on desktop, `LIKE` fallback; browser uses Fuse.js. **2.0**: FTS5 with `tokenize="trigram"` in the DB worker since 2024-07-20, `LIKE` for ≤ 2-char queries; 2.0.2 reindex and Unicode fixes (#13475, #13761) | FTS5 trigram, bm25, keyset pagination, same engine on every platform | Better vs OG; tie vs 2.0 |
| CJK / substring search | **OG: broken**: `unicode61` cannot segment CJK. **2.0: same engine class as Agaric**; CJK behaviour not tested | Substring and CJK via trigram; 1–2 character queries show an advisory banner | Better vs OG; tie vs 2.0 (untested) |
| Semantic search | **2.0**: hybrid vector + keyword (#12710), opt-in, macOS ARM64 only, off by default | **Absent** | Gap |
| Search filter language | Combine `Ctrl+K` with filters informally | **Inline DSL**: 12 prefixes (`tag:`, `under:`, `path:`, `not-path:`, `state:`, `not-state:`, `priority:`, `not-priority:`, `due:`, `scheduled:`, `prop:`, `not-prop:`) plus bare `#tag` (`src/lib/search-query/register.ts`), with validation, chips, autocomplete, helper popover. Conjunction-only (unverified: `docs/features/views.md` lists AND/OR/NOT) | Better |
| Search scope | Pages + blocks, filterable | Space scope, page-name GLOB include/exclude, block-type filter, partitioned palette endpoint: **19** filter fields (`SearchFilter` in `src-tauri/agaric-store/src/search_types.rs`); result counts say what they count (#5810) | Better |
| **In-page find (`Ctrl+F`)** | **None** | Case, whole-word and **regex** toggles, live counter, cycling, Unicode-correct folding | **Better** |
| Long-block indexing | **OG**: blocks over `:block/content-max-length` (10000) become unsearchable. 2.0: unverified | Per-block FTS cap with explicit handling | Better vs OG |
| Recent pages | In search results | Per-space "Recent" list on an empty query | Done |

### 11. Spaces (Workspaces)

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Multiple contexts | One graph per instance; 2.0 adds tabs and windows | `space` blocks partition one DB; every command takes one space (#5538, #5546) | Better |
| Per-space journal / tabs / recents | N/A | Journal keyed `(date, space)`; `tabsBySpace` + `recentPagesBySpace` | Better |
| Per-space identity | N/A | Accent colour, top stripe, sidebar badge, window-title prefix | Better |
| Quick switching | Graph switcher | `Alt+1` … `Alt+9`, rebindable (#6022) | Better |
| Cross-space links | N/A | Enforced at write time; broken-link chip, click removes, `Ctrl+Z` restores | Better |
| Manage UI | N/A | Settings › Spaces: create, rename, accent, "Open on launch" (#5362), safety-checked delete | Better |
| **Per-space sync scope** | N/A | **Not a thing.** A session syncs every space; no selective sync | Gap |

### 12. AI / Agent Integration

Agaric's MCP is per-agent and has 39 tools. Logseq 2.0's MCP is reachable from the browser, and its
token-scoped REST API is still on master only, a month after it merged.

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| MCP server | **2.0** (desktop Settings → AI, or the CLI), served by the local HTTP server at `127.0.0.1:12315` with a bearer token (docs): `pretend` dry-run, undo/redo integration; 2.0.2: `/mcp` usable from browser MCP clients (#13312), CLI password login (#13270) | `agaric-mcp` sidecar over one Unix socket / named pipe, owner-only, never TCP, off by default. Each client is an **agent** with a name, mode (RO/RW), space allow-list and token (#5759, `src-tauri/migrations/0125_mcp_agents.sql`); Settings lists, creates and revokes agents (#5710). Tokens sit plaintext in a device-local table | Tie |
| Tool surface | Search, create and list pages, tags and properties, add blocks, edit block titles; 2.0.2 `upsert block --blocks` takes Markdown (#13377). The docs' TODO list still reads "Edit pages, tags and properties" and "Read and write block children" (docs master, 2026-11-11) | **19 read-only + 20 read-write** (`src-tauri/src/mcp/registry.rs`; RW serves the RO set): page/block history, journal, trash, `resolve`, `query` (#5542), `get_page_markdown`, `append_markdown` and `edit_page_markdown` in the one text format (#5462, #5554, #6277), `move_blocks`, `batch`, `undo`, `set_page_aliases` (#5570), `move_page_to_space`, `attach_file`, `list_attachments` and `add_meeting` (#5410, #5364); links by name (#5539) | Better |
| Auditability | Undo/redo integration | Every op stamped `agent:<name>`; a 100-entry **in-memory** activity log (`src-tauri/src/mcp/activity.rs`); **the History view does not distinguish agent ops** (`docs/features/views.md`) | Partial |
| Isolation | Graph-scoped; master-only PATs carry read/write scopes, expiry, revocation (#13019) | Per-agent token, mode and space allow-list, but **"not isolation"** per `docs/features/agent-access.md`: links, history and refusal messages cross spaces; no rate limiting | Partial |
| Programmable API | Plugin API (`@logseq/libs`) and a local HTTP server at `127.0.0.1:12315` with a token (docs; method count unverified); RTC semantic REST API with graph-scoped tokens merged 2026-10-10 (#13019), E2EE graphs 10-11 (#13671): **still in no release on 2026-11-11**. Master tightened the local API and plugin boundaries on 2026-11-09 | MCP. On `main`, in no release, the desktop Markdown mirror is a second seam, since any tool can edit the files (#5363); in 0.23.0 those files are write-only | Gap |
| In-app AI features | GPT plugins; 2.0 semantic search (§10) | **None**; voice notes record only (#5833) | Gap |

### 13. Sync & Storage

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Transport | OG: files + third-party sync. 2.0: RTC to a server | **iroh QUIC over UDP** (iroh 1.4.1, pinned `=1.4.1` in `src-tauri/agaric-sync/Cargo.toml`), TLS 1.3 in the handshake, ALPN `agaric/sync/0` (`SYNC_ALPN` in `src-tauri/agaric-sync/src/transport/service.rs`) | Done |
| Cost / account / server | **2.0**: open to all Open Collective Backers ($5/month) and Sponsors ($15/month); self-hostable only by running the sync server (docs master, 2026-11-11). OG: none built in | **Free, no account, no server.** Two devices pair and sync directly | Better |
| Peer identity | Account-based | ed25519 endpoint id, TOFU-bound into `peer_refs.endpoint_id`; key stored as raw bytes at `0600`, **not in an OS keychain** | Done |
| Discovery | Server | **mDNS only** (`_agaricv1._udp.local.`, plus an Android `MulticastLock`). Devices on different networks cannot find each other | Done (one network) |
| Pairing | Account login | 4-word passphrase or QR, proven inside the first `HeadExchange`; 5-minute window; fixes #5573, #5612, #5673, #5718; a peer that has not answered yet is redialled (#6451, #6458) | Done |
| Pairing fallback | N/A | The QR (v2, #4702) carries the responder's dial address and device id, so a first pair needs no multicast; passphrase-only pairing still does | Done |
| Remote / internet sync | 2.0 RTC syncs over the internet; the README still calls RTC **alpha** | LAN by default. An **opt-in relay** (#5135, `internet_relay_url` in `src-tauri/agaric-sync/src/transport/endpoint.rs`) carries traffic between peers that have **already discovered each other**; it does not discover | Design choice |
| Conflict resolution | OG: file-level (fragile). 2.0 RTC: alpha; 2.0.2 keeps property-value replacements together. The July 2026 iOS data-loss incident was not re-verified | **Loro CRDT** per space: `LoroTree`, `LoroText`, `LoroMap`; SQL tree columns are derived. Move/replay ordering fixed (#5711, #5720); purges wait until every space lands (#5712) | Better |
| **What does not converge** | — | Attachments converge (#5608, #5728) and, since #5841, so do property definitions. Still true: the **op log is audit-only across peers**, and collapse state, saved views and the mirror setting are per device. Two devices on different engine formats do not sync until both update (format 6 today, `ENGINE_FORMAT_VERSION` in `src-tauri/agaric-engine/src/loro/engine/mod.rs`). A quarantined delta is listed in Settings › Sync & devices and can be retried at the next start (#6057) | Partial |
| Sync direction | Bidirectional | **A session is a pull** (responder → initiator, `docs/architecture/sync-protocol-spec.md`); two-way needs two sessions, which the scheduler runs | Partial |
| **Multi-device, verified** | Widely used (and widely complained about) | **CI-verified two-way**: `e2e-tauri/sync-two-device.e2e.ts` against a headless peer (`e2e-tauri/sync-peer.ts`) pairs, edits each way, sets a property, moves, makes concurrent edits to one block, sends an image each way, cancels and unpairs; required on `main` via `e2e-tauri-gate` (#5996). Since 2026-10-21 the lane also syncs property definitions, a large vault, a contested page name and a mirrored file (`e2e-tauri/property-defs-sync.e2e.ts`, `e2e-tauri/sync-large-vault.e2e.ts`, `e2e-tauri/page-name-tie-sync.e2e.ts`, `e2e-tauri/mirror-sync.e2e.ts`). **In daily use between Android and Linux, both directions** (maintainer report, 2026-10-21). Unproven: devices on different networks, a restrictive network; there is no iOS | Done (one network) |
| Sync controls | — | **Cancel** at dial or mid-session (#6026); per-peer **progress** in messages, files and bytes (#5997); a named engine-version mismatch (#5728) | Done |
| Op log / history | Timestamps only | Append-only blake3 hash chain, SQL-trigger-enforced, per-device sequences, paginated history; the legacy CBOR path that wiped it is deleted (#4693) | Better |
| Snapshots / compaction | 2.0: **automated backups, last 12 retained**, on desktop and browser only; the docs say hourly for the browser and give no interval for desktop | The whole-vault zstd-CBOR blob is gone (#4693, #4727); catch-up is a per-space Loro merge with bounded payloads (#5838); compaction = purge + watermark. Residual: the disaster-path op-log replay buffers the whole log; peak RAM unmeasured | Done |
| **Backup / restore** | 2.0: automated on desktop and browser (hourly in the browser, last 12 kept); none on mobile | **No scheduled backup and no one-step restore.** What exists: a copy of the database before each migration, newest 3 kept (`MAX_KEPT_BACKUPS` in `src-tauri/src/db/pool.rs`); *Export all spaces*, whose ZIP, once unzipped, a folder import reads back one space at a time with typed properties, attachments, block refs and embeds (#6277), and on `main` with templates and done dates too, pinned by a test (#6496, #6502, in no release), but without history, trash or device state; and on desktop the Markdown mirror as a standing plain-file copy | Partial |
| Crash recovery | Filesystem journaling | Four-step boot recovery plus engine-first reprojection; an integrity check in Settings › App health (#5360, #5361); engine vs SQL audits (#5671). On `main`, in no release: derived tables carry a version, and the report says in plain words which tables are stale caches and which rows disagree with the engine (#6488, #6497) | Better |
| Encryption at rest | OG's Logseq Sync: age end-to-end. 2.0: encryption password (Settings › Encryption); E2EE key wrapping merged (#13671), deployment unconfirmed | **None.** Database, attachments and the ed25519 key sit behind filesystem permissions | Logseq |
| Supply-chain assurance | Standard CI | SLSA provenance, Scorecard, CodeQL, blocking `cargo-deny`/`cargo-audit`, threat model; a release publishes only after the real-backend lane passes (fda49ef52). **No desktop code signing** | Better |

### 14. Templates

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Template creation | Block/page with `template:: name` | `template=true` pages, "Save as template", a Templates view | Better |
| Template insertion | `/Template` picker | `/template` picker: one `createBlocksBatch` per depth level, so an error leaves earlier levels in place (`insertTemplateBlocks` in `src/lib/template-utils.ts`). **Not atomic.** Absent in page mode | Done |
| Dynamic variables | `<% today %>`, `<% time %>`, `<% current page %>` | Two grammars: legacy (`today`, `time`, `date±N`, `weekday`, … with `:FORMAT`) and `{{date}}`, `{{time}}`, `{{title}}`, `{{cursor}}`; journal weekday/month names English-only (`src-tauri/src/commands/journal.rs`) | Better |
| Default journal template | `:default-templates` | `journal-template=true` pages, applied in the caller's transaction (#5395) | Better |
| Template including parent | `template-including-parent:: true` | **Absent** | Gap |
| **Block properties in templates** | Carried through; 2.0.2 tag-template fixes | **Journal templates carry them** (`copy_page_blocks_in_tx` in `src-tauri/src/commands/pages/markdown_paste.rs`, #5395); **`/template` still drops them** (`properties: {}`) | Partial |

### 15. Import / Export

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Import formats | OG: Roam JSON, OPML, Markdown. 2.0: SQLite, File-to-DB, EDN; master adds a dry-run preview and plain Markdown folders (2026-10-29, unreleased) | Markdown, text and Org files, a folder, an Obsidian vault, a Logseq graph folder, a Notion export folder, `.enex`, `.jex`, BibTeX / CSL-JSON (`src/components/settings/ImportSection.tsx`, `docs/features/import-export.md`; #6033) | Better |
| Import from Logseq | N/A; 2.0.2 improves File-to-DB fidelity | A folder holding `logseq/config.edn`, or both `pages/` and `journals/`, is read as a graph (#6033): `___` and legacy `.` namespaces, `title::`, journals as journal days by the config's file-name format, links to them by Logseq's journal title, page properties, `id::` anchors that `((uuid))` and `{{embed ((uuid))}}` resolve to **across the folder's files**, task keywords, `[#A]`, SCHEDULED/DEADLINE with repeaters, admonitions, `^^highlight^^` and image sizes. Read from the docs and tests; no run against a real graph was made for this revision | Done |
| **What Logseq import drops** | — | Logseq `{{query}}` macros and whiteboards are not translated; `:LOGBOOK:` clocks are dropped with a warning; a `((uuid))` to a block outside the import is stripped and counted; custom task keywords fold into the four fixed states; blocks nested past 19 levels are flattened to that depth (`MAX_IMPORT_DEPTH` in `src-tauri/agaric-engine/src/import.rs`); `collapsed::` applies on the importing device only | Partial |
| Import merge | N/A | A single Markdown file, or an Evernote or Joplin note without attachments, whose title names a page with content **updates that page in place** after asking, as one undo (#6277). A folder's note, a note with attachments and a Logseq or Org file become `Title (2)` instead. Two synced devices that each import one corpus still end with doubled pages, the newer of each pair renamed `Name (2)` (#6278) | Partial |
| Import from Roam | Native JSON | **Absent** | Gap |
| Markdown export | Full graph | **"Export this space"** and **"Export all spaces"** ZIPs with `assets/`, `.agaric/space.json` (property definitions, and titles a file name cannot spell) and `.agaric/export-report.txt` (`src/lib/export-graph.ts`); a folder import of the unzipped space restores it (#6277). Per-page `Ctrl+Shift+E` still **copies to the clipboard** (`src/components/pages/PageHeader.tsx`) | Better |
| **What export drops** | Files are the format | History, trash, saved queries, the keyboard map, sync state and other device-local state; a tag is written only as its `#name` reference, so its own properties, its colour included, are dropped; built client-side with JSZip, so a large vault sits in memory | Partial |
| JSON / EDN / OPML export | OG: EDN, JSON, OPML, Roam JSON, HTML, Markdown. 2.0: SQLite, SQLite+assets zip, **Build EDN** (block, page or full schema) | **None.** `.agaric/space.json` carries property definitions and titles only | Gap |
| HTML publishing | OG: read-only SPA. **2.0: Logseq Publish** (paid, password-protectable, self-hostable); 2.0.2 excludes private pages (#13691) | **Absent** | Gap |

### 16. Mobile & Platforms

| Capability | Logseq | Agaric | Status |
| --- | --- | --- | --- |
| Desktop | Linux, Windows, macOS | Linux (deb/rpm/AppImage), Windows (MSI), macOS (x86_64 + aarch64 dmg) | Done |
| Android | F-Droid serves the **file version** 0.10.15 (2025-12-18, not re-fetched). The 2.0.2 release carries an APK (42.1 MB). **A native Jetpack Compose app opened to backer sign-ups on 2026-11-04, with testing from the week of 2026-11-09** and access by Google Play account (Open Collective update); no public store listing was found, and the docs still say it "has not been opened up for alpha testing yet" | Signed APK, **arm64-v8a, API 30+, sideload-only**. A release-profile APK is now installed and launched on an emulator before a release publishes, and nightly (`.github/workflows/android-launch-smoke.yml`, #6050): the check 0.15.0 lacked. The same emulator then checks the system-bar insets and that a typed block survives a force-stop (#6553); the real-phone checks are an open list (#6513) | Tie |
| iOS | App Store still **0.10.9 (2024-04-23)** (fetched 2026-11-11). 2.0: a native app in **invite-only testing** since 2026-10-20 (docs: "invite only for now") | **Absent**: no target, no work | Gap |
| Mobile sync | RTC (alpha); the iOS test app claims background sync and a ~200 ms start (Open Collective, 2026-10-20) | LAN sync, **foreground only** (`docs/architecture/sync-and-network.md`); in daily Android ↔ Linux use (maintainer report, 2026-10-21) | Partial |
| Phone UI | 2.0.2 popup and safe-area fixes | Phone layout overhaul with 44 px targets (#5941, #5948, #5955, #5957, #5958, #5969); page mode and its toolbar work on touch (#5691); read aloud through Android's `TextToSpeech` is on `main`, in no release (#6484). The Markdown mirror is desktop only. Whether the folder pickers that the vault, graph and restore imports need work in the Android WebView is **unverified** | Done |
| Mobile plugins | **None on mobile, in either version** | N/A | Tie |

### 17. Out of Scope for Agaric

| Feature | Logseq | Notes |
| --- | --- | --- |
| Plugin / extension system | **642 marketplace packages (72 themes)**; 148 declare DB support (23%), 63 of them DB-only, and 314 declare `effect: true` (49%, **un-sandboxed in the host origin**). Counted from `plugins.json` on 2026-11-11 by script, so not like-for-like with the 2026-10-21 hand tally (~625, ~132, ~309) | **No plugin API, no custom CSS, no user scripts.** 6 built-in themes plus an OS-following auto, font sizes, motion controls, full keyboard rebinding (not re-read). The seams are MCP (§12) and, on desktop, the Markdown mirror's files |
| Flashcards / SRS | OG: SM-5. **2.0: FSRS, does not import SM-5 data**; 2.0.2 "practice again" (#13410) | Not priority per user |
| Whiteboard | OG: tldraw fork. **2.0: REMOVED**, with slides and Excalidraw | Not priority per user |
| PDF highlight-to-block | OG: highlights become blocks on an `hls__` page. 2.0: `#PDF Annotation` tag; 2.0.2 imports annotations | pdf.js reader with highlight + comment; saving bakes annotations into a new attachment, moves the owning block's `attachment:<id>` links to it and deletes the original (#6629); a link copied into another block still names the original. Each new highlight becomes a child block of the PDF's owner on Save, with a source chip that reopens the reader on its page (#6629); comments make no block, and no existing annotation is imported |
| Zotero | OG: built-in. **2.0: REMOVED**, community plugin | BibTeX/CSL-JSON importer to typed reference pages |
| Org-mode | OG only; 2.0 dropped it | Design choice |

---

## Part 3: Where Agaric Genuinely Wins

Trimmed to claims that were re-checked on 2026-11-11 or stand as verified on 2026-10-21. One row,
"Files beside the database", is a win on `main` only and says so.

| Area | Agaric advantage | Against |
| --- | --- | --- |
| **Sync without a server** | **Free, no account, no server, no subscription**: two devices pair once with a passphrase or QR and converge through a Loro CRDT. Attachments converge too. Two-way sync is required in CI and in daily Android ↔ Linux use (maintainer report) | **2.0**: paid ($5/month minimum), self-hostable only by running a server, README says alpha. **OG**: no built-in sync. 2.0's Markdown Mirror is one-way, so Syncthing-style file sync of a 2.0 graph is not equivalent |
| **Search** | A 12-prefix filter DSL with validation and autocomplete, 19 filter fields, and `Ctrl+F` in-page find with regex | 2.0 has the same trigram index class, so the CJK and substring edge holds **against OG only**. 2.0 has opt-in macOS semantic search that Agaric lacks |
| **Journal** | 5 view modes, a content-dot calendar, drag-to-reschedule, `Alt`-key navigation, templates applied wherever a day is created, and a date format **that 2.0 removed** | One scrollable view with hardcoded 3+7 pagination |
| **Task dashboard** | A real agenda: 8 filter dimensions, sort and group, projected occurrences, DuePanel, DonePanel, `UnfinishedTasks` rollover | No agenda view; a `:scheduled/future-days` section and two default queries |
| **Recurrence** | Yearly intervals, three modes, end conditions, write-time validation, projection | No end conditions, no projection; OG's `.+` contradicts its docs |
| **Backlink filtering** | Server-side boolean tree over the filter predicates with keyset pagination | A filter bar |
| **Data integrity** | blake3 hash chain, SQL-enforced append-only, four-step boot recovery, an integrity check and engine vs SQL audits, op-level undo with batch revert | 2.0's README carries an official data-loss warning; 288 open `db-test` issues |
| **Conflict resolution** | Loro CRDT: blocks, text, properties, tags, moves and attachments converge without a user-facing conflict | File-level conflicts (OG) or alpha RTC (2.0) |
| **Spaces** | Per-space journal, tabs, recents, identity, `Alt+1..9`, write-time cross-space enforcement, page move between spaces | One graph per instance |
| **Editor breadth** | Native Mermaid, KaTeX, footnotes, 5 callout styles, 8 inline pickers, one toolbar in both editing modes, the Markdown reveal, opt-in page mode, Edit as Markdown, Markdown paste | Mermaid is a plugin; no toolbar; no page-as-document mode |
| **Files beside the database** (on `main`, in no release) | An opt-in desktop mirror that writes every page as Markdown and, since 2026-11-11, reads outside edits, new files, renames and moves back, each as one undo (#5363). The 0.23.0 release writes files and reads nothing back, which is what 2.0's mirror does | **2.0 only**, and only once released: its Markdown Mirror is one-way. Not OG, whose files are the store on every platform |
| **Getting in** | Importers for Obsidian vaults, Logseq graphs, Notion exports, Org, Evernote, Joplin and BibTeX; a re-import updates a page in place (#6033, #6277) | 2.0 imports file graphs, SQLite and EDN. OG imports Roam JSON and OPML, which Agaric does not |
| **Agent access** | 39 MCP tools, per-agent tokens, modes and space allow-lists | 2.0's MCP is narrower; its REST API is on master, in no release |
| **ID durability** | ULIDs; renames propagate; export externalizes them and re-import re-internalizes them | UUID v4; OG stores link text |
| **Supply chain** | SLSA provenance, Scorecard, CodeQL, blocking audits, a threat model, a release gated on a real-backend lane | Standard OSS CI |

**What keeps the sync win from being "out of the box" today.** The sync win is real only on one network:

- Discovery is mDNS-only, so devices on different networks cannot find each other. The opt-in relay
  helps only peers that have already found each other.
- Android syncs only in the foreground.
- Nothing backs the vault up on a schedule, and a restore is a manual export and folder import.
- Nobody has shown it working across networks or on a restrictive one.

These four, ranked, open [Part 9](#part-9-what-would-actually-make-agaric-superior).

---

## Part 4: Where Logseq Genuinely Wins

| Area | Logseq advantage | Agaric limitation |
| --- | --- | --- |
| **Transclusion** | Refs render live content inline, with children and a count badge; embeds show whole blocks with their task and property UI | Embeds show content-only rows and cannot be unlocked in page mode. Refs are chips with a pointer-only peek. No per-block badge, no peek on touch |
| **Data modelling (2.0)** | Typed properties with defaults, choices, multi-value, display position; tags as classes; `Extends`; bidirectional properties; per-tag name uniqueness | 7 types, no multi-value, no defaults or display control, inheritance outside the query vocabulary, no reverse properties, built-ins locked, priorities fixed. Since #5841 a definition can at least be renamed, merged and retyped |
| **Query power** | Simple DSL + Datalog + SCI transforms + Views with column control + aggregation macros | A deep engine with a fuller builder, but **no full user-facing query language** (§7), no transforms, one-hop traversal, single-space |
| **Human-readable storage** | OG: plain `.md`/`.org` files are the store, on desktop and mobile | The store is one SQLite file plus Loro state. The Markdown mirror (#5363) narrows this on desktop only, is off by default, and is a copy Agaric reconciles, not the source of truth. Released, it is one-way, like 2.0's; the two-way half is on `main` |
| **Exit story** | EDN, JSON, OPML, Roam JSON, HTML, Markdown; 2.0's **Build EDN** exports the whole schema | Markdown, assets and property definitions (`.agaric/space.json`); no history, no structured dump |
| **Ecosystem** | 642 packages, a plugin API, a CLI, custom.css/custom.js, a local HTTP API, and a REST API on master | MCP, and on desktop the mirror's files |
| **Publishing** | HTML SPA (OG) or hosted per-page publishing (2.0) | Absent |
| **Time tracking** | Built-in (OG); status history with time spent (2.0) | Absent |
| **Remote sync** | 2.0 RTC syncs any two devices on the internet (paid, alpha) | **Discovery is LAN-only.** QR pairing needs no multicast (#4702) and an opt-in relay exists (#5135), but only between peers already found on one network |
| **Backups** | 2.0: automated on desktop and browser, last 12 retained | Three pre-migration database copies, a manual export, the desktop mirror; nothing scheduled |
| **Platform reach** | 2.0: a native iOS app in invite-only testing and a native Android app taking backer sign-ups, an APK in the release; OG on the App Store and F-Droid | Android sideload only; no iOS |
| **Community** | 45.6k stars, 2.9k forks, an active forum, years of workflows | One maintainer; a public repository with 20 stars and 1 fork |
| **Research workflow** | PDF highlight-to-block, Zotero (OG), a mature reader | Reader with annotation, highlight-to-block on Save, BibTeX import |

---

## Part 5: Agaric's Self-Inflicted Problems

These are not gaps against Logseq. They are places where Agaric paid for a feature and does not
collect the benefit, or where its own documentation is wrong. Each carries its 2026-11-11 verdict.
Rows the last revision marked fixed (`listStyle`, the sync quarantine) are gone.

### Built but not fully reachable

| Thing | Cost paid | Verdict (2026-11-11) |
| --- | --- | --- |
| **`block_tag_inherited`** | A materialized table, five propagation paths, a rebuild job, an invariant | **Still partly reachable.** The Tags-view toggle (#4925), `under:` (#5797) and MCP `search` read it. No filter primitive does (`src-tauri/agaric-store/src/filters/primitive.rs`), so inline queries, agenda filters and Advanced Query cannot |
| **Page mode** | A second editor brought to parity with the first across the #5691 series: toolbar, gutter, menus, paste, undo grouping, touch | **Off by default.** A new user gets block mode. Pages over 1000 blocks and the journal's week and stream views cannot use it, and its per-key cost is open (#6224) |
| **The Markdown mirror** | An outbound writer, an ingest with a merge, rename detection, a fuzz target and five real-backend specs (#5363) | **Off by default, desktop only, per device, and its reading half is in no release** (merged 2026-11-11). A phone has no files, which is where someone leaving OG's mobile app would look for them |
| **Advanced query engine depth** | 10 property operators, 4 value types, 7 group keys, property aggregates | As on 2026-10-21, not re-read: bounded group preview, no column picker, no text language |
| **Saved views** | A saved-view UI and storage | Kept per space on the device, **not synced** (`docs/features/views.md`) |
| **The notification subsystem** | OS plumbing on three platforms, a settings tab, a permission flow | **Unchanged**: desktop `due_date` reminders while the app runs (#4806). The roadmap in `docs/FEATURE-MAP.md` files the rest under #4554, which closed on 2026-09-07, so no open issue tracks Android, `scheduled_date`, lead time or catch-up |
| **i18next** | ~3,056 keys across 13 namespaces (2026-08-30 count) | Two locales; Spanish covers the `errors` namespace and falls back to English elsewhere (`docs/FEATURE-MAP.md`) |

### Documentation that is false or stale

- **Still true:** `docs/features/pickers-and-slash.md` says `[[` points at "the page or block you
  pick". `docs/features/tags-and-links.md` says "Pick a page or paste a title", and the picker is
  pages-only.
- **New:** `docs/features/agent-access.md` lists 19 read-write tools. The registry has 20
  (`TOOL_ADD_MEETING` in `src-tauri/src/mcp/registry.rs`); `add_meeting` is described further down
  the same page.
- **New:** the `docs/FEATURE-MAP.md` roadmap cites the closed #4554 for the reminder work still
  outstanding.
- **Still unverified:** `docs/features/views.md` lists `AND`/`OR`/`NOT` for the search filter
  language; whether the filters honour them was not run.
- **Not re-checked:** the `agaric://settings/<tab>` example in `docs/features/agent-access.md`, and
  the "no date" and "custom range" presets in `docs/features/journal-and-agenda.md`.

### Quality signals that do not mean what they appear to

- **Mutation testing cannot fail a build.** `stryker.config.mjs` still sets no `thresholds.break`.
  The PR lane now reads a list of accepted mutants (`mutation-accepted.tsv`), which is a list of
  survivors someone decided to live with.
- **Fuzzing and the benchmark SLO gate run weekly, and the Android emulator checks nightly and at
  release**, not per PR.
- **The 100K-block benchmark measures latency only** (2026-10-21 finding, not re-read). Peak memory
  is unmeasured, and there is no Android performance number.
- **`revert_ops` is still exempt from its budget**
  (`revert_gate_skipped` in `src-tauri/benches/interactive_slo.rs`).
- **The main block editor is lazily mounted, not virtualized**
  (`src/components/block-tree/use-block-mount-limit.ts`), and page mode draws every block.
- **The CRDT library is pinned behind upstream.** `loro` is held at 1.13.6 until a release fixes a
  quadratic `find_common_ancestor` (#3161, open), so every sync runs on a version the project
  cannot move.
- **Accessibility depth is uneven.** 17 of 311 Playwright specs mention axe (grep, 2026-11-11); the
  597 unit-level assertions are a 2026-08-30 count.

---

## Part 6: The Logseq 2.0 Factor

**2.0 is where Logseq's development happens; OG is frozen.** Benchmarking Agaric against OG is
benchmarking against a product that will not change again.

| Component | Status (2026-11-11) | Effect on this comparison |
| --- | --- | --- |
| SQLite storage | Beta; 2.0.2 (2026-10-07) is still the latest release; README "data loss is possible"; 288 open `db-test` issues, up from 274 | Neutralizes Agaric's storage-efficiency argument |
| Typed properties, classes, `Extends` | Beta, **deeper than Agaric's**; master fixes hide-by-default (#13277) | Logseq's lead |
| Views (Table/List/Gallery) | Beta; not re-read | Exceeds Agaric's result table |
| **Markdown Mirror** | Shipped, opt-in, **one-way**; master fixed its incremental render (#13943). The team's 2026-04-24 post calls Markdown support in the DB version "the plan, but we are still researching the best way" | Release against release this is a tie: both mirrors only write. It flips when Agaric releases the ingest that is on `main` |
| **MCP server + CLI** | As in 2.0.2; master adds CLI page rename (#13931); the docs' TODO list is unchanged | Agaric's tool surface and per-agent scoping are deeper |
| **REST API with tokens** | Merged 2026-10-10 (#13019); in no release on 2026-11-11 | A programmable API Agaric lacks, once released |
| **File-graph import** | Master: a dry-run scan with a preview, plain Markdown folders, a rollback after a failed import (2026-10-29 to 11-09), unreleased | Narrows Agaric's importer lead once released |
| RTC sync | Backers ($5/month) and Sponsors ($15/month), self-hostable (docs master, 2026-11-11); README still says alpha; production E2EE not re-checked | Logseq syncs across networks for a fee; Agaric syncs free and serverless on one network |
| iOS app | Native app in **invite-only testing** since 2026-10-20; the App Store still serves 0.10.9 | Agaric has nothing |
| Android app | A native Jetpack Compose app, with backer testing announced for the week of 2026-11-09; the 2.0.2 APK stays in the release assets | Ahead of Agaric's WebView APK once it ships; today both are off-store |
| Desktop host | A `refactor/lui` branch is taking merged PRs for a new native desktop host (#13942, 2026-11-07, "Use MyGo for desktop and retire unused mobile hosts"). **Unverified** beyond that one PR page; not on master, in no release | If it lands, the Electron size and start-up figures in Part 1 stop applying |
| Semantic search | Opt-in, macOS ARM64 only, off by default (#12710); not re-read | Agaric has none |
| Plugin compatibility | **148 of 642 packages declare DB support (23%)**, 63 of them DB-only (script over `plugins.json`, 2026-11-11) | The ecosystem advantage is real, and most of it is not DB-ready |
| Removed in 2.0 | Whiteboards, slides, Excalidraw, built-in Zotero, org-mode, `{{query}}` macros (→ `/Query`), the `all-page-tags` and `sort-by` filters, `:journal/page-title-format`, SM-5 flashcard data. **`((uuid))` removal: unverified** (2026-10-21 reading) | Several Logseq advantages this document used to cite no longer exist in the version being developed |

**Honest read:** Logseq 2.0 is more capable than Agaric on data modelling, queries, ecosystem and
platform reach. It is less trustworthy on data integrity, its sync is paid and alpha, and it has
released nothing in five weeks while its issue count rose. Agaric's sync is free, serverless,
CI-verified and in daily use, but only on one network. On portability the two now differ in kind:
2.0 exports a full structured dump and mirrors Markdown one way. Agaric has no structured dump, and
its desktop mirror is one-way in 0.23.0 and two-way on `main`. Both carry real risk: 2.0 is a beta
with an official data-loss warning, and Agaric is a pre-1.0 app with one maintainer.

---

## Part 7: Who Should Use Which

| Persona | Better fit | Why |
| --- | --- | --- |
| **Journaling** | Agaric | 5 view modes, a content-dot calendar, drag-to-reschedule, templates applied wherever a day is created (#5395), and a date format 2.0 removed. Logseq gives one scrollable view. Logseq keeps readable `[[page name]]` in its files; Agaric stores `[[ULID]]` and writes the title on every text surface (#6277) |
| **Tasks / GTD** | Agaric | An agenda with 8 filter dimensions, projected occurrences (b5ac3a590), recurrence with end conditions, and opt-in desktop reminders that fire (#4806). Gaps: no `WAITING`, no time tracking, priorities fixed at 1–3 (#6017), no reminders on Android or with the app closed, and one block left per completed recurrence |
| **Long-form writing** | Agaric | Page mode (#5721, #5691) with the Markdown reveal edits a page as one WYSIWYG document over blocks, with the toolbar and on touch, and Edit as Markdown gives the raw source. Logseq's document mode (`t d`) adds a CSS class that hides bullets (shown on hover) and can make Enter insert a newline, but each block is still its own textarea (logseq/logseq `frontend/components/block.cljs`, `doc-mode-enter-for-new-line?` in `frontend/handler/editor.cljs`; 2026-10-21 reading). Limits: page mode is opt-in, capped at 1000 blocks, and slower per key on long pages (#6224) |
| **Zettelkasten** | Close; Logseq slightly ahead | Agaric now has embeds, the peek, link kinds, labels and linked references on a zoomed block. Logseq still renders ref content inline, shows a per-block reference count, and embeds whole blocks with their task and property UI |
| **Meeting notes** | Agaric | The Templates view, `{{cursor}}`, live inline queries and the agenda for action items. Bug: `/template` drops block properties, so pre-set TODOs insert as plain text; journal templates keep them |
| **Project management** | Split | Agaric's agenda and live queries aggregate without query-writing. 2.0's supertags, multi-value properties and per-tag tables model a project schema better |
| **Multi-device, no cloud** | Agaric | Free, serverless, no account. CI-verified two-way and in daily Android ↔ Linux use (maintainer report). Logseq 2.0 needs a $5/month tier or a self-hosted server, and its sync is alpha. Limits: one network, Android in the foreground only, no scheduled backup |
| **Plain files, own tools** | Logseq OG; Agaric on desktop | OG's files are the store on every platform, but OG is frozen. Agaric's mirror (#5363) gives files on desktop, off by default, with the database still the truth: one-way in 0.23.0, two-way on `main`. 2.0's mirror is one-way |
| **Leaving Logseq OG** | Agaric or 2.0 | Agaric imports a graph folder with journals, namespaces and block refs across files (#6033); 2.0 has File-to-DB, with a preview on master. Neither carries whiteboards, and Agaric does not translate `{{query}}` |
| **Research / reading** | Logseq | Highlight-to-block, Zotero (OG) and full embeds |
| **Plugin tinkerers** | Logseq | 642 marketplace packages, a plugin API, custom CSS/JS. Agaric offers MCP, and files on desktop |
| **iPhone** | Neither yet | Agaric has no iOS app. Logseq offers a 2024 file-version App Store app or an invite-only test of the 2.0 app |

**The core set.** Most people use a reduced core: journal, pages and links, tasks, search, templates,
and sync between their own devices. On that set the scorecard puts Agaric at parity or ahead, with
two exceptions. On linking substance it trails (7 against 9–10). For anyone who needs an iPhone, or
plain files on a phone, it is not an option. The losses outside the core are real: data modelling,
queries as text, the ecosystem and publishing.

---

## Part 8: Scorecard

Scoring shipped, stable functionality 1-10. Logseq 2.0 is scored on what a release ships (not
master), with its beta status called out separately rather than deducted twice. Agaric is scored
the same way, on 0.23.0: what was merged after it on 2026-11-11 is named and not counted.

| Category | Logseq OG (frozen) | Logseq 2.0 (beta) | Agaric | Change vs. 2026-10-21 revision |
| --- | :---: | :---: | :---: | --- |
| Block CRUD | 9 | 9 | 9 | — |
| Page management | 9 | 9 | 9 | — (names made on two devices now settle, #6278) |
| Editor formatting | 8 | 8 | 9 | — (page mode gained the toolbar and touch; footnotes; still opt-in and capped at 1000 blocks) |
| Linking system | 10 | 9 | 7 | — (page preview, link navigation, typed anchors; still no inline ref content, no per-block badge, pages-only picker) |
| Properties | 6 | **10** | **8** | **+1** (definitions per space and synced; rename, merge, retype with a preview; usage counts; still no multi-value, defaults or display control) |
| Tags | 8 | **10** | 7 | — |
| Query system | 9 | 9 | 7 | — (not re-read) |
| Task management | 7 | 8 | 8 | — |
| Daily journal | 8 | 7 | **9** | — |
| Search | 5 | 7 | **9** | — |
| Templates | 7 | 8 | 7 | — (`/template` still drops properties and is not atomic) |
| Spaces | 2 | 3 | **9** | — |
| AI / agent access | 2 | 8 | **9** | — (39 tools; 2.0's REST API still unreleased) |
| Sync / storage | 4 | 5 | **7** | — (property definitions sync and an export restores; not 8: nothing scheduled backs it up, mDNS-only discovery, foreground-only Android) |
| Data integrity | 3 | 4 | **8** | — (versioned derivations on `main`, #6488; `db-test` rose to 288 open) |
| Performance | 3 | 7 | 7 | — (page mode's per-key cost is open, #6224; `loro` held back, #3161) |
| Import / export | 9 | 8 | **7** | **+1** (Logseq graph, Notion and Org importers; re-import in place; an export that carries property definitions and that a folder import reads back. Not 8 yet: the restore that keeps templates and done dates, its test, and the mirror's reading half are on `main`, in no release. Not 9 either way: no structured export, no Roam, clipboard-only per-page export, mirror desktop-only) |
| Mobile | 5 | 4 | 5 | — (2.0's native apps are in invite-only or announced backer testing, in no release; Agaric gained page mode on touch and a launch check before release) |
| Extensibility / ecosystem | 9 | 6 | **2** | — (the released mirror only writes; on `main` its files are a second seam beside MCP, worth a point once released; no plugin API, CSS or scripting) |
| Project risk | 4 | 5 | **3** | — (one maintainer; three releases in 21 days, down from 14 in 54; 2.0 released nothing) |
| **Total** | **127** | **144** | **146** | previously 127 / 144 / 144 |

**Read this total carefully.** Unweighted category sums are a weak instrument. They treat
"Extensibility" and "Data integrity" as equally important, which they are not for a single user.

- **On raw capability, Agaric is 2 points ahead of Logseq 2.0, 146 to 144, which is inside this
  instrument's noise.** Both points come from properties and the importers, in three weeks in which
  2.0 released nothing. One 2.0 release carrying its REST API, its import preview and a store
  listing for either native app tips it back.
- **`main` would score 148.** The mirror's reading half and the pinned restore would add a point
  each, to import/export and to extensibility. They were merged on the day of this audit, the mirror
  has an open bug (#6506), and nobody has run either outside CI. They count when a release carries
  them, which is the rule 2.0's master is held to.
- **Weighted for the target workflow** (journaling, tasks, project notes, one person, no cloud),
  **Agaric wins clearly**. It leads on journal (9-7), search (9-7), spaces (9-3), sync (7-5), data
  integrity (8-4) and agent access (9-8), and ties on tasks (8-8) with the better dashboard. Its
  losses are linking (7-9), properties (8-10), tags (7-10), queries (7-9) and ecosystem (2-6).
- **Import/export is close in points and different in kind** (7-8). Agaric reads more formats. 2.0
  writes a complete structured export, and Agaric writes none.
- **Sync is the differentiator, within one network.** It is free, with no server and no account.
  Logseq's equivalent costs $5/month, runs through a server, and is alpha. On any other network,
  Agaric's devices cannot find each other, and on Android Agaric syncs only in the foreground.

---

## Part 9: What Would Actually Make Agaric Superior

### Sync first: the path to the killer feature

Ranked by how much each one stands between a user and sync that works out of the box. None of the
four moved since 2026-10-21:

1. **Discovery across networks.** Discovery is mDNS-only. The opt-in relay (#5135) carries traffic
   only between peers that have already found each other, and the QR carries a LAN address. Two
   devices on different networks cannot sync at all.
2. **Background sync on Android.** Sync is foreground-only
   (`docs/architecture/sync-and-network.md`), so a phone catches up only while it is open. Logseq's
   iOS test app claims background sync.
3. **A scheduled backup and a one-step restore.** The pieces exist: pre-migration copies, an export
   a folder import restores, the desktop mirror. Nothing runs on a schedule, and nothing restores
   history. Logseq 2.0 keeps the last 12 automatic backups on desktop.
4. **Close the proof gap.** Different-network and restrictive-network use is unproven.

### The 2026-08-30 list, with verdicts (2026-11-11)

Items 4 (provable sync), 9 (embeds) and 12 (live inline queries) were done by 2026-10-21 and are
dropped.

| # | Item | Verdict | What remains |
| --- | --- | --- | --- |
| 1 | Fix the false documentation | Partial | `[[` "page or block", the tool count and the closed #4554 (Part 5) |
| 2 | Wire or delete `block_tag_inherited` | Partial | Not in `FilterPrimitive` or inline queries |
| 3 | Finish the notification scheduler | Partial, and untracked | Android, closed-app delivery, catch-up, `scheduled_date`; #4554 is closed |
| 5 | Pairing fallback without multicast | Done for QR (#4702) | Passphrase-only pairing still needs multicast |
| 6 | Surface quarantined slots and op origin | Partial | The History view still does not show `agent:` origin (`docs/features/views.md`) |
| 7 | Ship backup/restore | Partial | Sync item 3 |
| 8 | Fix template block-property loss and the PDF dangling ref | Partial | `/template` drops properties (`insertTemplateBlocks` in `src/lib/template-utils.ts`); the PDF link is fixed (#6629) |
| 10 | Give references substance | Mostly done | A per-block count badge; a peek on touch; inline content |
| 11 | A user-facing query language | Partial | Query blocks take the search syntax (#6628); the builder does not write it yet |
| 13 | Multi-value properties | Open | `PRIMARY KEY (block_id, key)` |
| 14 | A structured export | Partial | The Markdown export now restores, with definitions in `.agaric/space.json` (#6277); no dump with history and saved queries |
| 15 | An answer to bus factor 1 | Open | The repository is public with 20 stars and one maintainer; MCP (39 tools) and the mirror are seams, not a plugin API |
| 16 | Is LAN-only still right? | Partial | Opt-in relay shipped; discovery is still one network: sync item 1 |
| 17 | Where does the hardening loop end? | Answered for this window | Three releases in 21 days, and a release APK is launched before it ships (#6050) |

### New since 2026-10-21

- **Release the mirror's reading half.** It is on `main` with five real-backend specs, a fuzz target
  and one open bug (#6506). Until a release carries it, Agaric's files are as one-way as 2.0's.
- **Decide what page mode and the mirror are for.** Both are built, tested and off by default. Either
  one becomes the default path for the users it was built for (people from Obsidian, people from OG),
  or the project keeps paying for two editors and two storage surfaces that new users never see.
- **Put files on the phone, or say they will not be.** The mirror is desktop only. Someone leaving OG's
  mobile app gets no files on Android.
- **Unpin `loro`** (#3161), or accept that the merge engine cannot take upstream fixes.

---

## Part 10: Corrections Log

What each revision changed about the one before it.

### 2026-11-11 revision

Method: one audit on a shallow checkout (50 commits, all dated 2026-11-11), so "what shipped" was
read from `docs/session-log/`, the feature docs and GitHub search, then checked against the code by
symbol. Logseq was read from repository pages and raw files; the GitHub API was not reachable for
`logseq/*`.

#### Audit errors in the 2026-10-21 revision

| Claim | Reality |
| --- | --- |
| Backup / restore: "None. The only exit is a lossy Markdown ZIP" | A copy of the database is taken before each migration, newest 3 kept (`MAX_KEPT_BACKUPS` in `src-tauri/src/db/pool.rs`). Pessimistic error. No scheduled backup existed then or now |
| Logseq import: "blocks past depth 19 dropped" | Flattened to the cap, with a count (`MAX_IMPORT_DEPTH` in `src-tauri/agaric-engine/src/import.rs`). Pessimistic error |
| Logseq's local HTTP server: "port and method count unverified", and "127.0.0.1:12315" dropped as not re-derived | The docs give `http://127.0.0.1:12315/mcp`. The method count is still unverified |
| OG's maintenance statement "appears only in a forum post (secondary source)" | The team's own post says it (logseq.io, 2026-04-24) |
| Agaric stars: "private" | Public on 2026-11-11 with 20 stars and 1 fork. Whether it was private on 2026-10-21 is not known |

#### Claims overtaken by changes since 2026-10-21

| Claim | Now |
| --- | --- |
| Human-readable storage: Edit as Markdown only; export is a projection | A Markdown mirror on desktop (#5363), off by default: one-way in 0.23.0, two-way on `main` (#6474, #6483, #6504) |
| Android row: "no Android device lane in CI" | A release APK is launched on an emulator at release and nightly (#6050, merged 2026-10-22; nightly since #6553) |
| "Import is per file"; a `((uuid))` into another file is stripped; `journals/` is not journal dates | A Logseq graph folder imports with journals, namespaces and block refs across files (#6033) |
| Import merge: "No merge" | A single-file re-import updates the page in place (#6277); folders and Logseq graphs still do not |
| Import formats without Notion or Org | Notion export folders and `.org` files import (#6033) |
| Export drops the schema; cross-page anchor re-import unverified | The ZIP carries property definitions in `.agaric/space.json`, and a restore is pinned by a test (#6496, #6502) |
| Schema registry: "No key rename, retype or usage count" | All three, per space, synced (#5841) |
| "14 code-defined built-ins" | 15, with `meeting_date` (#5364) |
| Formatting toolbar "block mode only"; page mode "desktop only", no toolbar, no table ops | One toolbar in both modes and in Edit as Markdown; page mode on touch; table and code bubbles (#5691) |
| Markdown reveal "not for quotes, fences, math" | Shown to read for quotes, callouts, fences, math and footnotes (#5691) |
| Markdown subset lacks footnotes | Footnotes ship (#6033) |
| Hover preview: block refs only; no link navigation into tabs | Page preview on `Ctrl` + hover; `Ctrl+click`, middle click, `Alt+Enter` (#5691) |
| Unique titles: "duplicates created offline on two devices unverified" | Settled after sync, with a real-backend spec (#6278) |
| MCP: 38 tools | 39 (`add_meeting`) |
| iroh 1.3.0 | 1.4.1 |
| Part 11's Obsidian rows citing #5691 as "in progress" | #5691 is closed. Those rows are left as written; see [COMPARISON-OBSIDIAN.md](COMPARISON-OBSIDIAN.md) |
| Logseq Android: "a native Android app is in development, undated" | Backer sign-ups since 2026-11-04; testing announced for the week of 2026-11-09 |
| Logseq iOS: "TestFlight", "under App Store review" | The docs say invite-only; no review status found; the App Store still serves 0.10.9 |

#### Stale external numbers, refreshed

- **2.0 repo:** 45.3k stars, 2.8k forks, 813 issues + 181 PRs, 274 `db-test` issues → 45.6k stars,
  2.9k forks, 801 issues + 224 PRs, 288 `db-test` issues. Still 2.0.2.
- **OG:** 335 stars, 63 forks, 18 issues → 352 stars, 69 forks, 19 issues, 13 PRs. No commit since
  2026-05-28.
- **Funding:** estimated annual budget $238,198 → $232,161; balance $43,428 → $33,975; $772,267
  raised in total.
- **Plugins:** "~132 of ~625" by hand → 148 of 642 by script (72 themes, 314 with `effect: true`).
- **Agaric:** 0.20.0 → 0.23.0; 432 merged PRs since 2026-10-21 (391 non-bot); 13 open issues.

#### Scorecard changes

Properties 7 → 8, Import / export 6 → 7. Agaric 144 → 146; Logseq 2.0 and OG unchanged. The first
pass of this revision gave Import / export 8 and Extensibility 3, for 148; the second pass took both
points back (below).

#### Rows added and deleted

- **Added:** "Plain Markdown files on disk" (Part 2 §2); "Files beside the database" and "Getting in"
  (Part 3); "Plain files, own tools" and "Leaving Logseq OG" (Part 7); "File-graph import" and
  "Desktop host" (Part 6); page mode and the mirror under "Built but not fully reachable" (Part 5).
- **Deleted:** the fixed `listStyle` and sync-quarantine rows and the fixed documentation items
  (Part 5); items 4, 9 and 12 of the verdict table (Part 9).

#### Second pass, same day

A second audit, with the full history (`git log 15f3f9705..HEAD`, 412 commits), checked this
revision's changed rows, its scorecard and its refreshed Logseq figures. What it changed:

| First-pass claim | Reality |
| --- | --- |
| Agaric "shipped" a two-way Markdown mirror; the mirror row is "Better vs 2.0" | 0.23.0 (2026-11-06) holds the outbound writer only (#6328). The ingest, new files, and renames and moves were merged on 2026-11-11 (#6474, #6483, #6504), after the release. Release against release, both mirrors are one-way. Overclaim |
| Scorecard: Import / export 8, Extensibility 3, total 148, with 2.0 scored "on what a release ships (not master)" | Agaric was scored on `main`. On 0.23.0: Import / export 7, Extensibility 2, total 146. The mirror had also been counted in both categories |
| Read aloud "on macOS, Windows and Android" | Android's engine was merged on 2026-11-11 (#6484), in no release |
| The export restore keeps templates and is pinned by a test; derived tables carry a version | Merged on 2026-11-11 (#6496, #6502, #6497), in no release |
| The Android launch check "may postdate 2026-10-21", filed as an audit error of the last revision | It was merged on 2026-10-22 (#6050), so the last revision was right on its day. Moved to the overtaken list |
| Task reminders: "Desktop, while running" | Also off by default (`ReminderSettings` in `src-tauri/src/reminders.rs`). A carried-forward row that never said so |
| Logseq 2.0 backups: "hourly … on desktop and browser" | The docs say hourly for the browser only; desktop is "automatically enabled", last 12 kept, with no interval given |
| Logseq Android: "in backer testing" | Sign-ups opened on 2026-11-04 and testing was announced for the week of 2026-11-09; no source says it began |
| The mirror "reads outside edits, new files, renames and moves back", with no word on deletes | A file deleted outside Agaric is written again; deleting a file does not delete its page (`docs/features/import-export.md`) |
| The 2026-04-24 post speaks "of editing Markdown again" | The question it answers is whether the DB version will support Markdown files |

What it confirmed, from the code or a primary source:

- **Agaric:** 19 + 20 MCP tools; 23 `FilterPrimitive` variants; 19 `SearchFilter` fields; 12 search
  prefixes; 15 built-ins; `MAX_KEPT_BACKUPS` 3; `MAX_IMPORT_DEPTH` 19, flattening; iroh `=1.4.1`;
  `loro` `=1.13.6`; engine format 6; page mode off by default and capped at 1000 blocks; the mirror
  off by default, desktop only, one device per folder, under Settings → Data; 311 Playwright specs,
  17 naming axe, and 127 real-backend specs; three releases (2026-10-24, 10-31, 11-06); 20 stars,
  13 open issues; #5363, #6277, #6224, #6506 and #3161 open, #4554 closed. Every changed row's PR
  resolves to a commit in the range, and the three doc drifts listed in Part 5 are real.
- **Logseq:** 2.0.2 (2026-10-07) latest, the nightly tagged 20261025; the README's beta, alpha and
  data-loss wording; $5 and $15 tiers and self-hosting (docs); `127.0.0.1:12315`; iOS "invite only",
  Android "not opened up for alpha testing yet" (docs) against the 2026-11-04 Open Collective
  update; the iOS update's background sync and ~200 ms start; 45.6k stars, 801 issues, 224 PRs; 288
  `db-test` issues; OG at 352 stars, last commit 2026-05-28; 642 / 72 / 148 / 63 / 314 from
  `plugins.json` by script; #13931 and #13943 on master; #13942 merged into `refactor/lui`; the
  import preview and plain-folder commits of 2026-10-29; App Store 0.10.9.

Not reached by either pass: a run of the app. Every Agaric claim is a reading of code, docs and
tests.

#### Carried forward from 2026-10-21 without a re-read

Part 2 §7 (queries) apart from the primitive count and saved views; §8 (tasks) apart from the state
and priority constants; §9 (journal) apart from the mode list; §10 apart from the prefix and field
counts; §11; §14 apart from `insertTemplateBlocks`; the PDF row in §17; Logseq's semantic search,
Views, removed-features list, F-Droid listing and binary sizes; the download counts in Part 11.

The second pass re-read the constants and symbols these rows cite (task states, priority levels,
reminders, journal modes, date formats, group keys, embed limits, the peek's dwell, the `/template`
property loss) and found them as written. Their prose beyond those symbols is still carried.

### 2026-10-21 revision

#### Audit errors in the 2026-08-30 revision

| Claim | Reality |
| --- | --- |
| Logseq's `unicode61` tokenizer cannot segment CJK; Agaric's CJK/substring search is "Better" | True for **OG only**. 2.0 creates `fts5(…, tokenize="trigram")` (`frontend/worker/search.cljs` upstream, since 2024-07-20) |
| Template insertion is a "single batched IPC, atomic" | One `createBlocksBatch` per depth level; an error stops after earlier levels landed (`insertTemplateBlocks` in `src/lib/template-utils.ts`). Never true |
| 2.0 "Android not open even for alpha" | The 2026-08-30 revision itself listed a 37.8 MB 2.0.1 APK; 2.0.2 ships one as a release asset |
| 2.0 removed the `((uuid))` syntax | No source found; #13717 still exports `((uuid))`. Unverified |
| Markdown Mirror "restores external access" | One-way per the only dated source (secondary). Reading, not editing |
| 2.0 has "6 real types" (listing seven) | Seven named, and the `:schema :type` registry lists more |
| Unknown editor nodes are "silently dropped" | Dropped with a once-per-session toast (`src/editor/markdown-serialize-toast.ts`). Pessimistic error |
| Per-page `Ctrl+Shift+E` exports a file | It copies to the clipboard, with attachments as filename stand-ins |
| Logseq import drops "blocks past depth 99" | The import cap is 19 (`MAX_IMPORT_DEPTH` = `MAX_BLOCK_DEPTH` − 1) |
| Agaric "23 primitives" | **Stands**: `FilterPrimitive` has 23 variants on `15f3f9705`. An audit proposed 24; the code does not support it |

#### Claims overtaken by changes since 2026-08-30

| Claim | Now |
| --- | --- |
| Part 0: "Logseq shipped a major version while Agaric shipped one feature"; the project is "improving its own immune system" | ~1,076 PRs and 14 releases; embeds, page mode, live queries, CI-verified sync. Logseq shipped one beta point release |
| No block or page embeds | Shipped with limits (#4572, #4809) |
| The full-content hover was removed (#4228) | The peek restores it, pointer only (#4947) |
| `block_links` has no kind discriminator | Migration 0119, #4943 |
| Linked references never on a block; custom labels absent; unique titles not modelled | On a zoomed block (#4945); `[[Page\|label]]` (#5175); unique per space (#4782) |
| Tag inheritance is **Dead** | Partial: toggle (#4925), `under:` (#5797) |
| Inline queries are not live; grouping 5 of 7 in the UI | Live (#5316); all 7 (#4804) |
| Priority levels "Configurable", **Better** | Fixed 1/2/3 (#6017): **a regression** |
| "20 seeded" built-in properties | 14 code-defined built-ins (#6017, migration 0128) |
| `block_properties` has "6 typed values" | 7, with `url` (#5142) |
| Recurrence projection in the Due Panel, "not Agenda" | Both (b5ac3a590) |
| Deadline warning in "Settings → General"; a per-space journal-template override | Settings → Tasks & reminders (#5635); override retired (#5405) |
| Spaces switch with `Ctrl+1..9` (the 2026-08-30 text before its in-place patch) | `Alt+1..9`; `Ctrl+1..9` switches tabs (#6022) |
| "Table dimension syntax with a grid picker"; seven inline pickers | `/tableRxC` removed (#5766); eight pickers with `#` (#5205) |
| MCP: two RO/RW sockets, 17 tools, no auth or per-agent scoping | One socket, per-agent tokens, modes and spaces (#5759); 38 tools |
| Two-way sync unverified | CI-verified (#5589, #5604, #5996) and in daily Android ↔ Linux use (maintainer report) |
| Attachments never converge; snapshots hold the vault in RAM with an ~18 s lock; legacy CBOR catch-up wipes the op log | Converge (#5608, #5728); blob gone (#4693, #4727) |
| LAN only, "relays cleared" | An opt-in relay (#5135), off by default |
| Every `((block-ref))` stripped on Logseq import | Same-file refs resolve via `id::` (#5214) |
| 2.0.1, iOS "invite-only alpha", sync "paid/invite-only" | 2.0.2; iOS TestFlight; sync open to $5/$15 backers |

#### Stale external numbers, refreshed

- **2.0 version and repo:** 2.0.1 (2026-07-13), 44,687 stars, 858 issues + 107 PRs, 346 `db-test`
  issues → 2.0.2 (2026-10-07), 45.3k stars, 2.8k forks, 813 issues + 181 PRs, 274 `db-test` issues.
- **OG:** 268 stars and ~17 issues → 335 stars, 63 forks, 18 issues and 13 PRs.
- **2.0 binaries:** 135–174 MB plus a 37.8 MB APK → 141–169 MB plus a 42.1 MB APK.
- **Funding:** "~$252k/yr Open Collective" → an estimated annual budget of $238,197.74, with
  $761,717.86 raised in total and a $43,427.67 balance.
- **Plugins:** "110 of ~615" → ~132 of ~625 (approximate, and not like-for-like).
- **Dropped as not re-derived:** "324 contributors", "2,257 commits / 46 authors in six months",
  "44% no push in 2+ years", "~85 methods", "127.0.0.1:12315".

### 2026-08-30 revision

What that revision changed about the 2026-08-04 one.

#### Claims that were false

| Previous claim | Reality |
| --- | --- |
| Sync uses "mTLS WebSocket with TOFU cert pinning (ECDSA P-256), plaintext-JSON pairing handshake" | That stack was **deleted**. Transport is iroh QUIC/UDP with TLS 1.3 in-handshake and ed25519 endpoint ids |
| Notifications include "task/deadline reminders via `notifyTask`" | `notifyTask` had one production caller: the "send test" button |
| "Manual IP entry / mDNS fallback — Done" | No first-pairing fallback existed (#3952) |
| Multi-device sync "Done", sync architecture "Better" | The repo's own docs said two-way sync was unverified (#3507) |
| Tag inheritance is a working capability | Materialized and maintained, read by no query surface |
| Inline query blocks are "live-updating" | `staleTime: Infinity`, no invalidation |
| "Unlimited depth (max 20)" | Depth is hard-capped at 20, backend-enforced |
| "No lists (blocks ARE list items)" | Ordered, bullet and task lists ship as real nodes |
| Block refs have a "hover tooltip with full content to 300 chars" | Removed in #4228 |
| Logseq import: "block ref stripping" listed as a feature | It is data loss |
| iOS blocked by "mDNS issue #522" | #522 is closed and was about manual IP entry; there is no iOS work |
| MCP is "read-only by default" | Two sockets, read-only and read-write, 17 tools |
| Deadline warning configured "in PropertiesView" | Settings → General |
| Recurrence projection appears in Agenda mode | Due Panel |
| Agenda has "collapsible TODO/DOING/DONE sections" | Grouping is user-selectable and defaults to page |

#### Claims that were overstated

| Previous claim | Correction |
| --- | --- |
| Advanced-query builder offers the full engine | 4 of 10 property operators, Text only, 5 of 7 group keys, column-only aggregates |
| Effort tracking "Better" | A fixed 6-option select with no rollup |
| Encryption "Tie" | Agaric has none at rest; Logseq Sync has age end-to-end |
| Snapshots/compaction "Better" | Whole-vault RAM buffering and an ~18 s write-lock hold at 100K blocks |
| Android "Better" | arm64-only, API 30+, sideload-only is narrower than Logseq's reach |
| "Cursor pagination everywhere" | The main block editor is not virtualized |
| Spaces include "sync-scope" | A session syncs every space |
| "~15,000+ tests" | 6,284 Rust test functions, 903 frontend and e2e test files |
| "axe a11y tests on 100+ components" | 597 assertions across 284 files, but only 4 of 110 e2e specs run axe |
| A draft of that revision: "there is no skip-link anywhere" | False in the pessimistic direction: `src/App.tsx` renders one |
| "Extras" row (Logseq 9 / Agaric 3) | Retired into "Extensibility / ecosystem" |

---

## Part 11: Coming from Logseq or Obsidian

Popularity comes from download counts, not guesses. Obsidian figures are the `downloads` field of
`community-plugin-stats.json`, joined to `community-plugins.json` for names (obsidianmd/obsidian-releases,
fetched 2026-10-21, 9,235 plugins). Logseq figures sum the release-asset downloads per package in the
marketplace's `stats.json` (logseq/marketplace, last refreshed 2026-10-19, 667 entries; `stat.json`
does not exist). Release-asset sums are approximate. Core features have no usage data, so they are
listed by area, not by rank.

### Coming from Obsidian

The full comparison with Obsidian is in [COMPARISON-OBSIDIAN.md](COMPARISON-OBSIDIAN.md); the tables
below are the 2026-10-21 summary, left as written.

| Obsidian core feature | Agaric | Status |
| --- | --- | --- |
| Plain Markdown files in a folder vault | SQLite + Loro state. The Obsidian vault importer maps folders to namespaced titles; export is a ZIP; Edit as Markdown edits one page's source | Design choice |
| Live Preview | Page mode + the reveal for inline marks, links, chips and headings. Open (#5691): block-level reveal for callouts, quotes, fences and math, pages over 1000 blocks, touch | Partial |
| Wikilinks and aliases | `[[` picker, typed `[[text]]`, `[[Page\|label]]`, `[[Page#Heading]]`, aliases as ops. Stored as ULIDs, so not readable as raw text. `Ctrl`/`Cmd`+click and `Alt+Enter` navigation in progress (#5691) | Done |
| Page preview on hover | Block refs peek (#4947); `Ctrl`+hover page preview in progress (#5691) | Partial |
| Backlinks | Linked and unlinked references with filters and a kind toggle | Done |
| Graph view | Global + local graph | Done |
| Canvas | None | Gap |
| Daily notes, Templates | Journal with 5 modes; templates with two variable grammars | Done |
| Command palette, quick switcher, chords | `Ctrl+P`, `Ctrl+O`, `Ctrl+E`, `Ctrl+1..9`, `Ctrl+Shift+T` (#6022) | Done |
| Tabs | Per-space tabs, `Ctrl+1..9`, reopen. Open (#5691): drag to reorder, middle-click to close, drag a page into the editor to link it | Partial |
| Properties (YAML) | Typed properties; front matter read on import and in Edit as Markdown. No list (multi-value) properties | Partial |
| Tags, nested tags | `#tag` chips, prefix hierarchy, boolean tag queries | Done |
| Search | Trigram FTS, the filter DSL, `Ctrl+F` with regex. Not compared feature by feature with Obsidian's operators | Done |
| Outline | Page outline (#5697) | Done |
| File explorer, folders | Pages browser, namespaces, spaces; no folders | Design choice |
| Embeds `![[…]]` | `{{embed}}` for blocks and pages, with content-only rows. Obsidian import maps `![[file]]` to attachments today; note, heading and block embeds on import are decided but not built (#5691, #6032) | Partial |
| Sync (paid: $4/month billed annually, $5 monthly) | Free peer-to-peer sync on one network | Design choice |
| Publish (paid: $8–10 per site per month) | None | Gap |
| Mobile (App Store, Google Play) | Android sideload APK; no iOS | Partial |

| Top community plugins (downloads) | Agaric equivalent | Status |
| --- | --- | --- |
| Excalidraw (8.63M) | None; whiteboards are out of scope | Gap |
| Templater (5.97M) | Template variables and `{{cursor}}`; no scripting | Partial |
| Dataview (5.18M) | `{{query}}` with the builder, 23 primitives, live results; no text query language, no JS | Partial |
| Tasks (4.47M) | Agenda, due/scheduled dates, recurrence with end conditions, projection | Done |
| Git (3.33M) | No files to commit; op-log history with revert in HistoryView | Design choice |
| Advanced Tables (3.30M) | Pipe tables, size grid, row/column ops in the block-mode toolbar | Partial |
| Calendar (3.21M) | Journal calendar with content dots | Done |
| Style Settings (2.79M), Minimal Theme Settings (1.86M) | 6 fixed themes plus auto, no custom CSS | Gap |
| Copilot (2.77M), Claudian (2.48M): AI agents in the vault | MCP with 38 tools and per-agent tokens; the agent runs outside the app | Partial |
| Kanban (2.77M) | None | Gap |
| Remotely Save (2.32M): sync through cloud storage | Peer-to-peer sync on one network; no cloud target | Design choice |
| Iconize (2.27M) | None; tag colours and space accents only | Gap |
| TaskNotes (2.26M): tasks with time tracking | Tasks yes, time tracking no | Partial |
| QuickAdd (2.26M) | Quick Capture (`src/components/settings/QuickCaptureRow.tsx`) | Partial |
| Editing Toolbar (2.06M) | Formatting toolbar, block mode only | Done |
| Omnisearch (2.02M) | FTS over blocks; PDF and OCR search not checked | Partial |
| Importer (1.83M) | Built-in Obsidian, Evernote, Joplin, Markdown and BibTeX importers | Done |
| Outliner (1.46M) | Agaric is an outliner | Done |

**What a migrant should know.**

- The vault stops being files: notes live in one SQLite database, and links are ULIDs.
- The daily loop is there: daily notes, links, backlinks, tasks, templates, the palette and the
  chords.
- Excalidraw, Canvas, Kanban, Publish and theming are not.
- Live Preview's counterpart, page mode, is opt-in, desktop-only and capped at 1000 blocks.
- Sync is free but works on one network only. Obsidian Sync works anywhere for $4–5 a month.

### Coming from Logseq

| Logseq core feature | Agaric (detail in Part 2) | Status |
| --- | --- | --- |
| Outliner, block refs `((…))` | Chips + peek; no inline content, no per-block count (§1, §4) | Partial |
| Block and page embeds | Content-only rows, editable behind an unlock (§1) | Partial |
| Journals | 5 view modes, calendar, templates (§9) | Better |
| Properties | 7 types; no multi-value, defaults or reverse properties (§5) | Partial |
| Tags as classes (2.0) | Tags and pages are separate; no supertags (§6) | Design choice |
| Queries (simple DSL, Datalog) | Builder and `v2:` payloads, live; no full text language (§7) | Partial |
| Tasks and the scheduled section | Agenda, projection, rollover (§8) | Better |
| Templates | Templates view and variables; `/template` drops properties (§14) | Done |
| Namespaces | Tree view and breadcrumbs (§2) | Done |
| Graph view | Global + local (§4) | Done |
| PDF annotation | Reader with highlights and comments; highlights become blocks, comments do not (§17) | Partial |
| Flashcards, whiteboards | None; 2.0 also removed whiteboards (§17) | Gap |
| Sync | Free on one network, against paid RTC (§13) | Design choice |
| Plain files (OG) | SQLite + Loro; an opt-in, desktop-only Markdown mirror, which reads edits back on `main` only (§2) | Design choice |
| Importing a Logseq graph | A graph folder imports with namespaces, journal days and block refs across files; `{{query}}` and whiteboards are not translated (§15) | Done |

| Top marketplace packages (downloads) | Agaric equivalent | Status |
| --- | --- | --- |
| Journals calendar (269,582) | Journal calendar with content dots | Done |
| Bullet Threading (237,946) | Not found; indent guides appear only while dragging (`src/components/editor/BlockListRenderer.tsx`) | Gap |
| Tabs (211,249) | Per-space tabs | Done |
| TODO List (204,672) | DuePanel and agenda | Done |
| Themes: Bonofix (163,666), Dev (95,760), Catppuccin (73,925), Atlas (53,982) | 6 fixed themes plus auto, no custom CSS | Gap |
| Markmap (126,558) | None | Gap |
| Tags (124,850) | Tags view with usage counts | Done |
| Markdown Table Editor (118,367) | Size grid and toolbar row/column ops | Partial |
| PDF Export (106,695) | Not found | Gap |
| GPT-3 OpenAI (84,893) | No in-app AI; MCP agents run outside | Gap |
| Agenda (82,818) | Agenda mode | Better |
| Heatmap (80,406) | Calendar dots and counts, no heatmap | Gap |
| Awesome UI (71,753), Awesome Styler (51,390) | Fixed layout, no custom CSS | Gap |
| Link Preview (60,107) | External link preview on hover, behind a setting (#3684, `src/components/settings/EditorTab.tsx`) | Done |
| Kanban (59,129) | None | Gap |
| Block to page (53,440) | Not found | Gap |
| TODO Master (50,938) | No progress bar found | Gap |
| Git (49,524) | No files in the store; op-log history. On desktop the mirror's folder can be committed like any other (not tried here) | Design choice |

**What a migrant should know.**

- A graph folder imports with its namespaces, journal days and block refs across files. `{{query}}`
  macros, whiteboards and clock drawers do not come across, and custom task states fold into four.
- Links become ULID chips that survive renames; every text surface writes them back as `[[Title]]`.
- Supertags and multi-value properties have no equivalent.
- Journals, tasks, search and spaces are stronger.
- Sync is free and needs no server, but works on one network only.
- Files exist only through the Markdown mirror: desktop, off by default, and write-only until the
  release after 0.23.0.
- Most of the top plugins map to built-ins or to nothing; there is no plugin API to fill the gap.

---

## Appendix: Method and Sources

**Agaric claims** were checked on 2026-11-11 by one audit against the working checkout of
`origin/main` at `db1628007` (v0.23.0). The checkout is shallow (50 commits, all from 2026-11-11), so
the list of what shipped since `15f3f9705` comes from `docs/session-log/` (sessions 2835 to 3824),
`docs/FEATURE-MAP.md`, `docs/features/*.md` and GitHub search for PR counts, and each claim taken
from a doc was then checked against a symbol, a migration, a workflow or a test file. Issue numbers
such as #5363, #5691, #5841, #6033 and #6277 name the plan a series of PRs shipped under; a PR
number is given where the squash title in `git log` carries one. No runtime behaviour was exercised,
no test suite was run, and the maintainer's daily-use report is the 2026-10-21 one. Rows that were
not re-read are listed at the end of the 2026-11-11 entry in Part 10. A second pass the same day
had the full history and the release tags' commits, and separated what 0.23.0 carries from what
`main` carries; its changes are in the same entry.

**Logseq claims** were checked on 2026-11-11 against:

- <https://github.com/logseq/logseq>, its releases page (2.0.2, 2026-10-07, still latest), its
  `master` commit list, its merged-PR search since 2026-10-21, and PR #13942
- <https://raw.githubusercontent.com/logseq/logseq/master/README.md>
- <https://github.com/logseq/og>, its `version/file` commit list and its releases page
- <https://github.com/logseq/db-test/issues> (288 open)
- <https://raw.githubusercontent.com/logseq/docs/master/db-version.md> (sync access, MCP, backups,
  iOS and Android sections)
- <https://raw.githubusercontent.com/logseq/marketplace/master/plugins.json> (642 packages, counted
  by script)
- <https://opencollective.com/logseq> and its updates of 2026-10-20 (native iOS app) and 2026-11-04
  (native Android testing)
- <https://logseq.io/p/e3YDyX5AYr> ("Big update: Logseq is splitting into two versions", 2026-04-24;
  the first third of the page was read)
- <https://apps.apple.com/us/app/logseq/id1601013908> (0.10.9, 2024-04-23)

**Sources that could not be reached on 2026-11-11.** Claims resting on them keep their 2026-10-21
wording and date:

- The GitHub REST API for `logseq/*` (this session's token covers Agaric only). Repository pages
  were read as HTML through a summarizing fetch, so star, issue and PR counts are as displayed, and
  commit and PR titles are as that fetch reported them.
- Release asset lists (2.0.2 and nightly) did not load, so binary sizes and the nightly's contents
  are the 2026-10-21 figures. The nightly tag read "20261025".
- The Google Play listing `com.logseq.app` returned 404 to the fetch; whether a public listing
  exists is **unverified**.
- F-Droid, the forum and the Logseq source files cited on 2026-10-21 (`frontend/worker/search.cljs`,
  `deps/db/src/logseq/db/frontend/property.cljs`, document mode) were not re-fetched.
- `stats.json` in `logseq/marketplace` was fetched, but its release counts no longer summed the way
  the 2026-10-19 reading did, so the download figures in Part 11 are not refreshed.

**Obsidian claims** (Part 11) are the 2026-10-21 ones, checked then against
<https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json>,
`community-plugins.json` in the same repo, <https://obsidian.md/pricing> and
<https://obsidian.md/download>. They were not re-checked;
[COMPARISON-OBSIDIAN.md](COMPARISON-OBSIDIAN.md) is the current comparison.

**Explicitly unverified** and not asserted above:

- **Logseq:** any 2.0 GA date; whether the 2.0.2 Android APK is native or WebView; App Store review
  status; a public Google Play listing; production RTC E2EE; the July 2026 iOS data-loss incident;
  contributor counts; the `refactor/lui` branch beyond one PR page; a two-way Markdown Mirror; the
  `((uuid))` removal; 2.0's plugin-API size; 2.0's long-block and mobile-search behaviour; CJK on
  2.0; whether native Android testing began in the week of 2026-11-09.
- **Agaric:** every runtime behaviour, including the mirror, page mode on touch and the Logseq graph
  import against a real graph; whether search `AND`/`OR`/`NOT` applies to filters; what a Logseq
  `{{query}}` macro becomes after import; the agent-access deep link; the ~24 MB Android APK size in
  the README; different-network and restrictive-network sync; whether folder imports (a vault, a
  Logseq graph, a restore) can be picked on Android.
