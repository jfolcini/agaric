# Session 3385 — drop the deleted SearchablePopover from AGENTS.md and frontend.md

A note from the coordinator, approved by the maintainer for this one `AGENTS.md` entry. `SearchablePopover` no longer exists, but `AGENTS.md`'s shared-components row still listed it. It is now gone from that row. `docs/architecture/frontend.md` named it, and the also-deleted `RecentPagesStrip`, as roving-tabindex users. It now names `TabBar` alone, which `git ls-files` and `TabBar.tsx`'s `tabIndex` confirm. The archived session logs that mention both stay as written.

This was meant to ride #6316, which merged before the push, so it ships alone. Docs only, with no suites beyond the commit hooks.
