# Logseq Workflows: How Users Actually Use It Day-to-Day

Logseq is an open-source, privacy-first outliner that combines a text editor, an outliner, and a bi-directional linking tool into what its community calls an "Integrated Thinking Environment" (ITE). Unlike traditional note-taking apps built around files and folders, Logseq is fundamentally **block-centric** and **journal-first**: every piece of information is a block (a bullet point), and most information flows through a daily journal page before being linked elsewhere.

This document covers the major workflows Logseq enables and how its community actually uses them.

---

## Table of Contents

1. [The Logseq Philosophy](#the-logseq-philosophy)
2. [Daily Journaling](#1-daily-journaling)
3. [Task Management / GTD](#2-task-management--gtd)
4. [Zettelkasten / Knowledge Management](#3-zettelkasten--knowledge-management)
5. [Meeting Notes](#4-meeting-notes)
6. [Research & Reading Notes](#5-research--reading-notes)
7. [Project Management](#6-project-management)
8. [Weekly/Monthly Reviews](#7-weeklymonthly-reviews)
9. [Personal Knowledge Base](#8-personal-knowledge-base)
10. [Key User Patterns & Why People Choose Logseq](#9-key-user-patterns--why-people-choose-logseq)

---

## The Logseq Philosophy

Before diving into specific workflows, it's essential to understand the three principles that shape how every workflow works in Logseq:

### "Block-First" Thinking vs Page-First

In most note-taking apps (Apple Notes, Notion, even Obsidian), you think in **pages/documents**: "I need to create a note about X." In Logseq, you think in **blocks**: "I have a thought. I'll write it as a block and link it."

Every piece of information in Logseq lives as a **block** -- a bullet point. Pages are just named collections of blocks. A page doesn't even need its own content -- it can exist purely as a **hub** that collects backlinks from blocks scattered across the graph. This is the fundamental insight: *the smallest unit of information is a block, not a page*.

In the words of the Logseq blog: "Pages are nothing more than collections of blocks. If you're familiar with Roam Research, you'll immediately grok how blocks work in Logseq." ([Source: Logseq Getting Started Guide](https://blog.logseq.com/how-to-get-started-with-networked-thinking-and-logseq/))

### Friction-Free Capture: "Just Type in the Journal"

Logseq removes the #1 barrier to note-taking: deciding where to put things. The official guidance is remarkable in its simplicity:

> "99% of your information should first be entered on the Journals page."

Instead of choosing a notebook, section, or folder, you just type on today's journal page. The information is automatically timestamped and can be linked to any number of topics. This eliminates what the community calls "organization anxiety" -- the paralysis of deciding where something belongs before you've even captured it.

| Traditional Tool | Logseq |
|---|---|
| Open app -> Which notebook? -> Which section? -> Write | Open app -> Type on journal -> Add a `[[link]]` |
| "I'll file this later" (never does) | Already filed by date, linked to topics |
| Context switch to find the right file | Stay in journal; links do the organizing |

### Emergent Structure Through Linking

Logseq users don't plan their information architecture upfront. Instead, structure emerges organically:

1. **Week 1**: Just write in the journal, occasionally adding `[[links]]`.
2. **Month 1**: Some pages accumulate many backlinks. These become natural topic hubs.
3. **Month 3**: Create Maps of Content (MOC) pages to curate the most important hubs.
4. **Month 6**: Add namespaces for areas that benefit from hierarchy.
5. **Year 1**: Rich, organic structure that mirrors your actual thinking patterns.

As the Logseq blog puts it: "In a networked thinking tool like Logseq, structure tends to *emerge* instead of being imposed."

---

## 1. Daily Journaling

The daily journal is the beating heart of Logseq. It's the single most important feature that distinguishes Logseq's workflow from traditional tools.

### Features That Enable It

- **Auto-created daily page**: Every day at midnight, Logseq creates a new journal page with today's date as the title (e.g., `Dec 25th, 2024`).
- **Scrollable history**: The Journals view shows today at the top with past entries stacked below, so you can scroll back through recent days.
- **Configurable date format**: Set via `:journal/page-title-format` in `config.edn` (e.g., `"MMM do, yyyy"`, `"yyyy-MM-dd"`).
- **Default templates**: A recurring template can auto-populate each new journal page.

### Typical User Pattern

The Logseq user's day starts like this:

```
1. Open Logseq -> lands on today's journal page (auto-created)
2. Start typing immediately (no page creation or navigation needed)
3. Add thoughts, TODOs, meeting notes, ideas as blocks
4. Tag blocks with [[page links]] to connect them to topics
5. Those linked pages accumulate backlinks over time
```

### Example Syntax: Quick Capture to Journal

```markdown
- Had an idea about [[Project Alpha]] redesign
  - Maybe we should use a component-based architecture
  - Related to what [[Sarah]] mentioned last week
- TODO Buy groceries
  SCHEDULED: <2024-12-26 Thu>
- Read an interesting article about [[machine learning]]
  - Key insight: transformers work because of attention mechanism
  - Reminds me of ((block-ref-to-previous-note))
```

### Example: Automated Daily Template

Users configure a recurring template in `config.edn`:

```clojure
;; In config.edn
:default-templates
  {:journals "daily"}
```

The template (defined on a `[[templates]]` page) might look like:

```markdown
- ## Morning Routine
  - Gratitude::
  - Intention for today::
- ## Tasks
  - {{query (and (todo TODO DOING) (not (page "templates")))}}
- ## Notes
  -
- ## End of Day
  - What went well::
  - What to improve::
```

The Logseq blog describes how to set this up: "Templates are the best way to easily structure and link your notes in Logseq. Not only do templates provide structure, having consistent links means that you can more reliably find your notes using queries." ([Source](https://blog.logseq.com/how-to-set-up-an-automated-daily-template-in-logseq/))

Plugins extend this further: the **Logseq Habit Tracker** visualizes habit completion from daily tags, the **Property Visualizer** tracks numerical goals, and **Full House Templates** enable dynamic templates with JavaScript logic (e.g., "include a monthly review task only on the last day of the month").

### Reviewing Past Entries

- **Scrolling**: Simply scroll down the Journals view.
- **Search**: `Cmd+K` / `Ctrl+K` and type a date to jump to any journal page.
- **Linked References**: Click any `[[page link]]` to see all journal entries that reference that page -- creating a timeline of thoughts on any topic.
- **"On This Day" queries**: Advanced users write Datalog queries surfacing entries from exactly one year ago.
- **Between queries**: `{{query (and (between -7d today) [[topic]])}}` scopes to recent entries.

### What Logseq Does Well (and Not) for Journaling

**Strengths**:
- Zero-friction daily capture -- no page creation, no navigation
- Automatic timestamps by journal date
- Backlinks turn journal entries into a searchable knowledge base
- Templates + plugins (habit tracker, property visualizer) add structure without rigidity

**Weaknesses**:
- Long-form prose writing is awkward in an outliner (every paragraph is a bullet)
- No built-in "focus mode" for distraction-free writing (requires CSS hacks or plugins)
- Mobile app is functional but slower than dedicated journaling apps
- Scrolling through many days of entries can feel heavy; no calendar view built-in

---

## 2. Task Management / GTD

Logseq has a built-in task management system inspired by Org-mode. Tasks are simply blocks with special keyword markers prepended.

### Features That Enable It

- **Task markers**: `TODO`, `DOING`, `DONE`, `CANCELLED` (or `NOW`/`LATER` in the Org-mode workflow)
- **Priority levels**: `[#A]`, `[#B]`, `[#C]` (Org-mode style)
- **SCHEDULED and DEADLINE dates**: Full date scheduling with timestamp syntax
- **Simple queries**: Live-updating embedded queries to surface tasks
- **Advanced Datalog queries**: Complex filtering, sorting, and aggregation
- **Two workflow modes**: Configurable in Settings > Editor

### Task Marker Reference

**Workflow 1: TODO/DOING (default)**

| Marker | Meaning |
|---|---|
| `TODO` | Task not yet started |
| `DOING` | Task in progress |
| `DONE` | Task completed |
| `CANCELLED` | Task abandoned |

**Workflow 2: NOW/LATER (Org-mode inspired)**

| Marker | Meaning |
|---|---|
| `NOW` | Active task (= DOING) |
| `LATER` | Deferred task (= TODO) |
| `DONE` | Completed |
| `CANCELLED` | Abandoned |

Custom markers like `WAITING` or `IN-REVIEW` can be added via `config.edn`.

### Typical User Pattern: GTD in Logseq

1. **Capture**: Dump everything into the daily journal with `TODO` markers.
2. **Clarify**: Review journal TODOs, add context via links (`[[project]]`, `[[context/@phone]]`).
3. **Organize**: Use properties and tags to categorize:
   ```markdown
   - TODO Call vendor about pricing
     type:: action
     context:: [[context/@phone]]
     project:: [[Project/Office Renovation]]
   ```
4. **Review**: Weekly review page with queries surfacing all open tasks (see [Reviews](#7-weeklymonthly-reviews)).
5. **Engage**: A "Dashboard" page with queries for `NOW`/`DOING` tasks.

### Example Syntax

```markdown
- TODO Write the quarterly report
- DOING Review pull request #42
- TODO [#A] Fix critical production bug
  SCHEDULED: <2024-12-27 Fri>
  DEADLINE: <2024-12-31 Tue>
- TODO [#C] Organize desktop files
- DONE Send invoice to client
```

**Keyboard shortcuts**:
- `Cmd+Enter` / `Ctrl+Enter` toggles the TODO/DONE cycle
- Typing `TODO ` at the start of a block creates a task
- `/TODO` from the slash command menu

### Task Queries: Building Dashboards

**Simple queries** (no programming needed):

```markdown
{{query (todo TODO)}}
{{query (todo DOING)}}
{{query (and (todo TODO) (priority A))}}
{{query (and (todo TODO DOING) (page [[Project Alpha]]))}}
{{query (and (todo TODO) (between -7d today))}}
```

**Advanced Datalog queries** for complex filtering:

```clojure
#+BEGIN_QUERY
{:title "Today's Focus"
 :query [:find (pull ?b [*])
         :in $ ?today
         :where
           (or
             [?b :block/marker "DOING"]
             [?b :block/marker "NOW"]
             (and
               [?b :block/scheduled ?d]
               [(<= ?d ?today)]
               [?b :block/marker ?m]
               [(contains? #{"TODO" "LATER"} ?m)]))
           ]
 :inputs [:today]
 :result-transform (fn [result]
                     (sort-by (fn [h]
                       (get h :block/priority "Z")) result))
 :collapsed? false}
#+END_QUERY
```

```clojure
#+BEGIN_QUERY
{:title "Overdue Tasks"
 :query [:find (pull ?b [*])
         :in $ ?today
         :where
           [?b :block/marker ?m]
           [(contains? #{"TODO" "DOING" "NOW" "LATER"} ?m)]
           [?b :block/scheduled ?d]
           [(< ?d ?today)]]
 :inputs [:today]
 :breadcrumb-show? false
 :collapsed? false}
#+END_QUERY
```

### What Logseq Does Well (and Not) for Tasks

**Strengths**:
- Tasks are just blocks -- they live inline with your notes (meeting notes spawn action items naturally)
- Queries aggregate tasks from across the entire graph (no need to maintain a central task list)
- Org-mode scheduling/deadline syntax is powerful and proven
- Tags and properties enable GTD contexts (`@phone`, `@computer`, `@errands`)

**Weaknesses**:
- No built-in recurring tasks (requires plugins like **logseq-plugin-todo**)
- Datalog query syntax has a steep learning curve
- No native Kanban or calendar view (community plugins: **logseq-kanban-plugin**, **logseq-plugin-agenda**)
- No built-in reminders/notifications -- you must check your dashboard
- Task UX is text-based: no drag-to-reschedule, no timeline, no assignee management

---

## 3. Zettelkasten / Knowledge Management

Logseq is exceptionally well-suited for Zettelkasten because its block-level granularity is more atomic than page-level notes in most other tools.

### Features That Enable It

- **Blocks as atomic notes**: Each block is a self-contained unit with its own UUID
- **Block references**: `((block-uuid))` pulls a block's content inline
- **Block embeds**: `{{embed ((block-uuid))}}` shows a block and all its children, editable in-place
- **Bi-directional links**: Every `[[page link]]` creates a backlink on the target page
- **Linked References**: Auto-generated list of all blocks pointing to a page
- **Unlinked References**: Mentions of a page name that aren't yet linked (convertible with one click)
- **Graph view**: Visual network of all pages and their connections

### Typical User Pattern

1. **Write atomic thoughts as blocks** in the daily journal, tagged with concept links.
2. **Review backlinks** on concept pages -- they accumulate notes from many journal entries.
3. **Synthesize**: Drag blocks from the Linked References section onto the page, or write new synthesis blocks.
4. **Connect**: Add cross-references between concept pages.
5. **Explore**: Use the graph view to discover clusters and orphans.

### Example: Atomic Notes as Blocks

```markdown
- The spacing effect shows that learning is more effective when spread over time
  rather than crammed into a single session. This applies to both declarative
  and procedural knowledge. #[[spacing effect]] #[[learning science]]
```

This block is a standalone atomic idea. It can be:
- **Referenced** from anywhere: `((block-uuid))`
- **Embedded** in context: `{{embed ((block-uuid))}}`
- **Discovered** via the backlinks on `[[spacing effect]]` or `[[learning science]]`

### Three Levels of Linking

**1. Page links** (topic-level connections):
```markdown
- The [[spacing effect]] is related to [[interleaving]] in that both
  leverage the benefits of [[desirable difficulties]] for learning.
```

**2. Block references** (idea-level precision):
```markdown
- This supports my earlier point about memory consolidation ((64a7b3c2-...))
```

**3. Block embeds** (full content shown inline, editable):
```markdown
- {{embed ((64a7b3c2-...))}}
  - My additional commentary on this embedded block
```

### Backlink Discovery

Every page has a **Linked References** section at the bottom:

```
Page: [[spacing effect]]

Linked References:
  --------------------------------
  From journal Dec 20th, 2024:
    - The spacing effect shows that learning is more effective when...

  From page [[Study Techniques]]:
    - One of the most evidence-based techniques is the [[spacing effect]]

  From journal Nov 3rd, 2024:
    - Interesting paper on [[spacing effect]] in language learning...
  --------------------------------
```

As described in the Logseq blog: "By traversing your backlinks, you'll start to see patterns in your notes. This is the single most powerful feature that makes graph-based thinking possible."

Users treat Linked References as an **inbox**: visit a page, review accumulated backlinks, then synthesize by dragging blocks onto the page or writing new summary blocks.

**Unlinked References** show mentions of the page name in text that aren't explicitly linked -- you can convert these to proper links with one click, gradually strengthening your graph.

### Graph Exploration

The **graph view** visualizes pages as nodes and links as edges. Use it for:
- **Discovering clusters**: Densely connected groups reveal topic areas
- **Finding orphans**: Isolated nodes = notes that need connecting
- **Serendipity**: Seeing that two apparently unrelated topics share a common reference

### What Logseq Does Well (and Not) for Zettelkasten

**Strengths**:
- Block-level atomicity is more granular than page-level systems
- Backlinks + Linked References = automatic "see also" for every concept
- Embeds let you reuse the same atomic note in multiple contexts
- No forced hierarchy -- pure networked structure matches Zettelkasten philosophy

**Weaknesses**:
- Block references show as cryptic UUIDs in the raw Markdown files (portability concern)
- Graph view becomes noisy with many pages; limited filtering options
- No built-in "sequence" concept like Luhmann's slip-box numbering
- New users often under-link (not enough connections) or over-link (too many meaningless links)

---

## 4. Meeting Notes

### Features That Enable It

- **Templates**: Reusable structures invoked via `/template` slash command
- **Person pages**: `[[Alice Chen]]` creates a page for each person, collecting all references
- **Task markers in context**: `TODO` blocks inside meeting notes become trackable tasks
- **Date properties**: Dynamic variables like `<% today %>` in templates
- **Block embeds**: Pull meeting blocks into project pages or person pages

### Typical User Pattern

1. Start on today's journal page.
2. Type `/template`, select "meeting" template.
3. Fill in attendees as `[[person]]` links.
4. Take notes as nested blocks.
5. Create action items with `TODO [[Person]] task description`.
6. After the meeting, action items are automatically visible on person pages (via backlinks) and in task queries.

### Example: Meeting Template

Defined on a `[[templates]]` page:

```markdown
- ## Meeting: {meeting title}
  template:: meeting
  meeting-type::
  date:: <% today %>
  attendees::
  - ### Agenda
    -
  - ### Discussion Notes
    -
  - ### Action Items
    - TODO
  - ### Decisions Made
    -
  - ### Follow-up
    -
```

### Example: Filled-In Meeting

```markdown
- ## Meeting: Q1 Planning
  date:: [[Dec 20th, 2024]]
  attendees:: [[Alice Chen]], [[Bob Smith]], [[Carol Davis]]
  - ### Discussion Notes
    - [[Alice Chen]] presented the budget proposal
      - We need to cut 15% from the tools budget
    - [[Bob Smith]] raised concerns about the timeline
      - Suggested pushing the launch to March
  - ### Action Items
    - TODO [[Alice Chen]] to revise the budget by Friday
      DEADLINE: <2024-12-27 Fri>
    - TODO [[Bob Smith]] to create revised timeline
      SCHEDULED: <2024-12-23 Mon>
    - TODO [[Carol Davis]] to survey the team on preferences
  - ### Decisions Made
    - Agreed to delay launch to March if budget allows
```

### Follow-Up Tracking via Person Pages

Visiting `[[Alice Chen]]`'s page shows all meetings she attended, all action items assigned to her, and all references to her across the graph. Add a query to surface her open tasks:

```markdown
## [[Alice Chen]]
role:: Engineering Manager
team:: Platform

### Open Action Items
{{query (and (todo TODO DOING) [[Alice Chen]])}}

### Recent Mentions
(Linked References section shows everything automatically)
```

### What Logseq Does Well (and Not) for Meetings

**Strengths**:
- Meeting notes and action items live together -- no need to copy tasks elsewhere
- Person pages automatically aggregate all interactions (meetings, tasks, mentions)
- Templates ensure consistent structure
- Action items are tracked by the same query system as all other tasks

**Weaknesses**:
- No real-time collaboration (unlike Notion or Google Docs)
- No built-in calendar integration for scheduling (community plugin: **gcal2logseq**)
- Templates are text-only; no forms or structured input
- Person pages must be manually maintained if you want richer metadata

---

## 5. Research & Reading Notes

### Features That Enable It

- **Built-in PDF reader/annotator**: Open, highlight, and annotate PDFs within Logseq
- **Zotero integration**: Native `/Zotero` command imports bibliographic metadata
- **Block references from highlights**: PDF highlights become blocks with page-number references
- **Web clipper**: Browser extension clips content into the graph
- **Properties**: Bibliographic metadata as key-value pairs
- **Progressive summarization**: Highlight syntax (`^^text^^`) enables layered distillation

### PDF Annotation Workflow

Logseq has a **built-in PDF reader and annotator** -- one of its standout features:

1. **Import a PDF**: Drag a PDF into Logseq or link via Zotero.
2. **Open the PDF**: Click the link to open in Logseq's built-in viewer.
3. **Highlight text**: Select text, choose a highlight color.
4. **Automatic block references**: Each highlight becomes a block with page number. Clicking the reference jumps to the exact PDF location.

```markdown
- Reading: [[books/Thinking Fast and Slow]]
  - Highlights from PDF:
    - "Nothing in life is as important as you think it is, while
      you are thinking about it" (p. 402)
      - My note: This is the focusing illusion - relates to [[anchoring bias]]
    - "A reliable way to make people believe in falsehoods is
      frequent repetition" (p. 62)
      - This connects to [[mere exposure effect]]
```

### Zotero Integration

From the Logseq blog: "Learn how to set up Zotero in combination with Logseq, and get access to powerful document annotation and citation features."

1. **Setup**: Configure Zotero API key in Settings > Editor > Zotero.
2. **Import**: Type `/Zotero` in any block, search for a reference. Logseq creates a page with bibliographic metadata as properties:
   ```markdown
   title:: Thinking, Fast and Slow
   authors:: [[Daniel Kahneman]]
   item-type:: book
   date:: 2011
   publisher:: Farrar, Straus and Giroux
   tags:: psychology, cognitive-science
   ```
3. **Annotate linked PDFs**: If the Zotero entry has a PDF attachment, Logseq opens it and creates block references for highlights.
4. **Cite**: Reference `[[Thinking, Fast and Slow]]` anywhere; backlinks collect all citations.

The ecosystem extends this with community plugins: **logseq-pdf-extract** (works with local Zotero, no internet needed, OCRs math formulas), **logseq-citation-manager** (supports `.bib` files from Zotero, Paperpile, etc.), and **logseq-pdf-nav** (better navigation between PDF locations).

### Web Clipper & External Capture

- **Logseq web clipper**: Browser extension clips pages as blocks into the journal or a specific page.
- **save-to-logseq** plugin: Sends page selections, images, Twitter threads, YouTube videos via the Logseq HTTPS API.
- **Readwise integration**: Official plugin exports Kindle/web highlights into Logseq.
- **Omnivore plugin**: Fetches read-later articles and highlights.
- **Hypothesis plugin**: Imports hypothes.is annotations.
- **logseq-memos-sync**: Syncs Memos entries into the graph.
- **logseq Protocol**: `logseq://` URL scheme for external tools to send content.

### Literature Notes Pattern

```markdown
- ## Literature Note: [[books/Thinking Fast and Slow]]
  type:: literature-note
  source:: [[Thinking, Fast and Slow]]
  - System 1 operates automatically and quickly, with little effort
    - This is why first impressions are so powerful -> [[first impressions]]
  - System 2 allocates attention to effortful mental activities
    - Relates to [[cognitive load theory]]
  - The "what you see is all there is" (WYSIATI) principle
    - We make judgments based on available information, not what's missing
    - Connects to [[confirmation bias]] and [[availability heuristic]]
```

### Progressive Summarization

Users implement Tiago Forte's progressive summarization in Logseq:

1. **Layer 1**: Capture raw highlights (via PDF annotation or web clipper).
2. **Layer 2**: **Bold** the most important passages.
3. **Layer 3**: ^^Highlight^^ the bolded text (using `^^text^^` syntax).
4. **Layer 4**: Write an executive summary in your own words.
5. **Layer 5**: Remix into original output.

```markdown
- ## Reading Notes: [[Article/The Power of Habit]]
  - **Layer 4 Summary**: Habits follow a cue-routine-reward loop.
    Changing the routine while keeping cue and reward is the key.
  - Raw notes:
    - ^^**The habit loop consists of three elements: a cue, a routine,
      and a reward**^^. Understanding these components is essential.
    - Research at MIT discovered that habits emerge because the brain
      is constantly looking for ways to save effort.
    - **You can never truly extinguish bad habits**. Instead, to change
      a habit, keep the old cue and reward, but insert a new routine.
```

### What Logseq Does Well (and Not) for Research

**Strengths**:
- Built-in PDF annotation is rare among note-taking tools
- Zotero integration is first-class for academic workflows
- Block references from highlights create a bridge between source and notes
- Rich plugin ecosystem for importing from various sources (Readwise, Hypothesis, Omnivore)

**Weaknesses**:
- PDF reader is functional but basic compared to dedicated tools (no search within PDF, limited annotation types)
- No EPUB or web article reader built-in
- Web clipper is less polished than Obsidian's or Notion's
- No built-in citation formatting (no "insert bibliography" feature)

---

## 6. Project Management

### Features That Enable It

- **Page properties**: Structured metadata on project pages (`status::`, `priority::`, `owner::`)
- **Namespaces**: Hierarchical page organization (`[[Projects/Website Redesign]]`)
- **Task aggregation queries**: Surface all tasks related to a project from anywhere in the graph
- **Block embeds**: Pull meeting notes, decisions, etc. into the project page
- **Kanban plugin**: Visual board view (community plugin)
- **Agenda plugin**: Calendar/timeline view (community plugin)

### Example: Project Page with Properties

```markdown
title:: Website Redesign
category:: project
status:: active
priority:: high
start-date:: [[2024-11-01]]
target-date:: [[2025-02-28]]
owner:: [[Alice Chen]]
team:: [[Bob Smith]], [[Carol Davis]]

- ## Objective
  - Modernize the company website with improved UX and performance
- ## Key Results
  - TODO Reduce page load time to under 2 seconds
  - TODO Increase conversion rate by 15%
  - TODO Launch by end of Q1 2025
- ## Tasks
  - TODO [#A] Finalize design mockups
    DEADLINE: <2025-01-15 Wed>
  - TODO [#B] Set up new CI/CD pipeline
  - DOING Audit current site performance
- ## Meeting Notes
  - {{embed [[Dec 20th, 2024/Website Redesign Kickoff]]}}
- ## Resources
  - [[Resources/Design System Guidelines]]
  - [[Resources/Performance Benchmarks]]
```

### Task Aggregation Across the Graph

The killer feature: a query that finds every task mentioning a project, regardless of which page it lives on.

```clojure
#+BEGIN_QUERY
{:title "All Website Redesign Tasks"
 :query [:find (pull ?b [*])
         :where
           [?b :block/marker ?m]
           [(contains? #{"TODO" "DOING" "NOW" "LATER"} ?m)]
           [?b :block/ref-pages ?p]
           [?p :block/name "website redesign"]]
 :result-transform (fn [result]
                     (sort-by (fn [h]
                       (get h :block/priority "Z")) result))
 :collapsed? false}
#+END_QUERY
```

This means: tasks created during meetings, in journal entries, on person pages, or anywhere else -- as long as they reference `[[Website Redesign]]`, they appear here.

### Progress Tracking

```markdown
- ## Project Progress
  - **Done**: {{query (and (todo DONE) [[Website Redesign]])}}
  - **In Progress**: {{query (and (todo DOING) [[Website Redesign]])}}
  - **Remaining**: {{query (and (todo TODO) [[Website Redesign]])}}
```

### PARA Method Implementation

Tiago Forte's Projects/Areas/Resources/Archives maps naturally to Logseq:

```markdown
[[Projects/Website Redesign]]
[[Projects/Q1 Marketing Campaign]]
[[Areas/Health]]
[[Areas/Finance]]
[[Resources/Design Patterns]]
[[Archives/Old Project X]]
```

View all items in a category: `{{namespace Projects}}`

Or use property-based queries:

```markdown
## Active Projects
{{query (and (property category project) (property status active))}}

## Completed Projects
{{query (and (property category project) (property status done))}}
```

### What Logseq Does Well (and Not) for Project Management

**Strengths**:
- Distributed task creation: create tasks anywhere, query them on the project page
- Properties enable structured metadata on project pages
- Embeds pull meeting notes and decisions into project context
- The same query system works for personal and project tasks

**Weaknesses**:
- No Gantt charts, timeline views, or dependency tracking
- No multi-user assignment or collaboration features
- Kanban requires a community plugin (not built-in)
- Property-based queries require learning Datalog for anything complex
- Not a replacement for dedicated PM tools (Linear, Jira) for team workflows

---

## 7. Weekly/Monthly Reviews

### Features That Enable It

- **Query-based review pages**: Embedded queries surface tasks by date range, status, or project
- **`between` filter**: Scope queries to specific date ranges
- **Journal traversal**: Scroll through past entries or query by date
- **Templates**: Consistent review structure via `/template`
- **Properties**: Track review metadata (date, period, goals)

### Example: Weekly Review Page

```markdown
- ## Weekly Review - [[Dec 20th, 2024]]
  template:: weekly-review
  - ### Completed This Week
    {{query (and (todo DONE) (between -7d today))}}
  - ### Still Open
    {{query (and (todo TODO DOING) (between -7d today))}}
  - ### Overdue Tasks
    #+BEGIN_QUERY
    {:title "Overdue"
     :query [:find (pull ?b [*])
             :in $ ?today
             :where
               [?b :block/marker ?m]
               [(contains? #{"TODO" "DOING" "NOW" "LATER"} ?m)]
               (or
                 (and [?b :block/scheduled ?d] [(< ?d ?today)])
                 (and [?b :block/deadline ?d] [(< ?d ?today)]))]
     :inputs [:today]}
    #+END_QUERY
  - ### Key Insights This Week
    -
  - ### Priorities for Next Week
    - TODO [#A]
    - TODO [#B]
    - TODO [#C]
```

### Unfinished Task Review

```markdown
- ### Orphaned TODOs (tasks with no project)
  #+BEGIN_QUERY
  {:title "Untagged TODOs"
   :query [:find (pull ?b [*])
           :where
             [?b :block/marker "TODO"]
             (not [?b :block/ref-pages ?p])]
   :collapsed? false}
  #+END_QUERY

- ### Tasks by Project
  {{query (and (todo TODO) [[Project Alpha]])}}
  {{query (and (todo TODO) [[Project Beta]])}}
```

### Monthly Review with Journal Traversal

```markdown
- ### What happened in December?
  {{query (and (between [[Dec 1st, 2024]] [[Dec 31st, 2024]]) [[highlight]])}}

- ### Monthly Habit Completion
  (Use the Habit Tracker plugin or Property Visualizer to see trends)

- ### Pages Created This Month
  (Use graph view filtered to date range)
```

### What Logseq Does Well (and Not) for Reviews

**Strengths**:
- Queries make reviews *live* -- they update automatically as tasks change
- `between` filter is powerful for scoping to any date range
- Templates ensure you don't skip review steps
- Can surface orphaned tasks, overdue items, and unlinked references

**Weaknesses**:
- No built-in "review mode" or guided process
- Constructing effective review queries requires Datalog knowledge
- No automatic metrics/charts (requires plugins)
- Cannot easily compare "planned vs actual" without manual tracking

---

## 8. Personal Knowledge Base

### Features That Enable It

- **Evergreen notes**: Continuously refined pages with `status::` properties
- **Maps of Content (MOC)**: Curated index pages linking to topic clusters
- **Namespaces**: `topic/subtopic` hierarchy via `/` in page names
- **Tags and properties**: Multi-dimensional organization
- **Flashcards / spaced repetition**: Built-in `#card` and `{{cloze}}` syntax
- **Page aliases**: `alias:: [[Alternative Name]]` for flexible linking

### Evergreen Notes Pattern

Evergreen notes (concept from Andy Matuschak) are continuously refined atomic notes:

```markdown
## [[Evergreen/Spaced repetition enhances long-term retention]]
type:: evergreen
status:: growing
created:: [[2024-06-15]]
last-refined:: [[2024-12-20]]

- Spaced repetition leverages the [[spacing effect]] to strengthen memory
  over time by reviewing material at increasing intervals.
- Evidence from [[Ebbinghaus]] shows that forgetting follows a predictable
  curve, and strategically timed reviews can flatten this curve.
- Practical implementations:
  - [[Anki]] uses the SM-2 algorithm
  - Logseq has built-in flashcard support with `#card` syntax
  - The [[Leitner system]] is the paper-based equivalent
- This principle applies beyond memorization:
  - Revisiting ideas at intervals leads to deeper understanding
  - Related to [[incubation effect]] in creative problem-solving
```

The `status:: growing` property distinguishes work-in-progress notes from mature ones. Users refine these over time as new information flows in via backlinks.

### Maps of Content (MOC)

MOCs serve as curated indexes for topic clusters -- an alternative to folder hierarchies:

```markdown
## [[MOC/Cognitive Science]]
type:: moc

- ## Core Concepts
  - [[Dual process theory]] - System 1 vs System 2
  - [[Cognitive load theory]] - Limits of working memory
  - [[Spacing effect]] - Why distributed practice works
  - [[Testing effect]] - Retrieval practice strengthens memory
- ## Biases & Heuristics
  - [[Anchoring bias]]
  - [[Availability heuristic]]
  - [[Confirmation bias]]
- ## Applications
  - [[Learning Techniques MOC]]
  - [[Decision Making MOC]]
- ## Key Thinkers
  - [[Daniel Kahneman]]
  - [[Amos Tversky]]
```

The Logseq blog (ITE article) describes this as: "You can build 'maps of content' with links. These 'MOCs' function as an index or 'table of content' for your database. By pointing to all the pieces of information you wish to access frequently, you're mimicking the functionality of a folder."

MOCs differ from namespaces: they are **curated and opinionated** (you choose what goes there and how it's organized), whereas namespaces are automatic hierarchies.

### Namespaces for Hierarchy

Logseq's namespace feature uses `/` in page names to create implicit hierarchy:

```markdown
[[philosophy/epistemology]]
[[philosophy/ethics]]
[[philosophy/metaphysics]]
[[books/nonfiction/Thinking Fast and Slow]]
[[projects/2024/Q4/website-redesign]]
[[resources/programming/rust]]
```

Query all pages under a namespace:

```markdown
{{namespace philosophy}}
```

This renders a navigable hierarchy of all `philosophy/*` pages. Namespaces bridge free-form linking with the desire for some structure.

### Tag-Based Discovery

Logseq treats `#tags` and `[[wikilinks]]` identically -- both create page references. Users assign them different semantic roles:

```markdown
- This meeting was productive #meeting #[[Project Alpha]]
- Need to follow up with [[Alice Chen]] about the budget #action
```

Visiting `#meeting` reveals all blocks tagged with it, enabling pattern discovery across meetings.

### Built-In Flashcards / Spaced Repetition

Any block can become a flashcard:

```markdown
- What is the spacing effect? #card
  - Learning is more effective when study sessions are spaced out
    over time rather than massed together.
```

**Cloze deletions** for fill-in-the-blank:

```markdown
- The capital of France is {{cloze Paris}} #card
- Photosynthesis converts {{cloze light energy}} into {{cloze chemical energy}} #card
```

Access flashcards via the `/Cards` command or the flashcards sidebar icon. Logseq uses a spaced repetition algorithm to schedule reviews.

### What Logseq Does Well (and Not) as a Knowledge Base

**Strengths**:
- Multiple organization paradigms coexist: flat linking, namespaces, MOCs, tags, properties
- Backlinks mean every concept page is an automatic "see also" index
- Built-in flashcards integrate learning with note-taking (unique among PKM tools)
- Open file format (Markdown/Org) means no vendor lock-in

**Weaknesses**:
- No full-text search within properties (property queries are exact match)
- Namespace hierarchy is cosmetic -- no folder-like containment semantics
- Graph view gets cluttered beyond ~500 pages; needs better filtering/clustering
- No "publish" or "share" workflow built-in (community solutions: **logseq-publish**, **logseq-schrodinger**)
- Outliner format makes some content types awkward (tables, diagrams, long prose)

---

## 9. Key User Patterns & Why People Choose Logseq

### The Typical Logseq Power User's Day

```
Morning:
  1. Open Logseq -> Today's journal with daily template auto-loaded
  2. Review "Today's Tasks" query (scheduled/overdue items)
  3. Write morning intentions

Throughout the day:
  4. Capture meeting notes using /template -> meeting
  5. Quick-capture ideas, tagging with [[relevant pages]]
  6. Process email -> create TODO blocks with deadlines
  7. Research a topic -> PDF annotations flow into reference notes
  8. Link new ideas to existing ones via [[wikilinks]]

End of day:
  9. Review what was accomplished (check off DONE tasks)
  10. Schedule tomorrow's priorities
  11. Write a brief reflection in the journal

Weekly:
  12. Open weekly review template
  13. Review all open TODOs via queries
  14. Check for orphaned tasks (no project assignment)
  15. Review backlinks on key project pages
  16. Refine evergreen notes that received new connections
```

### Why Users Choose Logseq

| Reason | Detail |
|---|---|
| **Privacy-first** | All data stored locally as plain Markdown/Org files. No cloud required (optional Logseq Sync available). |
| **Block-level granularity** | Unlike Obsidian (page-first), Logseq's block references and block embeds allow idea-level precision. |
| **Outliner DNA** | Native outliner with indent/outdent, collapse/expand, zoom. Not a plugin or afterthought. |
| **Org-mode support** | One of the few GUI tools that natively supports Org-mode format, appealing to Emacs users who want a friendlier interface. |
| **Built-in task management** | TODO/DOING/DONE/LATER/NOW with scheduling, deadlines, priorities -- no plugins needed. |
| **Built-in queries** | Both simple queries and advanced Datalog for live-updating views. |
| **PDF annotation** | Built-in PDF reader with highlighting and block-referenced annotations. |
| **Flashcards** | Built-in spaced repetition with `#card` and `{{cloze}}` syntax. |
| **Open source** | Fully open-source (AGPL-3.0), active community, plugin ecosystem. |
| **Plugin ecosystem** | Marketplace with plugins for Kanban, habit tracking, calendars, themes, AI, and more. |

### The Logseq Philosophy in One Sentence

> "Don't organize, then write. Write, then let the organization emerge through links."

This is why the name: **"Log"** + **"seq"** (sequence) -- a log of your thoughts, sequenced by time, connected by links, made queryable by a graph database.

---

## Summary of Key Syntax

| Feature | Syntax |
|---|---|
| Page link | `[[Page Name]]` |
| Tag | `#tag` or `#[[multi word tag]]` |
| Block reference | `((block-uuid))` |
| Block embed | `{{embed ((block-uuid))}}` |
| Page embed | `{{embed [[Page Name]]}}` |
| TODO task | `TODO task description` |
| Priority | `TODO [#A] task` |
| Scheduled | `SCHEDULED: <2024-12-25 Wed>` |
| Deadline | `DEADLINE: <2024-12-25 Wed>` |
| Property | `key:: value` |
| Simple query | `{{query (and (todo TODO) [[page]])}}` |
| Namespace query | `{{namespace parent/page}}` |
| Flashcard | `Question #card` (answer as child block) |
| Cloze deletion | `{{cloze hidden text}}` |
| Template use | `/template` then select name |
| Advanced query | `#+BEGIN_QUERY ... #+END_QUERY` |
| Highlight | `^^highlighted text^^` |
| Page alias | `alias:: [[Other Name]]` |

---

## References and Further Reading

- [Logseq Blog: How to Get Started With Networked Thinking](https://blog.logseq.com/how-to-get-started-with-networked-thinking-and-logseq/) -- Foundational article on Logseq's outliner fundamentals, blocks, links, and queries.
- [Logseq Blog: How to Set Up an Automated Daily Template](https://blog.logseq.com/how-to-set-up-an-automated-daily-template-in-logseq/) -- Step-by-step guide for daily recurring templates with plugin recommendations.
- [Logseq Blog: The Rise of the Integrated Thinking Environment](https://blog.logseq.com/logseq-and-the-rise-of-the-integrated-thinking-environment/) -- Logseq as ITE: text editor + outliner + bi-directional linking. The NOTE framework (Navigability, Organisability, Transformability, Extensibility).
- [Logseq Blog: Zotero Integration Guide](https://blog.logseq.com/citation-needed-how-to-use-logseqs-zotero-integration/) -- Academic reference management with Zotero + Logseq PDF annotation.
- [Logseq GitHub Repository](https://github.com/logseq/logseq) -- README covers the DB version (beta), features, and links to all resources.
- [Awesome Logseq](https://github.com/logseq/awesome-logseq) -- Community-curated list of themes, plugins, integrations, workflow guides, PDF/bibliography tools, and CLI scripts.
- [Logseq Community Forum](https://discuss.logseq.com) -- Forum for workflow discussions, feature requests, and tips.
