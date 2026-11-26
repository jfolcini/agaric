# Session 4498 — reachable on touch: one hover-reveal utility, tap-to-open info, Settings' phone layout up to 768 px

Part of the #7040 UI review, items M10 and M3.

**What shipped**

- **`hover-reveal`**, a `@utility` in `src/index.css`. A control is shown at rest on any pointer but a fine one; on a fine pointer it appears when its `.group` is hovered or holds keyboard focus. It replaces the opacity-0 / group-hover / coarse-fallback recipe in RecentPagesGroup's bookmark toggle (hover-only with no touch fallback: the M10 bug), TagList, AttachmentList, PageTreeItem's delete and PageQuickActions. The bookmark toggle gains `touch-hit-area`, and a coarse right margin so the list's `overflow-x-hidden` stops clipping its 44 px target.
- **Tap-to-open info.** "Blocked by …" and a missing footnote's message were tooltip-only; on a phone the tap navigated instead. Both use `InfoPopover` (#6895), which gains an `icon` glyph (DependencyIndicator keeps its Link2) and keeps Enter and Space on its trigger from reaching the row around it: an agenda row's Enter handler cancelled the button's own activation.
- **M3.** Card's section variant and the phone type scale switch at 48rem, where `usePhoneLayout` already picks the phone rail; from 640 to 767 px a Settings card kept its box beside the phone section list.

**False premises in the issue**

- `InfoPopover` already existed; it is extended, not built.
- Card's `max-sm` matched nothing: the Settings rail switches in JS at 768 px, not at `sm`.
- The plain-`group` recipe had 11 copies, not about 12; the rest are named groups or other recipes the utility does not fit.

**Left as they are**

- PageRow's three copies (open PR #7119 owns the file); named-group copies (`group/image`, `group/diagram`), since the utility keys on a plain `.group`; the gutter and inline controls, which also reveal on `.block-active`.
- M3's 640 px `--indent-width` rule belongs to the S5 outline work.

**Tests**

- e2e (mock lane): new `touch-reachable-info` — on a phone the toggle shows at rest with a 44 px target and a tap bookmarks; a tap on the blocked indicator and on a missing footnote explains it; on a desktop the toggle hides at rest and shows on hover and keyboard focus; at 700 px a Settings card is flat with a 24 px title; at 1440 px it keeps its box.
- vitest: `info-popover` (Enter and Space stay out of a row), `DependencyIndicator` (a click opens "Blocked by: …"), `footnote` (the missing-footnote dialog, with axe).
- Shown red on the old code and each under one mutation: the utility's media widened, its hover or focus selector removed, the coarse margin removed, Card back on `max-sm`, the type scale back at 640 px, the trigger's key or click stop removed, the footnote without `InfoPopover`.
- **Edited to the new markup:** `card.test` (`max-sm:` → `max-md:`), `PageTreeItem.test` (four class checks → `hover-reveal`), `footnote.test` (hover tooltip → click dialog; the focus ring on the inner button).
