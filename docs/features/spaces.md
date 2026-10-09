<!-- markdownlint-disable MD060 -->
# Spaces

A **space** is a user-defined context that groups pages — typical setups are *Personal* and *Work*, but you can create more. Every page belongs to exactly one space; switching the active space re-scopes everything you see: lists, search results, agenda, backlinks, tabs, recent pages, the journal, even the OS window title.

## What you can do

- **Switch space** — pick from the dropdown at the top of the sidebar (the `SpaceSwitcher`).
- **Switch by index** — `Ctrl+1` through `Ctrl+9` (or `⌘1`–`⌘9` on macOS) jump to the first nine spaces alphabetically. The shortcut hint appears on each dropdown row.
- **Cycle the active space** — on a collapsed sidebar, click the **SpaceAccentBadge** (the coloured circle replacing the logo) to cycle to the next space.
- **Manage spaces** — in **Settings › Spaces**, also reached from *Manage spaces…* (last item in the SpaceSwitcher dropdown).
- **Create a new space** — use the create form in Settings › Spaces. Pick a name and an accent colour.
- **Rename a space** — inline edit in Settings › Spaces.
- **Change a space's accent colour** — pick a swatch (emerald, blue, violet, amber, rose, slate) in Settings › Spaces. The colour shows up in the sidebar header, the top stripe, the badge in collapsed mode, and the OS window title.
- **Choose the space Agaric opens in** — *Open on launch* in Settings › Spaces: *Last used* (the default) keeps the space you were in, or pick one space. It is per device, like the active space. Deleting that space sets it back to *Last used*; when the active space disappears, Agaric falls back to it before the first space alphabetically.
- **Set the space's journal template** — the journal's *Configure journal template* button opens the space's journal template page. When the space has none, it lists the space's template pages to pick from, plus *New journal template*. New daily pages in that space get a copy of the template page's blocks, nesting included. The page kebab's *Set as journal template* does the same from the page.
- **Delete a space** — only available when the space contains no live pages (and never for the last remaining space). Confirmation required. To delete a non-empty space: first use *Move to space* on each page (or batch-move from the Pages view), then return to Settings › Spaces and delete.
- **Move a page between spaces** — open the page's **PageHeaderMenu** (kebab) → *Move to space* → pick the destination. The editor navigates back (the moved page is no longer valid in the origin space); the active space does **not** switch to follow the page. Stale references left behind in the origin space — an old tab still holding the page, or its *Recently visited* entry — heal lazily: following one shows a soft *"This page was moved to another space"* notice, drops the stale entry, and lands you back on a valid view instead of raising an error.

## What the user sees

- **Sidebar header**: the active space's name (replaces the static "Agaric" branding).
- **SpaceAccentBadge** (collapsed sidebar): coloured circle with the space's first letter on its accent fill.
- **2 px top stripe** in the space's accent colour across the top of the window.
- **OS window title**: `<Page or View> · <SpaceName> · Agaric`.
- **Hotkey hints** (e.g. `Ctrl+1` / `⌘1`) on the first nine rows of the SpaceSwitcher dropdown.

## Scoping rules

When you switch spaces, you re-scope:

| Surface | Scoped to active space |
| --- | --- |
| Sidebar nav (each tab persists per space) | yes |
| Search results | yes |
| Pages browser | yes |
| Tags view + tag filter panel | yes |
| Agenda (all panels: filter, sort, group, projection, Due, Done) | yes |
| Backlinks (linked + unlinked) + filter dimensions | yes |
| History view | yes |
| Templates view | yes |
| Journal — date, mode, content | yes (each space has its own daily / weekly / monthly cursor) |
| Recent pages strip | yes |
| Cross-space links | not followed — see below |

## Cross-space links

A `[[link]]` whose target lives in a different space **does not navigate** — it renders as a broken-link chip with the tooltip *"Broken link or in another space — click to remove"*. The chip is undo-friendly: clicking removes the reference; `Ctrl+Z` restores it. This is enforced at write time too, so a future cross-space link cannot be added by accident.

## Seeded spaces

Fresh installs come with two spaces: **Personal** and **Work**. Both are seeded on first boot; rename them or create more in Settings › Spaces.

If you opened Agaric before spaces existed, your existing pages migrated automatically: pages created before a fixed cut-off moved to **Work**, and everything from the cut-off onwards stayed in **Personal**. The migration is one-shot, idempotent, and time-gated so subsequent boots don't move new pages around.

## Per-space integrations

- **Journal & journal template** — fully per-space.
- **MCP / agents** — agents see every space and can scope their tool calls; see [agent-access.md](agent-access.md).

## Pitfalls to know

- **The active space dictates `Ctrl+1`…`Ctrl+9` mapping.** The first space alphabetically is `Ctrl+1`, etc. Adding or renaming a space can change the hotkey order.
- **Deletion is guarded.** Even if the UI shows the *Delete* button enabled in a race, the backend rejects deleting a non-empty space. Move the pages out first.
- **`Move to space` is the only safe cross-space move.** Direct property edits on `space` can leave broken links — use the kebab menu action.
- **Templates apply at journal-page creation time only.** Editing the journal template page later doesn't retroactively fill past daily pages.
