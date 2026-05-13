# ScrollArea — thinner bar + hover-reveal default

> Status: ready for review.
> Triggered by: the horizontal scrollbar on Settings tabs / TabBar / any `ScrollArea orientation="horizontal"` overlays the bottom of the row's buttons. Same problem on the vertical side (10 px-wide bar overlays the right edge of every scrollable list). Fix the primitive once; every consumer benefits.

## What's broken

`src/components/ui/scroll-area.tsx:90-96` defines the scrollbar dimensions:

```ts
orientation === 'vertical' &&
  'h-full w-2.5 border-l border-l-transparent [@media(pointer:coarse)]:w-4',
orientation === 'horizontal' &&
  'h-2.5 flex-col border-t border-t-transparent [@media(pointer:coarse)]:h-4',
```

10 px (desktop) / 16 px (touch). Radix renders the `ScrollAreaScrollbar` **absolutely-positioned over the viewport content** — there's no reserved gutter — so the bar overlays the bottom (horizontal) or right (vertical) edge of whatever's inside.

The visible damage:

- **TabBar** (`src/components/TabBar.tsx:192`): horizontal bar covers the bottom of the open-document tabs.
- **Settings tabs** (`src/components/SettingsView.tsx:158`, just landed in `a181e4a6`): horizontal bar covers the active-tab underline.
- **Any vertical list** (PageBrowser, PairingDialog, dozens of others — 39 `<ScrollArea>` call sites total): vertical bar covers the right edge of row content.
- **On touch (16 px)**: the bar overlays half the height of a 32 px button — almost unusable on a phone.

Per a session 2026-05-14 conversation the user explicitly noted this for the Settings tabs / "breadcrumbs" row. Confirmed by inspecting the primitive and consumer sites.

The default Radix behaviour (no `type` prop set) shows the scrollbar continuously when overflow is present — see the call sites: only the unit test passes `type="always"`; nothing in production overrides it (`grep -rn 'type="hover"\|type="scroll"\|type="auto"\|type="always"' src/` returns one match, in the test file).

## The fix

Two changes to `src/components/ui/scroll-area.tsx`. Both are primitive-level; consumers don't change.

### 1. Make the scrollbar thinner

Drop the desktop bar from 10 px → 4 px and the touch bar from 16 px → 8 px:

```diff
       orientation === 'vertical' &&
-        'h-full w-2.5 border-l border-l-transparent [@media(pointer:coarse)]:w-4',
+        'h-full w-1 border-l border-l-transparent [@media(pointer:coarse)]:w-2',
       orientation === 'horizontal' &&
-        'h-2.5 flex-col border-t border-t-transparent [@media(pointer:coarse)]:h-4',
+        'h-1 flex-col border-t border-t-transparent [@media(pointer:coarse)]:h-2',
```

4 px reads as a hint rather than chrome. 8 px on touch is still reachable for drag (Material spec calls 6-8 px the practical minimum for touch scrollbars when you also support flick / wheel scrolling, which Radix does). The inner `ScrollAreaThumb` keeps `flex-1 rounded-full bg-border` — at 4 px the rounded thumb still looks intentional.

If 4 px feels too aggressive in practice (the user can't grab it precisely), step up to `w-1.5` / `h-1.5` (6 px). `w-px` / `h-px` is too thin — the thumb visually disappears.

### 2. Default `type="hover"` on the ScrollArea Root

```diff
 const ScrollArea = ({
   ref,
   className,
   children,
   orientation = 'vertical',
   viewportRef,
   viewportClassName,
   viewportProps,
   ...props
 }: ScrollAreaProps) => {
   return (
     <ScrollAreaPrimitive.Root
       ref={ref}
       data-slot="scroll-area"
+      type="hover"
       className={cn('relative overflow-hidden', className)}
       {...props}
     >
```

Radix's `type="hover"` shows the scrollbar only when the pointer is over the area, with a short delay. When the user isn't touching the surface, there's no overlay at all. Because we spread `{...props}` AFTER `type="hover"`, any consumer that wants the old behaviour can pass `type="scroll"` or `type="always"` and it wins — the existing unit test (`src/components/ui/__tests__/scroll-area.test.tsx:148-175`) already does this with `type="always"` to force emission for assertion, and continues to work.

Touch users get nothing from `hover` (no hover state), but combined with (1) the static bar is only 8 px — not zero, but unobtrusive. Note: `type="hover"` on Radix ScrollArea does still surface the bar momentarily after a touch scroll, which is the intuitive native behaviour.

## Why bundle the two

The two changes solve the same complaint from different angles. Shipping (1) alone leaves a thin overlay that's still always visible on long lists. Shipping (2) alone keeps the chunky 10/16 px bar but only on hover — better, but still ugly when it does appear. Together: the bar is invisible at rest, and when revealed by hover/touch it's a hairline that doesn't hide content.

## Verification

- `npm run typecheck` — pure additive change.
- `npm run test -- scroll-area` — existing test passes (it uses `type="always"`, which still wins via the prop spread).
- `npm run test -- TabBar SettingsView PageBrowser PairingDialog` — these are the heaviest ScrollArea consumers. Tests query by `role` / `data-testid`, not by scrollbar geometry, so should pass unchanged.
- Manual sweep, in order of "most likely to expose a regression":
  - **TabBar** with 10+ open tabs → confirm bar appears on hover only and doesn't overlay the active tab's underline.
  - **Settings tabs** with the window narrowed → confirm same.
  - **PageBrowser** at typical vault size → confirm vertical bar doesn't sit on top of the row chrome.
  - **PairingDialog**, **BugReportDialog**, **PdfViewerDialog** → confirm dialogs with internal scroll still feel responsive.
  - **Touch device** (or DevTools touch simulation) → confirm the 8 px bar is reachable for drag and doesn't auto-hide when the user is mid-swipe.
- `npm run e2e` — no E2E should bind to scrollbar dimensions; do a quick visual sweep on the Playwright artefacts after the run if any look off.

## Cost / impact / risk

| Dimension | Notes |
| --- | --- |
| **Cost** | XS. ~30 min for the primitive edit, ~30 min for the manual sweep across the heaviest consumers. Total ≤ 1 hour. |
| **Impact** | Closes the "scrollbar overlays content" complaint everywhere, in one edit, for all 39 `ScrollArea` call sites. Removes a class of "I can't tell where the button ends and the scrollbar begins" papercuts that surface most on touch and on the recently-added horizontal scrollers (Settings tabs, TabBar). |
| **Risk** | Low. The primitive change is purely visual — no DOM structure changes, no role / aria changes, no test coverage changes. Risk concentrates in two spots: (a) the thumb at 4 px is harder to *grab* with a mouse for drag-scrolling; mitigation is the wheel/keyboard/swipe paths Radix already provides plus the touch step-up to 8 px; if it bites in practice, step up to `w-1.5`/`h-1.5`. (b) `type="hover"` hides the bar at rest, so users discovering "is this scrollable?" lose the visual cue; mitigation is that fade-out gradients or the row's natural cropped content already imply scrollability, plus the `auto`-hide is the native macOS / iOS behaviour users expect. |
| **Reversibility** | Trivial. Single-file revert. |

## Out of scope

- Reserving a static gutter via `pb-1.5` / `pr-1.5` on the viewport content (the rejected option (3) from the conversation). Adds 6 px to every scrollable region and doesn't compose well with consumers that already pad — strictly inferior to (1) + (2).
- Switching to a custom-rendered scrollbar (CSS `scrollbar-width: thin` + `::-webkit-scrollbar` rules). The Radix primitive is the codebase mandate (per AGENTS.md "always use ScrollArea") and gives keyboard / virtualisation guarantees that custom CSS can't.
- Per-orientation overrides of the new default (e.g. "horizontal stays always-visible because tab strips need a discoverability cue"). Re-open if a specific consumer regresses; until then the default applies uniformly so the visual language stays consistent.
- Dropping the bar entirely on touch. Native iOS / Android scrollbars are similarly thin overlays and disappear when idle; matching that behaviour is the point.
