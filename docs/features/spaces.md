<!-- markdownlint-disable MD060 -->
# Spaces

A **space** is a user-defined context that groups pages — typical setups are *Personal* and *Work*, but you can create more. Every page belongs to exactly one space; switching the active space re-scopes everything you see: lists, search results, agenda, backlinks, tabs, recent pages, the journal, even the OS window title.

## What you can do

- **Switch space** — pick from the dropdown at the top of the sidebar (the `SpaceSwitcher`).
- **Switch by index** — `Ctrl+1` through `Ctrl+9` (or `⌘1`–`⌘9` on macOS) jump to the first nine spaces alphabetically. The shortcut hint appears on each dropdown row.
- **Cycle the active space** — on a collapsed sidebar, click the **SpaceAccentBadge** (the coloured circle replacing the logo) to cycle to the next space.
- **Create a new space** — open *Manage Spaces…* (last item in the SpaceSwitcher dropdown) → use the create form. Pick a name and an accent colour.
- **Rename a space** — inline edit in the *Manage Spaces…* dialog.
- **Change a space's accent colour** — pick from seven swatches (emerald, blue, violet, amber, rose, slate, orange) in *Manage Spaces…*. The colour shows up in the sidebar header, the 3 px top stripe, the badge in collapsed mode, and the OS window title.
- **Set a per-space journal template** — paste markdown into the *Journal template* textarea inside *Manage Spaces…*. New daily pages in that space are pre-populated with the template's child blocks.
- **Delete a space** — only available when the space contains no live pages (and never for the last remaining space). Confirmation required. To delete a non-empty space: first use *Move to space* on each page (or batch-move from the Pages view), then return to *Manage Spaces…* and delete.
- **Move a page between spaces** — open the page's **PageHeaderMenu** (kebab) → *Move to space* → pick the destination.

## What the user sees

- **Sidebar header**: the active space's name (replaces the static "Agaric" branding).
- **SpaceAccentBadge** (collapsed sidebar): coloured circle with the space's first letter on its accent fill.
- **3 px top stripe** in the space's accent colour across the top of the window.
- **OS window title**: `<SpaceName> · Agaric`.
- **Onboarding banner** in *Manage Spaces…* while you still have only the seeded Personal / Work spaces.
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
| History view | yes (toggle to *All spaces* via switch in the filter bar) |
| Templates view | yes |
| Journal — date, mode, content | yes (each space has its own daily / weekly / monthly cursor) |
| Recent pages strip | yes |
| Cross-space links | not followed — see below |

## Cross-space links

A `[[link]]` whose target lives in a different space **does not navigate** — it renders as a broken-link chip with the tooltip *"Broken link or in another space — click to remove"*. The chip is undo-friendly: clicking removes the reference; `Ctrl+Z` restores it. This is enforced at write time too, so a future cross-space link cannot be added by accident.

## Seeded spaces & onboarding

Fresh installs come with two spaces: **Personal** and **Work**. Both are seeded on first boot. The onboarding banner in *Manage Spaces…* nudges you to either rename them or create more, then dismisses on first edit.

If you opened Agaric before spaces existed, your existing pages migrated automatically: pages created up to a fixed date land in **Personal**; everything later lands in **Work**. The migration is one-shot, idempotent, and time-gated so subsequent boots don't move new pages around.

## Per-space integrations

- **Journal & journal template** — fully per-space.
- **MCP / agents** — agents see every space and can scope their tool calls; see [agent-access.md](agent-access.md).

## Pitfalls to know

- **The active space dictates `Ctrl+1`…`Ctrl+9` mapping.** The first space alphabetically is `Ctrl+1`, etc. Adding or renaming a space can change the hotkey order.
- **Deletion is guarded.** Even if the UI shows the *Delete* button enabled in a race, the backend rejects deleting a non-empty space. Move the pages out first.
- **`Move to space` is the only safe cross-space move.** Direct property edits on `space` can leave broken links — use the kebab menu action.
- **Templates apply at journal-page creation time only.** Editing a space's template later doesn't retroactively fill past daily pages.
