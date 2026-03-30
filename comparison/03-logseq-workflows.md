# Logseq Workflows: How Users Actually Use It Day-to-Day

Logseq is an open-source, privacy-first outliner that combines a text editor, an outliner, and a bi-directional linking tool into what its community calls an "Integrated Thinking Environment" (ITE). Unlike traditional note-taking apps built around files and folders, Logseq is fundamentally **block-centric** and **journal-first**: every piece of information is a block (a bullet point), and most information flows through a daily journal page before being linked elsewhere.

This document covers the major workflows Logseq enables and how its community actually uses them.

---

## Table of Contents

1. [Daily Journaling Workflow](#1-daily-journaling-workflow)
2. [Task Management / GTD](#2-task-management--gtd)
3. [Zettelkasten / Knowledge Management](#3-zettelkasten--knowledge-management)
4. [PARA Method](#4-para-method-projects-areas-resources-archives)
5. [Meeting Notes Workflow](#5-meeting-notes-workflow)
6. [Research & Reading Notes](#6-research--reading-notes)
7. [Weekly/Monthly Reviews](#7-weeklymonthly-reviews)
8. [Project Management](#8-project-management)
9. [Personal Knowledge Base](#9-personal-knowledge-base)
10. [Key Logseq User Patterns](#10-key-logseq-user-patterns)

---

## 1. Daily Journaling Workflow

The daily journal is the beating heart of Logseq. It is the single most important feature that distinguishes Logseq's workflow from traditional note-taking tools.

### How It Works

- **Auto-created page**: Every day at midnight, Logseq automatically creates a new journal page with today's date as the title (e.g., `Dec 25th, 2024` or `2024-12-25`, depending on your configured date format).
- **Journal-centric philosophy**: Logseq's official guidance is that **99% of your information should first be entered on the Journals page**. This eliminates the cognitive overhead of "where should I put this?"
- **Naming convention**: Configurable in `config.edn` via `:journal/page-title-format`. Common formats include:
  - `"MMM do, yyyy"` -> `Dec 25th, 2024` (default)
  - `"yyyy-MM-dd"` -> `2024-12-25`
  - `"yyyy_MM_dd"` -> `2024_12_25`
- **Scrollable history**: The Journals view shows today's page at the top, with past journal pages stacked below it in reverse chronological order, so you can scroll back through recent days.

### The Journal-Centric Workflow

The typical Logseq user's day starts like this:

```
- Open Logseq -> lands on today's journal page
- Start typing immediately (no need to create a page or navigate anywhere)
- Add quick thoughts, TODOs, meeting notes, ideas as blocks
- Tag blocks with [[page links]] to connect them to topics
- Those linked pages accumulate backlinks over time
```

### Quick Capture to Journal

Everything goes to the journal first:

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

The friction-free capture model means you never have to decide "which notebook does this go in?" You just type, link, and let structure emerge.

### Automated Daily Template

Users configure a recurring template in `config.edn` to pre-populate each journal page:

```clojure
;; In config.edn
:default-templates
  {:journals "daily"}
```

This references a template named `"daily"` that might look like:

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

### Reviewing Past Journals

- **Scrolling**: Simply scroll down on the Journals view to see past days.
- **"On This Day" queries**: Advanced users create query pages that surface journal entries from exactly one year ago, leveraging Datalog queries.
- **Search**: `Cmd+K` / `Ctrl+K` opens search; typing a date navigates to that journal page.
- **Linked References**: Clicking any `[[page link]]` shows all journal entries that reference that page, effectively creating a timeline of thoughts on any topic.

---

## 2. Task Management / GTD

Logseq has a built-in task management system inspired by Org-mode. Tasks are just blocks with special markers in front of them.

### Task Markers

Logseq supports two task workflows (selectable in Settings > Editor):

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
| `NOW` | Active task (equivalent to DOING) |
| `LATER` | Deferred task (equivalent to TODO) |
| `DONE` | Task completed |
| `CANCELLED` | Task abandoned |

You can also add custom markers like `WAITING` and `IN-REVIEW` via `config.edn`.

### Creating Tasks

```markdown
- TODO Write the quarterly report
- DOING Review pull request #42
- TODO Call dentist
  SCHEDULED: <2024-12-27 Fri>
  DEADLINE: <2024-12-31 Tue>
- DONE Send invoice to client
```

**Keyboard shortcuts**:
- `Cmd+Enter` / `Ctrl+Enter` toggles the TODO/DONE cycle on the current block.
- Typing `TODO ` at the start of a block creates a task.
- `/TODO` command from the slash menu.

### Task Priority

Tasks can be prioritized using Org-mode-style priority markers:

```markdown
- TODO [#A] Fix critical production bug
- TODO [#B] Update documentation
- TODO [#C] Organize desktop files
```

Priority levels: `[#A]` (highest), `[#B]` (medium), `[#C]` (lowest).

### Scheduling and Deadlines

Logseq supports two types of date assignments:

```markdown
- TODO Prepare presentation
  SCHEDULED: <2024-12-20 Fri>
  DEADLINE: <2024-12-25 Wed>
```

- **SCHEDULED**: When you plan to start working on it. Appears on your agenda from this date.
- **DEADLINE**: When it must be completed. Logseq shows warnings as the deadline approaches.

You insert dates via the `/date picker` command or by typing `SCHEDULED:` followed by an angle-bracket date.

### Task Queries

This is where Logseq's task management becomes powerful. You can embed live queries anywhere to surface tasks:

**Simple queries** (built-in syntax):

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

```clojure
#+BEGIN_QUERY
{:title "All TODOs tagged with Project Alpha"
 :query [:find (pull ?b [*])
         :where
           [?b :block/marker ?m]
           [(contains? #{"TODO" "DOING"} ?m)]
           [?b :block/ref-pages ?p]
           [?p :block/name "project alpha"]]
 :breadcrumb-show? true}
#+END_QUERY
```

### Common "Today" Dashboard Query

Many users build a "today" dashboard combining multiple task sources:

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

### GTD Implementation Pattern

Users implement GTD (Getting Things Done) in Logseq by:

1. **Capture**: Dump everything into the daily journal with `TODO` markers.
2. **Clarify**: Review journal TODOs, add context via links (`[[project]]`, `[[context/@phone]]`).
3. **Organize**: Use properties and tags to categorize:
   ```markdown
   - TODO Call vendor about pricing
     type:: action
     context:: [[context/@phone]]
     project:: [[Project/Office Renovation]]
   ```
4. **Review**: Weekly review page with queries that surface all open tasks.
5. **Engage**: A "Dashboard" page with queries for `NOW`/`DOING` tasks.

---

## 3. Zettelkasten / Knowledge Management

Logseq is exceptionally well-suited for Zettelkasten because its block-level granularity is more atomic than page-level notes in most other tools.

### Atomic Notes as Blocks

In traditional Zettelkasten, each idea goes on one index card. In Logseq, each idea is one **block**:

```markdown
- The spacing effect shows that learning is more effective when spread over time
  rather than crammed into a single session. This applies to both declarative
  and procedural knowledge. #[[spacing effect]] #[[learning science]]
```

This block is a standalone atomic idea. It can be:
- **Referenced** from anywhere: `((block-uuid))` pulls in the content.
- **Embedded** elsewhere: `{{embed ((block-uuid))}}` shows the block and all children.
- **Linked** via tags/page references that connect it to related concepts.

### Linking Between Ideas

Logseq provides three levels of linking:

**1. Page links** (topic-level connections):
```markdown
- The [[spacing effect]] is related to [[interleaving]] in that both
  leverage the benefits of [[desirable difficulties]] for learning.
```

**2. Block references** (idea-level precision):
```markdown
- This supports my earlier point about memory consolidation ((64a7b3c2-...))
```

**3. Block embeds** (show the full content inline):
```markdown
- {{embed ((64a7b3c2-...))}}
  - My additional commentary on this embedded block
```

### Discovery Through Backlinks

Every page in Logseq has a **Linked References** section at the bottom that shows all blocks across your entire graph that link to it. This is the bi-directional linking that powers serendipitous discovery:

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

Users treat Linked References as an **inbox**: they visit a page, review all the backlinks that have accumulated, and then synthesize the information by dragging relevant blocks onto the page or writing new synthesis blocks.

There are also **Unlinked References**: mentions of the page name in text that aren't explicitly linked. You can convert these to proper links with one click.

### Graph Exploration

Logseq's **graph view** visualizes all pages as nodes and all links as edges. Users use it for:

- **Discovering clusters**: Groups of densely connected notes reveal topic areas.
- **Finding orphans**: Isolated nodes indicate notes that haven't been connected yet.
- **Serendipitous connections**: Seeing that two apparently unrelated topics share a common reference.

The graph view can be filtered by:
- Pages only, or blocks too
- Specific tags
- Journal pages included/excluded

### Namespaced Pages for Categories

Logseq's **namespace** feature uses `/` in page names to create implicit hierarchy:

```markdown
[[philosophy/epistemology]]
[[philosophy/ethics]]
[[philosophy/metaphysics]]
[[books/nonfiction/Thinking Fast and Slow]]
[[books/fiction/Dune]]
```

Each namespace level creates its own page. You can query all pages under a namespace:

```markdown
{{namespace philosophy}}
```

This renders a navigable hierarchy of all `philosophy/*` pages. Namespaces bridge the gap between the free-form linking of Zettelkasten and the desire for some hierarchical structure.

---

## 4. PARA Method (Projects, Areas, Resources, Archives)

Tiago Forte's PARA method maps cleanly onto Logseq using namespaces and properties.

### Using Namespaced Pages for PARA

```markdown
[[Projects/Website Redesign]]
[[Projects/Q1 Marketing Campaign]]
[[Areas/Health]]
[[Areas/Finance]]
[[Areas/Professional Development]]
[[Resources/Design Patterns]]
[[Resources/Writing Tips]]
[[Archives/Old Project X]]
```

Each PARA category becomes a namespace root. You can view all items in a category:

```markdown
{{namespace Projects}}
```

### Property-Based Organization

Instead of (or in addition to) namespaces, you can use **page properties** to tag pages with their PARA category:

```markdown
title:: Website Redesign
category:: project
status:: active
area:: [[Areas/Marketing]]
deadline:: [[2025-03-31]]
```

Properties live in the first block of a page and are key-value pairs. They enable powerful querying.

### Query-Driven Project Dashboards

A "Projects Dashboard" page might contain:

```clojure
#+BEGIN_QUERY
{:title "Active Projects"
 :query [:find (pull ?p [*])
         :where
           [?p :block/properties ?props]
           [(get ?props :category) ?cat]
           [(= ?cat "project")]
           [(get ?props :status) ?status]
           [(= ?status "active")]]
 :collapsed? false}
#+END_QUERY
```

Or using simple queries:

```markdown
## Active Projects
{{query (and (property category project) (property status active))}}

## Areas of Responsibility
{{query (property category area)}}

## Completed Projects (Archive)
{{query (and (property category project) (property status done))}}
```

### Practical PARA Workflow

1. **Daily journal**: Capture everything on the journal page, tagging with project/area links.
2. **Project pages**: Each project page has properties and collects related tasks/notes via backlinks.
3. **Area pages**: Ongoing responsibilities; link to from journal whenever relevant.
4. **Resources**: Reference material; link to from project/area pages.
5. **Archives**: Change `status:: active` to `status:: done` when a project completes; it disappears from the active dashboard automatically.

---

## 5. Meeting Notes Workflow

### Template for Meeting Notes

Users create a meeting notes template on their `[[templates]]` page:

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

To use it: type `/template` in a block, select "meeting", and fill in the details.

### Linking to People Pages

Meeting notes link to **person pages** for each attendee:

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
```

Now, visiting `[[Alice Chen]]`'s page shows all meetings she's been in, all action items assigned to her, and all references to her across the graph.

### Action Items from Meetings

Because action items are just `TODO` blocks with page links, they show up in:
- The person's page (via backlinks)
- Global task queries
- Project-specific task queries (if tagged with project pages)

### Follow-Up Tracking

A person page can include a query showing all open tasks assigned to them:

```markdown
## [[Alice Chen]]
role:: Engineering Manager
team:: Platform

### Open Action Items
{{query (and (todo TODO DOING) [[Alice Chen]])}}

### Recent Mentions
(Linked References section shows everything automatically)
```

---

## 6. Research & Reading Notes

### PDF Annotation Workflow

Logseq has a **built-in PDF reader and annotator** that is one of its standout features:

1. **Import a PDF**: Drag a PDF into Logseq or link it via the Zotero integration.
2. **Open the PDF**: Click the PDF link to open it in Logseq's built-in viewer.
3. **Highlight text**: Select text in the PDF and choose a highlight color.
4. **Automatic block references**: Logseq creates a block reference for each highlight, including the page number. Clicking the reference takes you to the exact location in the PDF.

The workflow looks like:

```markdown
- Reading: [[books/Thinking Fast and Slow]]
  - Highlights from PDF:
    - "Nothing in life is as important as you think it is, while
      you are thinking about it" (p. 402) [:span]
      - My note: This is the focusing illusion - relates to [[anchoring bias]]
    - "A reliable way to make people believe in falsehoods is
      frequent repetition" (p. 62) [:span]
      - This connects to [[mere exposure effect]]
```

### Zotero Integration

Logseq has a **built-in Zotero integration** for academic reference management:

1. **Setup**: Configure your Zotero API key in Logseq Settings > Editor > Zotero settings.
2. **Import a reference**: Type `/Zotero` in any block, search for a reference, and Logseq creates a page with all bibliographic metadata as page properties:

```markdown
title:: Thinking, Fast and Slow
authors:: [[Daniel Kahneman]]
item-type:: book
date:: 2011
publisher:: Farrar, Straus and Giroux
tags:: psychology, cognitive-science, behavioral-economics
```

3. **Annotate linked PDFs**: If the Zotero entry has an attached PDF, Logseq opens it and creates block references for highlights.
4. **Cite in notes**: Reference the page `[[Thinking, Fast and Slow]]` anywhere; backlinks collect all your citations.

The Zotero integration turns Logseq into a powerful research tool, especially for academic workflows following the Zettelkasten method.

### Web Clipper Integration

- **Logseq web clipper** (browser extension): Clips web pages as blocks into your journal or a specific page.
- **Logseq Protocol**: `logseq://` URL scheme for external tools to send content to Logseq.
- **Copy-paste**: Pasting from the web preserves some formatting. Users refine clipped content into atomic notes.

### Literature Notes Linking to Source

The recommended pattern for research notes:

```markdown
- ## Literature Note: [[books/Thinking Fast and Slow]]
  type:: literature-note
  source:: [[Thinking, Fast and Slow]]
  - System 1 operates automatically and quickly, with little effort
    - This is why first impressions are so powerful -> [[first impressions]]
  - System 2 allocates attention to effortful mental activities
    - Relates to [[cognitive load theory]]
  - The "what you see is all there is" (WYSIATI) principle
    - We make judgments based on available information, not on what's missing
    - Connects to [[confirmation bias]] and [[availability heuristic]]
```

### Progressive Summarization

Users implement Tiago Forte's progressive summarization in Logseq:

1. **Layer 1**: Capture raw highlights from the source (via PDF annotation or web clipper).
2. **Layer 2**: Bold the most important passages within those highlights.
3. **Layer 3**: Highlight the bolded text (using Logseq's highlight syntax `^^text^^`).
4. **Layer 4**: Write an executive summary in your own words at the top.
5. **Layer 5**: Remix into original output (blog posts, essays, presentations).

```markdown
- ## Reading Notes: [[Article/The Power of Habit]]
  - **Layer 4 Summary**: Habits follow a cue-routine-reward loop.
    Changing the routine while keeping cue and reward is the key to habit change.
  - Raw notes:
    - ^^**The habit loop consists of three elements: a cue, a routine,
      and a reward**^^. Understanding these components is essential.
    - Research at MIT discovered that habits emerge because the brain
      is constantly looking for ways to save effort.
    - **You can never truly extinguish bad habits**. Instead, to change
      a habit, you must keep the old cue and deliver the old reward,
      but insert a new routine.
```

---

## 7. Weekly/Monthly Reviews

### Query-Based Review Pages

Users create dedicated review pages with embedded queries:

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

### Reviewing Unfinished Tasks

The review process surfaces tasks across the entire graph:

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

### Journal Traversal

For monthly reviews, users scroll through past journal pages or use queries:

```markdown
- ### What happened in December?
  {{query (and (between [[Dec 1st, 2024]] [[Dec 31st, 2024]]) [[highlight]])}}
```

The `between` filter in simple queries allows scoping to date ranges for retrospectives.

---

## 8. Project Management

### Project Pages with Properties

Each project gets a dedicated page with structured metadata:

```markdown
title:: Website Redesign
category:: project
status:: active
priority:: high
start-date:: [[2024-11-01]]
target-date:: [[2025-02-28]]
owner:: [[Alice Chen]]
team:: [[Bob Smith]], [[Carol Davis]]
tags:: #design, #engineering

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
  - TODO [#C] Migrate content
  - DOING Audit current site performance
- ## Meeting Notes
  - {{embed [[Dec 20th, 2024/Website Redesign Kickoff]]}}
- ## Resources
  - [[Resources/Design System Guidelines]]
  - [[Resources/Performance Benchmarks]]
```

### Task Aggregation Across Pages

A project dashboard aggregates tasks from all related pages:

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

This finds every `TODO` or `DOING` block across the entire graph that references `[[Website Redesign]]`, regardless of which page the task lives on.

### Progress Tracking via Queries

```markdown
- ## Project Progress
  - **Done**: {{query (and (todo DONE) [[Website Redesign]])}}
  - **In Progress**: {{query (and (todo DOING) [[Website Redesign]])}}
  - **Remaining**: {{query (and (todo TODO) [[Website Redesign]])}}
```

### Kanban Views (via Plugin)

The **logseq-kanban-plugin** adds Kanban board visualization:

```markdown
{{renderer :kanban, Website Redesign}}
```

This creates columns based on task states (TODO, DOING, DONE) and allows drag-and-drop between columns. Other popular project management plugins include:

- **logseq-plugin-agenda**: Calendar and timeline views for scheduled tasks.
- **logseq-plugin-todo**: Enhanced TODO management with recurring tasks.
- **logseq-plugin-tabs**: Open multiple pages in tabs for faster project navigation.

---

## 9. Personal Knowledge Base

### Evergreen Notes Pattern

Evergreen notes (coined by Andy Matuschak) are continuously refined atomic notes. In Logseq:

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

The `status:: growing` property distinguishes "work in progress" notes from mature ones. Users refine these over time as new information comes in via backlinks.

### Maps of Content (MOC) Pages

MOC pages serve as curated indexes for topic clusters, an alternative to folder hierarchies:

```markdown
## [[MOC/Cognitive Science]]
type:: moc

- ## Core Concepts
  - [[Dual process theory]] - System 1 vs System 2 thinking
  - [[Cognitive load theory]] - Limits of working memory
  - [[Spacing effect]] - Why distributed practice works
  - [[Testing effect]] - Retrieval practice strengthens memory
- ## Biases & Heuristics
  - [[Anchoring bias]]
  - [[Availability heuristic]]
  - [[Confirmation bias]]
  - [[Dunning-Kruger effect]]
- ## Applications
  - [[Learning Techniques MOC]]
  - [[Decision Making MOC]]
  - [[UX Design and Cognition]]
- ## Key Thinkers
  - [[Daniel Kahneman]]
  - [[Amos Tversky]]
  - [[Herbert Simon]]
```

MOCs differ from namespaces in that they are **curated and opinionated**: you choose what goes on a MOC and how it's organized, whereas namespaces are automatic hierarchies.

### Tag-Based Discovery

Logseq treats `#tags` and `[[wikilinks]]` identically -- both create page references. Users use them for different semantic purposes:

```markdown
- This meeting was productive #meeting #[[Project Alpha]]
- Need to follow up with [[Alice Chen]] about the budget #action
```

Visiting the `#meeting` page reveals all blocks tagged with it, enabling discovery of patterns across meetings.

### Hierarchical Organization via Namespaces

For users who want both linking and hierarchy:

```markdown
[[areas/health/exercise]]
[[areas/health/nutrition]]
[[areas/health/sleep]]
[[projects/2024/Q4/website-redesign]]
[[resources/programming/rust]]
[[resources/programming/typescript]]
```

Query all namespace children:

```markdown
{{namespace areas/health}}
```

This renders a navigable list of all pages under `areas/health/`.

### Flashcards / Spaced Repetition

Logseq has built-in spaced repetition. Any block can become a flashcard:

```markdown
- What is the spacing effect? #card
  - Learning is more effective when study sessions are spaced out
    over time rather than massed together.
```

**Cloze deletions** for inline testing:

```markdown
- The capital of France is {{cloze Paris}} #card
- Photosynthesis converts {{cloze light energy}} into {{cloze chemical energy}} #card
```

Access flashcards via the `/Cards` command or the flashcards icon in the sidebar. Logseq uses a spaced repetition algorithm to schedule reviews.

---

## 10. Key Logseq User Patterns

### "Block-First" Thinking

The most fundamental shift for new Logseq users:

- **Traditional tools**: Think in pages/documents. "I need to create a note about X."
- **Logseq**: Think in blocks. "I have a thought. I'll write it as a block and link it."

Pages in Logseq are just collections of blocks. A page doesn't need content of its own -- it can exist purely as a **hub** that collects backlinks from blocks across the graph.

```
Page: [[Machine Learning]]

(page itself might be empty, or have a brief definition)

Linked References:
  - From Dec 20: "Read about [[machine learning]] transformers..."
  - From Dec 15: "TODO Take [[machine learning]] course on Coursera"
  - From Nov 28: "Meeting with [[Alice Chen]] about [[machine learning]] strategy"
  - From Nov 10: "[[Machine learning]] requires large datasets for training..."
```

The page becomes valuable not because someone wrote an essay on it, but because blocks scattered across dozens of journal entries all point to it.

### Friction-Free Capture

Logseq removes the #1 barrier to note-taking: deciding where to put things.

| Traditional Tool | Logseq |
|---|---|
| Open app -> Which notebook? -> Which section? -> Write | Open app -> Type on journal -> Add a link |
| "I'll file this later" (never does) | It's already filed by date, and linked to topics |
| Context switch to find the right file | Stay in the journal; links do the organizing |

This is why the Logseq community says: **"Just type in the journal."**

### Emergent Structure Through Linking

Logseq users don't plan their information architecture upfront. Instead:

1. **Week 1**: Just write in the journal, occasionally adding `[[links]]`.
2. **Month 1**: Some pages accumulate many backlinks. These become natural hubs.
3. **Month 3**: Create MOC pages to curate the most important hubs.
4. **Month 6**: Add namespaces for areas that benefit from hierarchy.
5. **Year 1**: The graph has a rich, organic structure that mirrors your actual thinking.

This is what the community calls **"emergent structure"** -- you don't impose a system from the top down; you let it grow from the bottom up.

### Why Users Choose Logseq Over Alternatives

| Reason | Detail |
|---|---|
| **Privacy-first** | All data stored locally as plain Markdown/Org files. No cloud required (optional Logseq Sync available). |
| **Block-level granularity** | Unlike Obsidian (page-first), Logseq's block references and block embeds allow idea-level precision. |
| **Outliner DNA** | Native outliner with indent/outdent, collapse/expand, zoom. Not a plugin or afterthought. |
| **Org-mode support** | One of the few GUI tools that supports Org-mode format natively, appealing to Emacs users who want a friendlier interface. |
| **Built-in task management** | TODO/DOING/DONE/LATER/NOW markers with scheduling, deadlines, and priorities -- no plugins needed. |
| **Built-in queries** | Both simple queries and advanced Datalog queries for dynamic, live-updating views of your data. |
| **PDF annotation** | Built-in PDF reader with highlighting and block-referenced annotations. |
| **Flashcards** | Built-in spaced repetition with `#card` and `{{cloze}}` syntax. |
| **Open source** | Fully open-source (AGPL-3.0), with an active community and plugin ecosystem. |
| **Plugin ecosystem** | Marketplace with plugins for Kanban boards, habit tracking, calendars, themes, and more. |

### The Typical Logseq Power User's Day

```
Morning:
  1. Open Logseq -> Today's journal with daily template auto-loaded
  2. Review automated "Today's Tasks" query showing scheduled/overdue items
  3. Write morning intentions

Throughout the day:
  4. Capture meeting notes using /template -> meeting
  5. Quick-capture ideas as blocks, tagging with [[relevant pages]]
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

### The Logseq Philosophy in One Sentence

> "Don't organize, then write. Write, then let the organization emerge through links."

This is why Logseq calls itself a **"log"** + **"seq"** (sequence) -- it's fundamentally a log of your thoughts, sequenced by time, connected by links, and made queryable by a graph database.

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
| Flashcard | `Question #card` with answer as child block |
| Cloze | `{{cloze hidden text}}` |
| Template use | `/template` then select name |
| Advanced query | `#+BEGIN_QUERY ... #+END_QUERY` |
| Highlight | `^^highlighted text^^` |
| Page alias | `alias:: [[Other Name]]` |

---

## References and Further Reading

- [Logseq Blog: How to Get Started With Networked Thinking](https://blog.logseq.com/how-to-get-started-with-networked-thinking-and-logseq/)
- [Logseq Blog: How to Set Up an Automated Daily Template](https://blog.logseq.com/how-to-set-up-an-automated-daily-template-in-logseq/)
- [Logseq Blog: The Rise of the Integrated Thinking Environment](https://blog.logseq.com/logseq-and-the-rise-of-the-integrated-thinking-environment/)
- [Logseq Blog: Zotero Integration Guide](https://blog.logseq.com/citation-needed-how-to-use-logseqs-zotero-integration/)
- [Logseq Mastery: Understanding Namespaces](https://www.logseqmastery.com/blog/logseq-namespaces)
- [Logseq Mastery: Simplifying Workflows with Templates](https://www.logseqmastery.com/blog/logseq-templates)
- [Logseq GitHub Repository](https://github.com/logseq/logseq)
- [Logseq Community Forum](https://discuss.logseq.com)
- [Unofficial Logseq Tips & Tricks](https://unofficial-logseq-docs.gitbook.io/unofficial-logseq-docs)
