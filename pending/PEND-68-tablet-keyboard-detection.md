# PEND-68 — Tablet / hardware-keyboard detection for the mobile search sheet

> PEND-62 shipped the unified mobile search sheet with a single touch-only entry point (`SearchSheetTrigger`) gated on `useIsMobile() < 768 px`. That gate is correct for phones, but iPad-portrait (768 px) and tablet-with-keyboard cases sit in a UX dead zone: the icon doesn't render, and on a touch-only iPad there's no keyboard shortcut to fall back to either. This plan extends the gate with a hardware-keyboard probe so the right surface shows up on every device.

## TL;DR

- Today the search icon mounts only when `window.innerWidth < 768 px` (`src/hooks/useIsMobile.ts:3`).
- iPad portrait (768 px) and iPad with hardware keyboard both fail that check, so touch users on iPads have no entry point to in-page find via touch.
- The fix: when the viewport is wider than the phone breakpoint AND the device has no detectable hardware keyboard, still mount the sheet trigger so the user can reach the unified search surface.
- Acceptance criteria copy from PEND-62 Q4: "Detect a connected keyboard (`navigator.keyboard` API or just the existence of a hardware keyboard event) and prefer the desktop UI when present."

## Current state — verified

- `src/components/SearchSheetTrigger.tsx` — single-line `useIsMobile` check at the JSX-gating site (`src/App.tsx:482` — `{isMobile && <SearchSheetTrigger />}`).
- `src/hooks/useIsMobile.ts` — `MOBILE_BREAKPOINT = 768`. The hook is consumed in 20+ sites across the app; changing this breakpoint propagates everywhere.
- `useDialogOrSheet` already uses `useIsMobile` to swap Dialog ↔ Sheet — keeping that contract intact is a constraint.

## Design

### Detection strategy

Two signals, OR-combined:

1. **`navigator.keyboard.getLayoutMap()`** — Chromium-only (and behind permissions on some platforms). Returns `Promise<Map<string, string>>`; resolving means a layout is exposed → keyboard present. Safari falls through.
2. **First `keydown` event** — listen at `document` for the lifetime of the app; the first non-modifier keydown flips a `hasHardwareKeyboard` flag. This is the universal fallback; needs no permissions; one-shot listener.

The flag is sticky-true: once a keydown lands the user can be trusted to have a keyboard. It does NOT flip back to false on inactivity — a Bluetooth-keyboard user who briefly disconnects then types again would lose the desktop UI mid-session, which is jarring.

### Hook shape

```ts
function useHasHardwareKeyboard(): boolean {
  // Probe navigator.keyboard on mount; install a keydown listener; the
  // returned boolean is true the moment either signal fires.
}
```

`useIsMobile` itself stays single-purpose. A new sibling hook `useShouldShowMobileChrome()` composes both:

```ts
function useShouldShowMobileChrome(): boolean {
  const isMobile = useIsMobile()
  const hasKeyboard = useHasHardwareKeyboard()
  // Mobile phones always; tablets < 1024 px only when no keyboard
  // detected. Parenthesise the && precedence explicitly so a future
  // reader doesn't have to remember JS operator-precedence rules.
  return isMobile || (!hasKeyboard && window.innerWidth < 1024)
}
```

The tablet breakpoint at 1024 px catches iPad portrait (768) and landscape (1024-ish); above that, the device is desktop-shaped and the keyboard probe is the deciding factor anyway.

### Wiring

`SearchSheetTrigger`'s mount gate in `App.tsx` switches from `isMobile &&` to `shouldShowMobileChrome &&`. `useDialogOrSheet` keeps using `useIsMobile` directly — it's about layout, not entry-point discoverability.

## Open questions

1. **Should the probe also flip the Sheet vs Dialog swap?** Today `useDialogOrSheet('dialog')` swaps based purely on viewport. A keyboard-iPad in landscape would still get the Sheet shape; the user might prefer a centered Dialog. **Recommendation:** defer — the Sheet works fine on iPad too, the discoverability gap is the actual user complaint.
2. **Permissions UX for `navigator.keyboard`** — Chromium prompts on first call on some platforms. **Recommendation:** skip the explicit API; the first-keydown fallback is enough.
3. **What about an external pointer (mouse)?** A user with mouse + no keyboard wants the touch UI. The keydown probe handles this correctly; an `onmouseover` would not.

## Acceptance criteria

- iPad portrait at 768 px with NO hardware keyboard: trigger renders, sheet works on tap.
- iPad with attached keyboard: trigger does NOT render; Cmd+K still opens the palette via the existing shortcut.
- Phone at 390 px: trigger renders unconditionally (today's behavior).
- Desktop at 1280 px: trigger does NOT render (today's behavior).

## Out of scope

- Flipping `useDialogOrSheet`'s Sheet ↔ Dialog swap on hardware-keyboard tablets (open question Q1). The Sheet shape is fine on iPad; the discoverability gap is what users complain about.
- Detecting external pointer (mouse) state. The first-keydown probe naturally handles "mouse only, no keyboard" — the user with a mouse but no keyboard never fires a keydown so `hasKeyboard` stays `false`, which is the right outcome.

## Cost / impact

- **Cost:** S (~2-3 h). One new hook (`useHasHardwareKeyboard`, ~30 LOC) + one composite hook (`useShouldShowMobileChrome`, ~10 LOC) + one App.tsx gate-name swap. Tests: hook unit tests + a Playwright test at iPad-portrait viewport.
- **Impact:** Pure-touch iPad users gain the unified search entry point (currently a dead zone). No effect on phones (today's behavior) or laptop/desktop (today's behavior).
- **Risk:** Low. Single feature flag at one gate site; `useHasHardwareKeyboard` defaults to `false` until the first keydown lands, so the worst-case slip is "iPad shows the touch icon for a few seconds longer than ideal."

## Related

- PEND-62 (shipped) — introduced the touch-only trigger and the `< 768 px` gate.
- `src/hooks/useIsMobile.ts` — primary mobile detector; unchanged here.
- `src/hooks/useDialogOrSheet.ts` — consumes `useIsMobile`; out of scope for this plan.
