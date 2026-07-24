<!-- markdownlint-disable MD060 -->
# Tags & Links

Agaric has three kinds of inline reference: **tags** (lightweight categorisation), **page / block links** (typed cross-references), and **inline query blocks** (live, filtered lists embedded in pages). Inline references store the target's ULID and resolve its display name when rendering, so renaming a target doesn't break the reference.

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
- **Insert a block reference (transclusion)**: type `((` to open the **BlockRefPicker**. Pick the block whose content you want to embed.
- **Block reference**: renders the target block's content inline, kept live. Editing the source updates every reference.
- **Aliases**: a page can declare aliases (via the **PageAliasSection** in the **PageHeader**). Picker results include the alias as a breadcrumb. Typing the alias matches the target page.

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
