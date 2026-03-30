# Logseq Feature Inventory

> Comprehensive reference of Logseq features and syntax for comparison purposes.
> Covers the **file-graph** (stable, Markdown/.org flat files) version primarily,
> with notes on the **DB-graph** (beta, SQLite-backed) version where behavior diverges.
> Sources: [docs.logseq.com](https://docs.logseq.com), [GitHub README](https://github.com/logseq/logseq),
> [logseq/docs repo](https://github.com/logseq/docs).

---

## 1. Block Model

Logseq is an **outliner-first** application. Every piece of content lives inside a
**block** (a bullet point). Blocks nest via indentation to form trees.

### 1.1 Outliner Structure

Every page is a tree of blocks. A block is the atomic unit of content:

```markdown
- This is a top-level block
  - This is a child block (indented)
    - This is a grandchild block
  - Another child block
```

- **Indent** a block: `Tab`
- **Outdent** a block: `Shift+Tab`
- **Move block up**: `Alt+Shift+Up`
- **Move block down**: `Alt+Shift+Down`
- **Collapse** a block (hide children): click the arrow, or `Ctrl+Up`
- **Expand** a block: click the arrow, or `Ctrl+Down`
- **Zoom in** to a block (focus): click the bullet, or `Alt+Right`
- **Zoom out**: `Alt+Left`
- Each block is rendered as a bullet point in the outliner; there is no "paragraph mode" outside blocks.

### 1.2 Block References

Every block has a UUID. You can reference any block from anywhere:

```markdown
- Original block content
  id:: 6489a1b2-3c4d-5e6f-7890-abcdef123456

- I'm referencing the block above: ((6489a1b2-3c4d-5e6f-7890-abcdef123456))
```

- **Syntax**: `((block-uuid))`
- The reference renders inline as the referenced block's content.
- You can **copy a block reference** via right-click > "Copy block ref" or `Ctrl+Shift+R`.
- Block refs are **live**: editing the source block updates all references.

#### Block Reference with Label

You can provide custom display text for a block reference:

```markdown
[my custom label](((6489a1b2-3c4d-5e6f-7890-abcdef123456)))
```

### 1.3 Block Embeds

Embeds render the full content (and children) of a block inline:

```markdown
{{embed ((6489a1b2-3c4d-5e6f-7890-abcdef123456))}}
```

- Embeds are **live** and **editable in-place** (changes propagate back to the source).
- Contrast with block references which show content read-only inline.

### 1.4 Block Properties

Properties are `key:: value` pairs attached to any block:

```markdown
- Buy groceries
  priority:: high
  status:: todo
  due:: [[2024-01-15]]
```

- Properties go on lines immediately after the block's first line.
- Property names are **case-insensitive** and **lowercased** internally.
- Underscore `_` is converted to `-` (e.g., `done_at` becomes `done-at`).
- Valid characters: alphanumeric plus `. * + ! - _ ? $ % & = < >`.
- Property values can contain **page references**, **tags**, and links:
  ```
  description:: [[Logseq]] is a #knowledge-management tool
  ```
- To prevent link parsing in a value, wrap it in quotes:
  ```
  description:: "[[This]] won't become a link"
  ```

### 1.5 Block UUIDs

- Every block is automatically assigned a UUID.
- You can explicitly set or view it with the `id::` property:
  ```markdown
  - My block content
    id:: 60ab3eb7-c1e8-47ad-8a18-770896a10c5c
  ```
- UUIDs are used for block references `((uuid))`, block embeds, and published URLs.

### 1.6 Block Operations Summary

| Operation | Shortcut | Description |
|-----------|----------|-------------|
| Indent | `Tab` | Make block a child of the block above |
| Outdent | `Shift+Tab` | Promote block one level |
| Move up | `Alt+Shift+Up` | Swap with sibling above |
| Move down | `Alt+Shift+Down` | Swap with sibling below |
| Collapse | `Ctrl+Up` | Hide children |
| Expand | `Ctrl+Down` | Show children |
| Zoom in | `Alt+Right` | Focus on this block |
| Zoom out | `Alt+Left` | Go back to parent context |
| Delete block | `Backspace` on empty | Remove the block |
| New sibling | `Enter` | Create block at same level |
| New child | `Tab` after `Enter` | Create indented block |
| Select block | `Esc` then arrow keys | Block-level selection |

---

## 2. Page Model

### 2.1 Pages as Top-Level Containers

- Every **page** is a flat file on disk (one `.md` or `.org` file per page).
- A page's file name IS its page name (e.g., `Project Planning.md` = page `Project Planning`).
- Pages contain a tree of blocks. The first block of a page is special: it holds **page properties** (frontmatter).

### 2.2 Page Properties (Frontmatter)

Properties in the **first block** of a page are page-level properties:

```markdown
title:: My Project Plan
tags:: project, planning
alias:: PP, Project Plan
icon:: 1f4cb

- First actual content block starts here
  - child block
```

- Page properties power queries, filtering, and page metadata.

### 2.3 Page Aliases

The `alias` property lets a page be known by multiple names:

```markdown
alias:: JS, ECMAScript
```

- Linking to `[[JS]]` or `[[ECMAScript]]` will resolve to the same page as `[[JavaScript]]`.
- Aliases show up in search and autocomplete.

### 2.4 Namespaced Pages

Use `/` in page names to create hierarchical namespaces:

```markdown
[[Project/Frontend]]
[[Project/Backend]]
[[Project/Backend/API]]
```

- Logseq treats the `/` as a namespace separator.
- The parent page `[[Project]]` automatically lists its children.
- Namespaces provide a folder-like hierarchy within the flat page model.
- In the DB version, namespaces are managed via the **Library** page, which displays namespaced pages as an outliner tree.

### 2.5 Page Tags

Tags can be associated with pages in two ways:

```markdown
tags:: book, fiction, sci-fi
```

Or inline in any block:

```markdown
- This page is about #book topics
```

- The `tags` property specifically creates links to tag pages and populates the "Pages tagged with X" section.

### 2.6 The `title` Property

Overrides the display name of a page independently of the file name:

```markdown
title:: A Very Long Descriptive Title
```

---

## 3. Editor & Formatting

### 3.1 Dual Format Support: Markdown + Org-mode

Logseq supports **both** Markdown (`.md`) and Org-mode (`.org`) file formats. You choose per-graph at creation. The outliner experience is the same; only the on-disk syntax differs.

**Markdown property syntax:**
```markdown
property:: value
```

**Org-mode property syntax:**
```org
:PROPERTIES:
:property: value
:END:
```

### 3.2 Inline Formatting

| Format | Markdown Syntax | Renders As |
|--------|----------------|------------|
| **Bold** | `**Bold**` | **Bold** |
| *Italic* | `*Italic*` | *Italic* |
| ~~Strikethrough~~ | `~~Strikethrough~~` | ~~Strikethrough~~ |
| Highlight | `^^Highlight^^` | Highlighted text |
| Inline code | `` `code` `` | `code` |
| Underline | (via HTML: `<ins>text</ins>`) | Underlined |

### 3.3 Block-Level Formatting

#### Headings

Markdown headings inside blocks (note: headings are still blocks):

```markdown
- # Heading 1
- ## Heading 2
- ### Heading 3
```

Or use the "auto heading" feature where block hierarchy determines heading level.

#### Code Blocks

````markdown
- ```python
  def hello():
      print("Hello, Logseq!")
  ```
````

- Syntax highlighting is supported for many languages.
- In the DB version, code blocks have the `#Code` tag and can be created with the `/Code block` command or by typing three backticks.

#### Math / LaTeX

Inline LaTeX:
```markdown
$$E = mc^2$$
```

Block-level LaTeX (using `/Math block` command or dedicated block):
```markdown
$$
\int_{-\infty}^{\infty} e^{-x^2} dx = \sqrt{\pi}
$$
```

- In the DB version, math blocks have the `#Math` tag.

#### Tables

Markdown tables are supported:

```markdown
| Column 1 | Column 2 | Column 3 |
|----------|----------|----------|
| Cell 1   | Cell 2   | Cell 3   |
| Cell 4   | Cell 5   | Cell 6   |
```

#### Quotes

```markdown
- > This is a blockquote
```

Or use the `/Quote` command. In the DB version, quotes have the `#Quote` tag.

#### Hiccup (advanced HTML-in-blocks)

Logseq supports Hiccup syntax for complex HTML structures:

```markdown
[:p "Hello " [:em "World!"]]
```

### 3.4 Slash Commands

Type `/` in any block to access the command palette. Key commands include:

| Command | Action |
|---------|--------|
| `/TODO` | Add TODO marker |
| `/DOING` | Add DOING marker |
| `/DONE` | Add DONE marker |
| `/LATER` | Add LATER marker |
| `/NOW` | Add NOW marker |
| `/A`, `/B`, `/C` | Set priority |
| `/Deadline` | Set deadline date |
| `/Scheduled` | Set scheduled date |
| `/Template` | Insert a template |
| `/Page embed` | Embed entire page |
| `/Block embed` | Embed a block |
| `/Code block` | Insert code block |
| `/Math block` | Insert LaTeX math block |
| `/Quote` | Insert blockquote |
| `/Query` | Create a simple query |
| `/Advanced Query` | Create a Datalog query |
| `/Date picker` | Insert a date reference |
| `/Calculator` | Inline calculator |
| `/Upload an image` | Attach an image |
| `/Draw` | Open Excalidraw |

### 3.5 Autocomplete

- Type `[[` to trigger **page autocomplete** (search all pages).
- Type `((` to trigger **block reference autocomplete** (search all blocks).
- Type `#` to trigger **tag autocomplete**.
- Type `::` to trigger **property name autocomplete** (suggests existing property names).
- After a property name, autocomplete suggests **property values** previously used with that property.

---

## 4. Linking System

### 4.1 Page Links (Wikilinks)

```markdown
- I need to work on [[Project Planning]] tomorrow
- See also [[Meeting Notes/2024-01-15]]
```

- **Syntax**: `[[page name]]`
- Creates the page if it doesn't exist (on first click).
- Page names are case-insensitive for matching but preserve display case.

#### Page Reference with Label

```markdown
[custom display text]([[page name]])
```

### 4.2 Block References

```markdown
- Refer to this specific idea: ((6489a1b2-3c4d-5e6f-7890-abcdef123456))
```

- **Syntax**: `((block-uuid))`
- Renders the referenced block content inline.
- Click to navigate to the source block.

### 4.3 Tags

```markdown
- This idea is about #productivity and #workflow
- This relates to #[[multi word tag]]
```

- **Syntax**: `#tag` or `#[[multi word tag]]`
- Tags are functionally equivalent to page links -- `#productivity` creates/links to the page `productivity`.
- Tags appear in the backlinks of the target page.

### 4.4 External Links

Standard Markdown links:

```markdown
[Logseq Website](https://logseq.com)
```

Image links:

```markdown
![alt text](https://example.com/image.png)
![local image](../assets/screenshot.png)
```

### 4.5 Backlinks Panel (Linked + Unlinked References)

Every page has a **backlinks panel** at the bottom with two sections:

1. **Linked References**: All blocks across the graph that explicitly link to this page via `[[page]]`, `#tag`, or properties containing the page reference. Results are grouped by source page.

2. **Unlinked References**: All blocks that mention the page name as plain text (without `[[]]` or `#`). You can click to convert any unlinked reference into a linked one.

- Both sections support **filtering** to narrow results.
- In the DB version, both sections display in configurable **Views** (Table, List, or Gallery).

### 4.6 Page Embeds

Embed an entire page's content within a block:

```markdown
{{embed [[page name]]}}
```

- The embedded page is rendered in-place and is **editable**.

---

## 5. Properties

### 5.1 Built-in Properties

These are reserved property names that control Logseq functionality:

| Property | Scope | Description |
|----------|-------|-------------|
| `tags` | page/block | Associates tags; creates "Pages tagged with X" section |
| `alias` | page | Defines synonym names for the page |
| `title` | page | Overrides display title (different from file name) |
| `icon` | page | Sets a page icon (emoji identifier) |
| `template` | page/block | Designates a block/page as a template |
| `template-including-parent` | block | Whether to include parent content in template |
| `public` | page | Whether page is included in published export (boolean) |
| `exclude-from-graph-view` | page | Excludes page from graph visualization |
| `filters` | page | Stores selected filters for linked references |
| `collapsed` | block | Whether block is collapsed (hidden) |
| `id` | block | Block's UUID |
| `created-at` | block | Timestamp of creation (Unix time) |
| `updated-at` | block | Timestamp of last update (Unix time) |
| `query-table` | block | Show query results as table |
| `query-properties` | block | Which properties to show in query table |
| `query-sort-by` | block | Property to sort query table by |
| `query-sort-desc` | block | Sort direction (boolean) |

### 5.2 Custom Properties

Any `key:: value` pair that isn't a built-in property is a custom user property:

```markdown
- Read "Thinking, Fast and Slow"
  type:: book
  author:: [[Daniel Kahneman]]
  rating:: 9
  status:: reading
  started:: [[2024-01-10]]
```

- Custom properties can have **any valid name**.
- Values can be plain text, numbers, page references, tags, or links.
- Property names get their own pages (configurable via `:property-pages/enabled?`).

### 5.3 Property Value Rules

- `tags` and `alias` treat **comma-separated values** as multiple page references:
  ```
  tags:: fiction, sci-fi, favorite
  ```
  Each value (`fiction`, `sci-fi`, `favorite`) becomes a page reference.

- You can enable comma-separation for custom properties in `config.edn`:
  ```clojure
  :property/separated-by-commas #{:genres :categories}
  ```

- To suppress page-reference behavior entirely for a property:
  ```clojure
  :ignored-page-references-keywords #{:description :notes}
  ```

### 5.4 Property Types (DB Version)

In the DB version, properties have explicit types:

| Type | Description | Example |
|------|-------------|---------|
| `Text` | Any text, supports references and child blocks | `"A note about..."` |
| `Number` | Numeric values (integers, floats, negatives) | `42`, `3.14` |
| `Date` | Date with date picker, links to journal page | `2024-01-15` |
| `DateTime` | Date and time with picker | `2024-01-15 14:30` |
| `Checkbox` | Boolean toggle | `true`/`false` |
| `Url` | URLs only | `https://logseq.com` |
| `Node` | Links to other pages/blocks, optionally filtered by tag | `[[Person/Alice]]` |

### 5.5 Property-Based Queries

Properties are a primary axis for querying. See [Section 7](#7-query-system) for full details.

Simple query example:
```
{{query (property type book)}}
```

---

## 6. Tags

### 6.1 Syntax

```markdown
- This block has #simple-tag and #[[multi word tag]]
```

- `#tagname` -- single-word tag
- `#[[tag name]]` -- multi-word tag

### 6.2 Tags as Pages

In Logseq, **tags ARE pages**. Writing `#productivity` is functionally identical to `[[productivity]]`:

- Both create the `productivity` page if it doesn't exist.
- Both create a backlink from the current block to that page.
- The `productivity` page shows all tagged/linked blocks in its Linked References.

### 6.3 Tag Hierarchy (DB Version "New Tags")

In the DB version, tags (called "New Tags" or "classes") gain powerful features:

- **Tag properties**: Define properties that auto-apply to every tagged node:
  ```
  Create #Person tag -> add properties: lastName, birthday
  Tag any block with #Person -> it automatically gets lastName and birthday fields
  ```
- **Parent tags** via `Extends` property: `#Audiobook extends #Book, #MediaObject`
  - Child tags inherit all parent tag properties.
- **Tag-based pages**: Each tag has a dedicated page showing all tagged nodes in table/list/gallery view.
- **Tag creation**: Type `#Name` in any block and press Enter, or create via Search.

### 6.4 Filtering by Tags

- Use the **filter** in linked references to show/hide blocks by tag.
- Use simple queries: `{{query #tagname}}`
- Use advanced queries with the `page-tags` filter:
  ```
  {{query (page-tags programming)}}
  ```

---

## 7. Query System

Logseq has two query tiers: **Simple Queries** and **Advanced (Datalog) Queries**.

### 7.1 Simple Queries

**Syntax**: `{{query <expression>}}`

You can type `/query` to create one. Simple queries use a Lisp-like DSL:

#### Basic Examples

```markdown
{{query [[project-alpha]]}}

{{query (and [[meeting]] [[2024]])}}

{{query (or [[design]] [[frontend]])}}

{{query (and [[todo]] (not [[completed]]))}}
```

#### Query Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `and` | All conditions must match | `(and [[page1]] [[page2]])` |
| `or` | Any condition can match | `(or [[page1]] [[page2]])` |
| `not` | Exclude matches | `(not [[page1]])` |

#### Query Filters

| Filter | Description | Example |
|--------|-------------|---------|
| `between` | Date range (journal blocks) | `(between -7d today)`, `(between -2w today)` |
| `page` | Match specific page | `(page "term/alias")` |
| `property` | Match block property value | `(property type book)` |
| `task` / `todo` | Match task markers | `(task now later)`, `(task todo doing)` |
| `priority` | Match priority level | `(priority a)`, `(priority a b)` |
| `page-property` | Match page-level properties | `(page-property type "Feature")` |
| `page-tags` | Match pages by their tags | `(page-tags programming)` |
| `all-page-tags` | List all tags used across pages | `(all-page-tags)` |
| `sort-by` | Sort results | `(sort-by created-at desc)` |

#### Date Symbols for `between`

- `today`, `yesterday`, `tomorrow`, `now`
- Relative: `+7d`, `-7d`, `+2w`, `-2w`, `+1m`, `-1m`, `+1y`, `-1y`

#### Combined Examples

```markdown
{{query (and (task now later) (sort-by created-at desc))}}

{{query (and [[tag1]] (not [[tag2]]))}}

{{query (between [[Dec 5th, 2020]] [[Dec 7th, 2020]])}}

{{query (and (task todo doing) (priority a))}}
```

### 7.2 Advanced Queries (Datalog)

Advanced queries use **Datalog** to query the **Datascript** in-memory database. They are powerful but have a steeper learning curve.

**Shape of an advanced query:**

```clojure
#+BEGIN_QUERY
{:title "Your query title"
 :query [:find (pull ?b [*])
         :where ...]
 :inputs [...]
 :view (fn [query-result] [:div ...])
 :result-transform (fn [query-result] ...)
 :collapsed? true
 :group-by-page? true
 :remove-block-children? true
 :rules [...]}
#+END_QUERY
```

| Key | Description | Required |
|-----|-------------|----------|
| `:title` | Display title (string or hiccup) | No |
| `:query` | Datascript query or simple query | **Yes** |
| `:inputs` | Query parameters | No |
| `:view` | Custom render function (hiccup) | No |
| `:result-transform` | Transform results before display | No |
| `:collapsed?` | Collapse results by default | No |
| `:group-by-page?` | Group by source page | No |
| `:remove-block-children?` | Deduplicate child blocks | No |
| `:rules` | Custom Datalog rules | No |

#### Special Query Inputs

| Input | Description |
|-------|-------------|
| `:current-page` | Current page name (lowercase) |
| `:query-page` | Page where query is defined |
| `:current-block` | Current block's `:db/id` |
| `:parent-block` | Parent block's `:db/id` |
| `:today` | Today's journal date |
| `:yesterday` | Yesterday's date |
| `:tomorrow` | Tomorrow's date |
| `:-7d` | 7 days ago |
| `:+7d` | 7 days from now |
| `:-2w` | 2 weeks ago |
| `:+1m` | 1 month from now |

#### Example: All TODO Tasks

```clojure
#+BEGIN_QUERY
{:title "All TODO tasks"
 :query [:find (pull ?b [*])
         :where (task ?b #{"TODO"})]}
#+END_QUERY
```

#### Example: Tasks with a Specific Tag

```clojure
#+BEGIN_QUERY
{:title "All blocks tagged 'project'"
 :query [:find (pull ?b [*])
         :where
         [?p :block/name "project"]
         [?b :block/refs ?p]]}
#+END_QUERY
```

#### Example: Journal Blocks from Last 7 Days with Page Reference

```clojure
#+BEGIN_QUERY
{:title "Last 7 days with 'datalog' reference"
 :query [:find (pull ?b [*])
         :in $ ?start ?today ?tag
         :where
         (between ?b ?start ?today)
         (page-ref ?b ?tag)]
 :inputs [:-7d :today "datalog"]}
#+END_QUERY
```

#### Example: Next 7 Days' Deadlines

```clojure
#+BEGIN_QUERY
{:title "Next 7 days deadline or schedule"
 :query [:find (pull ?block [*])
         :in $ ?start ?next
         :where
         (or [?block :block/scheduled ?d]
             [?block :block/deadline ?d])
         [(> ?d ?start)]
         [(< ?d ?next)]]
 :inputs [:today :+7d]
 :collapsed? false}
#+END_QUERY
```

#### Example: Custom View with Tags List

```clojure
#+BEGIN_QUERY
{:title "All page tags"
 :query [:find ?tag-name
         :where [?tag :block/name ?tag-name]]
 :view (fn [tags]
         [:div (for [tag (flatten tags)]
                 [:a.tag.mr-1
                  {:href (str "#/page/" tag)}
                  (str "#" tag)])])}
#+END_QUERY
```

#### Example: Query Using Simple Query Syntax Inside Advanced Shape

```clojure
#+BEGIN_QUERY
{:title "DOING tasks with priority A"
 :query (and (todo DOING) (priority A))
 :collapsed? true}
#+END_QUERY
```

### 7.3 Query Result Views

- **List view** (default): blocks grouped by page, shown as outliner.
- **Table view**: enable with `query-table:: true` property on the query block; choose columns with `query-properties::`.
- In the DB version, query results are displayed in configurable **Views** (Table, List, Gallery) with sorting, filtering, and column management.

---

## 8. Task Management

### 8.1 Task Markers (File Graph)

Logseq supports two built-in task workflows (toggle in Settings):

**Workflow 1 (default):** `LATER` -> `NOW` -> `DONE`
**Workflow 2:** `TODO` -> `DOING` -> `DONE`

Additional markers: `WAITING`, `WAIT`, `CANCELLED`, `CANCELED`, `IN-PROGRESS`

```markdown
- TODO Buy groceries
- DOING Write the report
- DONE Submit the form
- LATER Read the research paper
- NOW Fix the critical bug
- WAITING Approval from manager
- CANCELLED Old task no longer needed
```

- Toggle task state: `Ctrl+Enter` (cycles through the active workflow markers).
- Set marker via slash command: `/TODO`, `/DOING`, `/DONE`, `/LATER`, `/NOW`.

### 8.2 Task Markers (DB Version)

In the DB version, tasks are blocks tagged with `#Task` and use the `Status` property with these default choices:

- `Backlog`
- `Todo`
- `Doing`
- `In Review`
- `Done`
- `Canceled`

Status choices are **customizable** (add new ones, rename/re-icon built-in ones).

Cycle through `Todo` -> `Doing` -> `Done` with `Cmd+Enter`.

### 8.3 Priority

```markdown
- TODO [#A] Critical bug fix
- LATER [#B] Feature implementation
- TODO [#C] Nice-to-have improvement
```

- Three levels: `[#A]` (highest), `[#B]` (medium), `[#C]` (lowest).
- Set via slash commands: `/A`, `/B`, `/C`.
- In the DB version, priority is a `Priority` property on `#Task` nodes, set via `p p` shortcut.

### 8.4 Scheduled & Deadline Dates

```markdown
- TODO Submit tax return
  SCHEDULED: <2024-04-01 Mon>

- TODO Finish project proposal
  DEADLINE: <2024-03-15 Fri>
```

- Set via `/Scheduled` and `/Deadline` slash commands.
- Dates open a **date picker** UI.
- Blocks with upcoming deadlines/schedules appear on journal pages (configurable via `:scheduled/future-days` in `config.edn`).
- In the DB version: `Scheduled` and `Deadline` are typed properties on `#Task`, set via `/Scheduled`, `/Deadline`, or shortcut `p d`.

### 8.5 Repeating Tasks

```markdown
- TODO Daily exercise
  SCHEDULED: <2024-01-15 Mon 07:00 .+1d>
```

Repeater kinds:
- `.+` -- repeats from when you last marked it done
- `++` -- keeps the same day-of-week
- `+` -- repeats from the original schedule date

In the DB version, enable "Repeat task" in the date picker with customizable intervals (Minute to Year).

### 8.6 Task Queries

Find all active tasks:
```
{{query (task todo doing now later)}}
```

Find high-priority tasks:
```
{{query (and (task todo) (priority a))}}
```

Find tasks from the last 2 weeks:
```
{{query (and (task now doing) (between -2w today))}}
```

### 8.7 Time Tracking

Logseq tracks time spent on tasks automatically:
- When a task status changes (e.g., TODO -> DOING -> DONE), timestamps are recorded.
- The time tracker shows elapsed time on blocks.
- Toggle via Settings > Enable Timetracking.

---

## 9. Daily Journal

### 9.1 Auto-Created Daily Pages

- Logseq **automatically creates a journal page** for the current date when you open the app.
- Journal pages are named by date (e.g., `Jan 15th, 2024` or configured date format).
- The **Journals view** (default home) shows today's journal (and optionally recent journals).
- In the DB version, journal pages have the `#Journal` tag.

### 9.2 Journal-Centric Workflow

Logseq's recommended workflow is "journal-first":

1. Open app -> land on today's journal page.
2. Write thoughts, notes, tasks as blocks.
3. Link to topic pages with `[[wikilinks]]` or `#tags`.
4. Topic pages accumulate backlinks automatically.

This means you rarely need to decide "where" to put something -- just write on today's page and link.

### 9.3 Date Navigation

- Navigate between journal days: `g n` (next day), `g p` (previous day).
- Reference dates with natural language in `[[]]`:
  - `[[Today]]`, `[[Yesterday]]`, `[[Tomorrow]]`
  - `[[This Friday]]`, `[[Last Monday]]`, `[[Next Wednesday]]`
- Use the `/Date picker` command for calendar-based date selection.
- The date picker supports natural language input (e.g., `next week`, `5 days ago`).

### 9.4 Scheduled/Deadline Items on Journals

Journal pages automatically display upcoming scheduled/deadline items, providing an agenda-like view without needing a separate query.

---

## 10. Sync & Storage

### 10.1 Local-First, Flat Files

- **Each page = one file** on disk (`.md` for Markdown, `.org` for Org-mode).
- Files live in a user-chosen directory (the "graph folder").
- Directory structure:
  ```
  my-graph/
  ├── pages/           # Regular pages
  │   ├── Project Planning.md
  │   └── Meeting Notes.md
  ├── journals/        # Journal pages
  │   ├── 2024_01_15.md
  │   └── 2024_01_16.md
  ├── assets/          # Images, PDFs, attachments
  ├── logseq/
  │   ├── config.edn   # Graph configuration
  │   ├── custom.css   # Custom styles
  │   └── custom.js    # Custom scripts
  └── draws/           # Excalidraw files
  ```
- You own your data -- everything is plain text files you can read, edit, and version-control.

### 10.2 Logseq Sync (Paid)

- **Logseq Sync** is a paid cloud service for syncing graphs across devices.
- In the file-graph version, it syncs the flat files.
- In the DB version, it uses **RTC (Real-Time Collaboration)** -- Google-Docs-style live sync between users. Currently invite-only alpha.
- Requires setting up an encryption password.

### 10.3 Git-Based Sync

Many users sync via Git (the community-preferred free method):

- Initialize a git repo in your graph folder.
- Use auto-commit plugins or scripts to commit changes.
- Push/pull to GitHub, GitLab, or any remote.
- Logseq has built-in (optional) git auto-commit.
- Caveat: merge conflicts are possible with concurrent edits.

### 10.4 Other Sync Methods

- **iCloud / Dropbox / OneDrive**: Works since files are plain text, but file-locking issues can occur.
- **Syncthing**: Peer-to-peer sync; popular in the community for avoiding cloud dependency.

### 10.5 Conflict Handling

- File-based: Logseq detects file changes on disk and reloads. If conflicts occur during sync (Git, cloud), standard file conflict resolution applies.
- DB version: RTC handles conflicts at the operation level (CRDT-style).

---

## 11. Import / Export

### 11.1 Markdown Export

- **Export graph as Markdown**: Three-dots menu > Export > standard Markdown.
- The DB version supports `Export as standard Markdown (no block properties)`.
- Published graphs produce static HTML SPAs.

### 11.2 OPML

- Logseq can export outliner structure as OPML (common outliner interchange format).

### 11.3 EDN / JSON

**EDN (Extensible Data Notation):**
- The DB version supports granular EDN export:
  - `Export block EDN data` -- single block to clipboard
  - `Export page EDN data` -- single page to clipboard
  - `Export graph's tags and properties EDN data` -- schema/workflow sharing
  - `Import EDN data` -- import any of the above
  - `Export EDN file` -- full graph export
  - `EDN to DB graph` -- full graph import
- File graph stores internal state in EDN (in Datascript).

**JSON:**
- Block and page data is accessible as JSON through the plugin API and developer tools.

### 11.4 SQLite (DB Version)

- `Export SQLite DB` -- export as `.db` file
- `Export both SQLite DB and assets` -- export as `.zip`
- Import via `SQLite` import option.

### 11.5 Import from Other Tools

- **Roam Research**: Logseq can open Roam JSON exports (largely compatible syntax: `[[wikilinks]]`, `((block refs))`, `{{queries}}`).
- **Notion**: Import Notion Markdown exports (may need manual cleanup of property formatting).
- **File Graph to DB Graph**: Built-in importer converts Markdown file graphs to DB graphs, handling task status remapping (e.g., `LATER` -> `Todo`, `NOW` -> `Doing`, `WAITING` -> `Backlog`), property type detection, tag conversion, and asset migration.
- **OPML import**: For outliner data from other tools.

### 11.6 Publishing

- Export public pages as a **static HTML SPA** (single-page application).
- Controlled by the `public:: true/false` page property.
- Can be automated with [logseq/publish-spa](https://github.com/logseq/publish-spa) GitHub Action.
- Published app routes: `/#/page/:NAME` for pages, `/#/page/:BLOCK-ID` for referenced blocks.

---

## 12. Templates

### 12.1 Creating Templates (File Graph)

Define a template by adding the `template::` property to a block:

```markdown
- Meeting Notes Template
  template:: meeting-notes
  template-including-parent:: false
  - **Date:** <%today%>
  - **Attendees:**
  - **Agenda:**
    -
  - **Action Items:**
    - TODO
  - **Notes:**
    -
```

Alternatively, right-click a block's bullet > **"Make template"** and give it a name.

### 12.2 Creating Templates (DB Version)

In the DB version, templates are blocks tagged with `#Template`:

- Write the template name in a block and tag it with `#Template`.
- Add child blocks as the template body.
- Optional `Apply template to tags` property: auto-applies the template whenever a tagged node is created (e.g., apply a journal template to every `#Journal` page).

### 12.3 Inserting Templates

- Type `/Template` in any block.
- Select the template name from the dropdown.
- The template's child blocks are copied into the current location.

### 12.4 Dynamic Variables

Templates support dynamic variables that resolve at insertion time:

| Variable | Resolves To | Example Output |
|----------|-------------|----------------|
| `<%today%>` | Today's journal page link | `[[Jan 15th, 2024]]` |
| `<%yesterday%>` | Yesterday's journal link | `[[Jan 14th, 2024]]` |
| `<%tomorrow%>` | Tomorrow's journal link | `[[Jan 16th, 2024]]` |
| `<%time%>` | Current time | `14:30` |
| `<%current page%>` | Current page link | `[[Project Planning]]` |
| Natural language dates | Parsed date | `<%Last Friday%>` -> `[[Jan 12th, 2024]]` |

Natural language date parsing uses the [chrono](https://github.com/wanasit/chrono) library and supports expressions like:
- `Last Friday`, `Next Monday`, `5 days ago`, `2 weeks from now`
- `17 August 2013`, `Sat Aug 17 2013`

### 12.5 The `template-including-parent` Property

Controls whether the template block itself (the parent) is included when inserting:

```markdown
- I AM included by default
  template:: example-1
  - child line 1
  - child line 2

- I am NOT included because of the setting
  template:: example-2
  template-including-parent:: false
  - child line 1
  - child line 2
```

---

## 13. Additional Features (Noted, Not Deep-Dived)

These features exist in Logseq but are not the focus of this inventory:

### Flashcards / Spaced Repetition
- Tag blocks with `#card` (file graph) or `#Card` (DB version) to create flashcards.
- Built-in spaced repetition review system accessible from the sidebar.
- DB version uses a new SRS algorithm with a `Due` property for scheduling.
- Rate cards on 4 levels during review.

### Whiteboard
- Infinite canvas for visual thinking (Excalidraw-based).
- Can embed blocks, pages, and draw freeform.
- Access via the left sidebar or `/Draw` command.

### Graph View
- Visual network visualization of all pages and their connections.
- Global graph view shows entire knowledge base; local graph view shows connections for a single page.
- Pages can be excluded with `exclude-from-graph-view:: true`.

### Plugin / Extension System
- JavaScript Plugin API for extending functionality.
- Plugin marketplace with 300+ community plugins.
- Themes are distributed as plugins.
- API documentation at [plugins-doc.logseq.com](https://plugins-doc.logseq.com/).
- DB version has 20+ compatible plugins; CLJS SDK also available.
- Desktop only (plugins don't work in the mobile app or published web app).

---

## Appendix A: File Graph vs. DB Graph Quick Reference

| Aspect | File Graph (Stable) | DB Graph (Beta) |
|--------|-------------------|-----------------|
| Storage | Flat `.md`/`.org` files | SQLite database |
| Properties | `key:: value` text in blocks | Typed properties (Text, Number, Date, etc.) |
| Tags | `#tag` = page link | `#Tag` = "New Tag" (class) with inheritance |
| Tasks | `TODO`/`DOING`/`DONE` markers | `#Task` tag + `Status` property |
| Templates | `template:: name` property | `#Template` tag |
| Queries | Simple + Datalog | Simple + Query Builder + Datalog |
| Sync | Git / Logseq Sync / cloud folders | RTC (real-time collab) / Logseq Sync |
| Export | Markdown, OPML, HTML | Markdown, SQLite, EDN, HTML |
| Views | List + table (query) | Table, List, Gallery (everywhere) |
| Mobile | Existing app | New native app (iOS alpha) |

## Appendix B: Key Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Enter` | Cycle task status |
| `Ctrl+Shift+R` | Copy block reference |
| `Tab` / `Shift+Tab` | Indent / Outdent |
| `Alt+Shift+Up/Down` | Move block up/down |
| `Ctrl+Up/Down` | Collapse / Expand |
| `Alt+Right/Left` | Zoom in / Zoom out |
| `Ctrl+K` | Search / Quick find |
| `/` | Slash commands |
| `[[` | Page link autocomplete |
| `((` | Block reference autocomplete |
| `g n` / `g p` | Next / Previous journal day |
| `Cmd+;` | Toggle block properties visibility |
| `p s` | Set task status (DB version) |
| `p p` | Set task priority (DB version) |
| `p d` | Set deadline (DB version) |
| `p t` | Add/remove tag (DB version) |
| `Cmd+Shift+P` | Search commands (DB version) |
