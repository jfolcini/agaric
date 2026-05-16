# UI improvement ideas — 2026-05-16

> Captured during the `docs/UI-MAP.md` + `docs/UX.md` rewrite work. Independently actionable; each entry is a candidate for a future REVIEW-LATER ticket or a session task. Not yet scheduled.

## Wiring gaps

- **Properties tab in Settings is half-wired.** The `settings.tabProperties` i18n key exists but `SettingsView` never branches on `activeTab === 'properties'`. Either finish the tab branch + nav-item or drop the orphan key.
- **Properties view has no sidebar entry.** `nav-items.ts` doesn't list it; only reachable from internal nav state. If still supported, add a nav item; if not, fold into Settings or remove.

## UX consistency

- **Toast deduplication missing.** sonner doesn't dedupe by default and `notify()` doesn't either. Rapid identical errors (e.g. sync loops) stack visibly. Thread a dedup helper into `notify()` or use sonner's `id` field for known recurring error categories.
- **`MenuPopoverContent` adoption is partial.** Some popovers still use plain `PopoverContent` for menu surfaces. Grep + sweep would tighten consistency.
- **Toast action signature inconsistency.** Some call sites use raw sonner options; others wrap with `t()`-keyed text. Standardise on `notify.error(msg, { action: { label, onClick } })` and add a `notify.retry()` helper.

## Discoverability

- **`agaric://` deep-link scheme is undiscoverable.** Power users don't know it exists. A "Deep links" section in the `KeyboardShortcuts` panel listing `/block/<id>`, `/page/<id>`, `/settings/<tab>` surfaces a hidden feature.
- **Quick-capture hotkey is OS-global but unannounced.** Consider a one-time welcome-modal mention or settings tooltip.

## Mobile / responsive

- **Sidebar resize toggle appears clickable on mobile but is a no-op.** Either hide the toggle on mobile or match the affordance to behaviour.

## Maintenance / tooling

- **No CI lint catches doc-vs-code drift.** Many doc-audit findings would be auto-caught by a script that greps `src/...` paths in `docs/` against the filesystem and fails CI on miss. Low cost, high leverage.
- **JSDoc i18n drift.** Some component JSDoc comments reference English strings since moved into `t()` calls. Not user-facing, but agents reading JSDoc may infer wrong UI text. Low priority.

## Convention documentation

- **`max-sm:` vs `[@media(pointer:coarse)]` divergence is intentional but invisible.** Now documented in `docs/UX.md`. Consider linking from inline code comments where the convention is exercised so future maintainers don't try to "unify".
