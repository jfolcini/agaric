# Session 1948 — drop the Pages row-density control (#5372)

The Compact/Regular/Expanded "Row density" select cost a persisted key, a
field on every saved view, per-density branches in every row and a
virtualizer re-measure path, for little use. Maintainer decision: one row
layout, the old `regular`; rename `DensityRow` to `PageRow`.

What shipped:

- Deleted `usePageBrowserDensity`, the header select, the `density` prop,
  `data-density`, the compact and expanded branches, the density preference
  and type, and its i18n keys.
- `DensityRow.tsx` is now `PageRow.tsx`, with the `regular` classes
  unchanged; `estimateSize` returns `PAGE_ROW_HEIGHT` (44px, the
  virtualizer's starting estimate, corrected by `measureElement`).
- Saved views are `{ sort, filters }` and match on those two only. The schema
  version stays 1, so existing views survive, and a view stored with a stray
  `density` still loads, applies and shows as active.
- AGENTS.md "Pages view": the density rule is deleted and the row rule names
  `PageRow` (maintainer-approved). `docs/architecture/pages-view.md`,
  `docs/PAGES.md`, `README.md`, `docs/ARCHITECTURE.md` and
  `docs/architecture/frontend.md` follow.

Left as is: Rust doc comments in `commands/pages/metadata.rs` and
`agaric-store/src/filters/primitive.rs` still mention density; two are
copied into `bindings.ts`, so they go with a later backend doc PR.

Verified: the legacy-view test went red when matching compared `density`,
when the loader rejected views carrying it, and with the schema version
bumped; the row tests went red rendering every flag, the last flag, or
nothing (all on copies, restored and `cmp`-checked). Full vitest 20,781
passed; Playwright 69/69 on pages-view, pages-namespace-indent,
bookmarked-pages, trashed-page-recents and pages-filter; typecheck, knip,
oxlint and oxfmt clean.
