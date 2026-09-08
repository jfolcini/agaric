# Session 1617 — a top-level page read as a namespace child in the Pages list

The maintainer reported, against the running 0.10.0 AppImage, that a page
called `Nico` was showing up inside the `workstations/management`
namespace. It is not a data defect and there was nothing wrong with the
tree: the Pages list was drawing the hierarchy inverted.

## What the vault actually holds

Read from the live `notes.db` (copied to a scratch dir with its WAL, not
queried in place). The `Nico` page block carries the title `Nico` — no
slash, no parent, no alias, no `page_aliases` row. There is no
`management/workstations` namespace anywhere; the real ones are
`workstations/management` and `DevEx/workstations/{hardware,os,management,tooling}`.
So `buildPageTree` could not have placed `Nico` under anything, and a
screenshot of the running window confirmed the rows below `management`
were ordinary flat rows, not tree descendants.

## Root cause

The `Pages` section interleaves two row shapes drawn by different
components. A flat page row is `DensityRow`, which opens with a
multi-select checkbox and a star toggle; both are `opacity-0` until
hover but keep their layout width, so the row's content starts 76 px in
(`px-3` + `size-4` + `gap-3` + `size-6` + `gap-3`). A namespace subtree
is `PageTreeItem`, which has neither affordance and indents purely by
depth — 0 px at a root, 28 px one level down.

A page nested one level inside a namespace therefore sat 48 px LEFT of
every top-level page. Read top to bottom, each flat row after a
namespace root looks like a child of it. `Nico` was one of many:
`Santiago Zannini`, `onboarding`, `Selenium` and a run of journal dates
were all caught by the same effect in the same screenshot.

## What shipped

A `page-tree-gutter` utility in `src/index.css`, applied to the
`tree-page` row's gridcell in `PageBrowserRowRenderer`. It reserves the
same leading run the flat row spends on its checkbox and star, at both
pointer sizes — the coarse-pointer branch matters because those
affordances grow to 44 px each on touch, where the inversion would
otherwise survive on Android. Nothing about `buildPageTree`, the
grouping hook or `PageTreeItem` changed; the subtree just starts at the
gutter and keeps its relative depths.

The gutter is a hand-mirrored copy of DensityRow's leading run, so it
can drift. `e2e/pages-namespace-indent.spec.ts` is the pin: it seeds a
`work/project-a` page and measures real geometry, asserting the
namespace root's toggle starts at the same x as a flat row's content
(within 1 px) and that the nested title sits right of the flat title.
Both sides of the mirror redden it.

## Verification

Falsified twice, each against a `cp` backup restored and `cmp`-checked
in the same command. Removing the class alone fails the alignment
assertion by exactly 76 px, the computed gutter. Removing the class and
neutering that first assertion fails the second one at 230 px versus
278 px, so neither is carried by the other.

Then, with the fix in place: the new spec green; `pages-view`,
`starred-pages` and `mobile-overflow` green at 79 passed, with one
unrelated flake in the mobile empty-block-placeholder test that passed
on retry; 436 vitest tests across 23 files covering `PageBrowser`,
`PageTreeItem` and `page-tree`; `npm run typecheck` clean.

No `e2e-tauri/` spec. That lane exists because the JS mock is a second
implementation of the Rust backend, and a bug that shipped is one the
mock-backed estate could not see. This defect is layout in components
the mock never touches — the same React tree renders in both lanes — so
a real-backend spec would add a slower copy of the same measurement, not
a second source of truth. The Playwright spec runs per PR, which the
`e2e-tauri` lane does not until #4671.
