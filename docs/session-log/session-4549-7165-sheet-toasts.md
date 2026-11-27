# Session 4549 — #7165 U9: toasts show at the top while a phone's bottom sheet is open

A failed Quick capture keeps its sheet open and raises an error toast; on a phone that toast landed on the sheet's Cancel / Capture buttons, where the retry is tapped. The maintainer decided that while any bottom sheet is open on a phone, toasts go to the top: the header is under the scrim then, so the reason for bottom toasts (#5931) does not hold.

**Signal**

- `SheetContent` renders a `BottomSheetMark` inside the Radix Content when `side === 'bottom'`. Radix mounts the Content only while the sheet is open or playing its exit, so the mark's mount lifetime is the sheet's time on screen. It counts into a module-level number read through `useSyncExternalStore` (`useBottomSheetOpen`, exported from `ui/sheet.tsx`). A count, not a flag, so stacked sheets (Welcome under Quick capture on first run) and a sheet opening while another exits keep it right. No store was added.
- Every phone bottom sheet goes through `SheetContent side="bottom"`: `useDialogOrSheet` (Quick capture, New page, …), `MenuSheet`, the phone `Popover` sheet (date picker), the search sheet, the property drawer. Side sheets (the nav drawer) and desktop dialogs do not count.

**Placement**

- `AppToaster` switches to `top-left` with `top: 0.5rem + safe-area-top` and 1rem gutters both sides, keyed on `usePhoneLayout() && useBottomSheetOpen()`. `usePhoneLayout` is the gate the toaster's phone branch already used and the one that picks bottom sheets, rather than the brief's `useIsTouch() && useIsMobile()`.
- The toast sits over the scrimmed header, which a tall sheet never covers (it stops at `--phone-header-h`). Right offset 1rem leaves the R15 width rule (`index.css`) giving the full width.
- Sonner groups toasts that carry no position of their own under the toaster's, so a toast already showing jumps to the new edge when a sheet opens or closes.

**Verification**

- `e2e/phone-bottom-sheets.spec.ts` "a toast raised while a sheet is open sits above it, then at the bottom once it closes": red with the top branch disabled (toast at y 770 against sheet top 533) and red with the mark never decrementing (the toast stayed at the top after close).
- `sheet.test.tsx` `useBottomSheetOpen`: red with the count replaced by a flag (stacked case) and with the side gate removed (side-sheet case).
- `npm run typecheck`, `just check-fe`, `just e2e-related --range origin/main...HEAD --run`. Screenshots, before and after, both themes: Pixel 7 failed capture, a toast over the search sheet, a toast after close, desktop (pixel-identical before and after).
