<!-- markdownlint-disable MD060 -->
# Tags & Links

Agaric has four kinds of reference: **tags** (lightweight categorisation), **page / block links** (typed cross-references), **embeds** (a block's real content, transcluded from wherever it lives), and **inline query blocks** (live, filtered lists embedded in pages). Inline references store the target's ULID and resolve its display name when rendering, so renaming a target doesn't break the reference.

## Tags

Tags are first-class entities — each tag is a record with its own page in the **Tags** view.

- **Inline insertion**: type `@` inside the editor to open the **AtTagPicker**. Pick an existing tag or create a new one.
- **Tag chip**: tags render as coloured pills. Click to jump to the tag's page.
- **Tag namespaces**: `/` in a tag name is a naming convention, not a structure — `@projects/website` is one tag whose name happens to contain a slash. What makes it useful is the **prefix query**: searching the prefix `projects/` matches `projects/website`, `projects/api`, and so on. It does *not* match the bare `@projects` tag, and tagging a block `@projects/website` does not implicitly tag it `@projects`.
- **Tag colour**: assign a colour in the Tags view; the chip uses it everywhere on **that device**. Colours are stored locally and are not synced, so the same tag can look different on your phone and your laptop.
- **Usage count**: the Tags view shows how many blocks carry each tag.
- **Rename**: edit the title in the Tags view → tag page header. Inline chips store only the tag's ULID and resolve the display name at render time, so every chip picks the new name up immediately.

## Boolean tag queries

The **Tags** view (and the Agenda tag filter) supports boolean expressions:

- `@a AND @b` — blocks carrying both tags
- `@a OR @b` — blocks carrying either
- `NOT @a` — blocks without that tag
- Combine and nest freely: `(@a OR @b) AND NOT @c`. AND / OR take any number of operands and NOT wraps any sub-expression; the backend evaluates the tree as-is (bounded only by a generous nesting-depth limit).

A pill-based UI lets you toggle each clause; advanced users can type the expression directly.

## Block & page links

- **Insert a page link**: type `[[` to open the **BlockLinkPicker**. Pick a page or paste a title.
- **Page chip**: links render as a chip with the target's title. Click to navigate; the page opens in the active tab.
- **Insert a block reference**: type `((` to open the **BlockRefPicker**. Pick the block you want to point at.
- **Block reference**: renders as a one-line **chip** carrying the target block's title. It is a link with a nicer label — it shows no children and no live content. To pull a block's actual content onto another page, use an **embed** (below).
- **Aliases**: a page can declare aliases (via the **PageAliasSection** in the **PageHeader**). Picker results include the alias as a breadcrumb. Typing the alias matches the target page.

## Embeds

An **embed** is transclusion: one source of truth rendered in many places. Where a `((block reference))` shows a title chip, an embed renders the target block **and its whole subtree** inline, in a bordered container, kept live.

- **Insert**: `/embed`, or type `{{embed` and search. Either way one list covers both kinds of target — a page is a block here — and the block's content becomes the token `{{embed ((ULID))}}`. The `{{embed [[ULID]]}}` form is also accepted when written by hand.
- **A block embed** renders the target block and every descendant. **A page embed** renders that page's top-level blocks; its header strip shows the page title alone.
- **The whole block becomes the embed.** Like `{{query …}}`, the token has to be the block's entire content — a mention of the syntax mid-sentence stays text.
- **Header strip**: reads *Embedded from {page}*, with a collapse chevron and an **Open source** control. The container is one tab stop: **Enter** opens the source, **Space** collapses.
- **The embedded subtree re-bases its indentation to depth 0** inside the container. It does not continue the host page's indent guides, and screen readers announce its rows relative to the host outline, not to the source page's depths.
- **Live**: editing the source updates every mounted embed of it, including when the source page is open in another tab.
- **Backlinks**: an embed produces a link edge like any other reference. It is currently *indistinguishable* from a plain reference in the backlinks panel — both read "referenced by".
- **Degraded targets**: the container never silently disappears — the block's content still holds the token. A soft-deleted target shows *Source deleted* with a Restore control; a purged target, or one in another space, shows a non-navigating broken chip. Moving the target changes nothing: the token is a ULID.
- **Cycles and depth**: A embedding B embedding A renders an *Already shown above* stub exactly where the loop closes, with a chip and a route to the source. An unrepeated chain stops at three levels with a *Nested too deep* stub.

### Current limitations

- **Read-only.** Edit the source through **Open source**; editing in place is not yet supported.
- **Arrow-key navigation does not descend into an embed** — Down from the row above lands on the row below it.
- **Collapse applies to the whole container**, not to branches inside it. Container collapse is stored per host block, so it never touches the source page's own saved layout.
- Only the first 32 rows of an embed render; the rest are one click away in the source.
- **Embedded rows render content only.** No todo checkbox, no priority or date chips, no list markers, no properties, and no attachments — just the row's rich text. Embed a page of tasks and you'll see the text with no checkboxes; open the source to interact with any of that.
- Embedding a block from a very large page loads that page's blocks to render the few you asked for.
- Embedded blocks do **not** count toward the host page's block count or its truncation notice — they are not that page's blocks.

## Cross-space links

A link whose target is in a different space **does not navigate** — it renders as a broken-link chip you can click to remove. To follow such a target, **switch space** first. See [spaces.md](spaces.md) → *Cross-space links* for the full rule.

## Backlinks

Every page shows two sections in its footer area:

- **Linked references** — every block that links to this page or any of its blocks.
- **Unlinked references** — every block that mentions this page's title or aliases as plain text (no chip).

### Filter dimensions

Both sections share a **BacklinkFilterBuilder** with these dimensions:

| Filter | What it does |
| --- | --- |
| Status | Limit to TODO / DOING / DONE / CANCELLED |
| Priority | Limit to a priority |
| Due / scheduled / completed / created date | Date-preset filter |
| Tag | Boolean tag expression |
| Property | `key:value` |
| Source page | Show only references from one or more specific pages (multi-select pill) |
| Source page exclude | Hide references from one or more pages |

The filter pills compose; clear with *"Clear all"*.

## Inline query blocks

You can embed a live, filtered list inside any page with an `{{query …}}` block. Inserted via `/query`, the block opens a **QueryBuilder** modal where you compose dimensions visually. The block re-renders whenever the underlying data changes.

Supported query types:

- **Tag query** — list every block carrying tag X (with boolean expression).
- **Property query** — list every block where `key matches value`.
- **Backlink query** — list every block linking to a given page.

The result is paginated, sortable, and respects the active space.

## Tag references in property values

A property of type *ref* can point at a tag as well as a page (e.g. a custom `area` key holding `@ops`). Tag references resolve like page links: rename-safe, click-to-navigate. Note the built-in `assignee` and `location` keys are plain text, not refs.

## Pitfalls to know

- **Tag namespaces are a naming convention, not a hierarchy.** `@projects/website` is a *different, unrelated* tag from `@projects`. Use a prefix query (`projects/`) to sweep a namespace — and remember it won't include the bare parent tag.
- **Block references are live.** Editing the source rewrites every embed. If you want a frozen copy, copy the text manually.
- **Unlinked references are case-insensitive substring matches.** They can be noisy if a page title is a common word. Use page aliases (or rename) to disambiguate.
- **Backlink filters are local to the section.** The Linked / Unlinked sections have independent filter state.
- **Picker can't find a page from another space.** Switch space first (intentional — see [spaces.md](spaces.md)).
