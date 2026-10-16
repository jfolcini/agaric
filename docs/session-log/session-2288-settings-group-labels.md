# Session 2288 — Settings group labels read as headers

The maintainer: the rail's group names (Workspace, Integrations, Data & sync,
Help) looked smaller than the tab names, and that did not look good. They
used the app's section-label style (`text-xs font-medium
text-muted-foreground`), the same colour and weight as the muted tabs below
them, only smaller. So each label read as an undersized tab. Of three
options (same size and stronger, a small-caps eyebrow, or no labels), the
maintainer chose same size and stronger.

**Change.** In the rail, the labels are `text-sm font-semibold
text-foreground`; the tabs are unchanged and stay muted until selected. The
phone's tab `<Select>` renders the same groups through `SelectLabel`, and
gets the same classes at that call site only. The shared primitive is
untouched. The rail's accessibility structure is unchanged:
`role="presentation"` labels, each tab's `aria-describedby`, and a flat
tablist.

Screenshots at desktop and phone width, light and dark, show the labels
clearly heavier than the tabs, with the existing spacing still reading well.
With the labels this prominent, the Help group holding a tab also named Help
stands out. It is left for the maintainer.

Gates: the settings vitest files with their axe audits (414), `npm run
typecheck`, oxlint, oxfmt, and the settings Playwright specs (20).
