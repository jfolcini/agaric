<!-- markdownlint-disable MD060 -->
# Tags & Links

Agaric has three kinds of inline reference: **tags** (lightweight categorisation), **page / block links** (typed cross-references), and **inline query blocks** (live, filtered lists embedded in pages). Every reference is anchored by ULID so renaming the target doesn't break anything.

## Tags

Tags are first-class entities — each tag is a record with its own page in the **Tags** view.

- **Inline insertion**: type `@` inside the editor to open the **TagPicker**. Pick an existing tag or create a new one.
- **Tag chip**: tags render as coloured pills. Click to jump to the tag's page.
- **Tag hierarchy**: `/` in a tag name creates a hierarchy. Typing `@projects/website` creates `projects` as a parent (if it doesn't already exist) and `website` as a child. Querying a parent matches all descendants — *ancestor inheritance*.
- **Tag colour**: each tag has a colour picker (in the Tags view). The chip uses it everywhere.
- **Usage count**: the Tags view shows how many blocks carry each tag.
- **Rename**: in the Tags view → tag page header. All inline chips update because the link is by ULID.

## Boolean tag queries

The **Tags** view (and the Agenda tag filter) supports boolean expressions:

- `@a AND @b` — blocks carrying both tags
- `@a OR @b` — blocks carrying either
- `NOT @a` — blocks without that tag
- Combine: `(@a OR @b) AND NOT @c`

A pill-based UI lets you toggle each clause; advanced users can type the expression directly.

## Block & page links

- **Insert a page link**: type `[[` to open the **BlockLinkPicker**. Pick a page or paste a title.
- **Page chip**: links render as a chip with the target's title. Click to navigate; the page opens in the active tab.
- **Insert a block reference (transclusion)**: type `((` to open the **BlockRefPicker**. Pick the block whose content you want to embed.
- **Block reference**: renders the target block's content inline, kept live. Editing the source updates every reference.
- **Aliases**: a page can declare aliases (via the **PageAliasSection** in the **PageHeader**). Picker results include the alias as a breadcrumb. Typing the alias matches the target page.

## Cross-space links

A link whose target is in a different space **does not navigate**. It renders as a broken-link chip with the tooltip *"Broken link or in another space — click to remove"*. The chip is undo-friendly. The constraint is enforced both at write time and at render time, so accidental cross-space links can't sneak in via sync.

To follow a cross-space target, **switch space** first (see [spaces.md](spaces.md)).

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

A property of type *ref* can hold a tag (e.g. `assignee = @alice`). Tag references resolve like page links: rename-safe, click-to-navigate.

## Pitfalls to know

- **Tag namespaces are slash-delimited at the *display* level only.** The underlying tag is one entity per leaf. `@projects/website` is *different* from `@projects` even though queries for `@projects` match both via inheritance.
- **Block references are live.** Editing the source rewrites every embed. If you want a frozen copy, copy the text manually.
- **Unlinked references are case-insensitive substring matches.** They can be noisy if a page title is a common word. Use page aliases (or rename) to disambiguate.
- **Backlink filters are local to the section.** The Linked / Unlinked sections have independent filter state.
- **Picker can't find a page from another space.** Switch space first (intentional — see [spaces.md](spaces.md)).
