# Session 2777 — the pairing sheet on a phone, in dark mode

The maintainer said the pairing drawer looks bad on a phone in dark mode. Screenshots at 390×844 in dark and light, against the mock, showed five defects in the sheet's own content; the shared parts (the overlay that does not dim in dark, a tall sheet's top edge cutting through the header, the dark disabled primary Button) are a separate PR in `src/components/ui/`.

- The QR tile wrapped the backend's QR, which already paints its own white ground and quiet zone, in more white padding and a border that read as a dark line in dark mode. The padding is gone, the border shows only in light (the light popover is near white), and dark mode takes the glare off with `brightness-90`. The modules stay dark on a light ground, so it still scans.
- The "Scan QR code" tab wraps its "Recommended" badge to a second line on a phone (both labels need more width than a phone has), which left "Type passphrase" out of line. Both triggers now stretch to the same height and start their content at the top, so the labels and the underline share one line.
- The link above the OR divider stacked a margin on top of its 44 px touch height; the margin is gone.
- Each word input's placeholder repeated its visible label; the placeholders and their i18n key are gone. Specs select the inputs by `aria-label`, which stays.
- The sheet repeated the Settings page's empty "No paired devices yet." block. The list stays when there are peers, since it is where a device that was unpaired from the other side shows "pair again" (#4297); with none it renders nothing.

Suites run: vitest over `src/components/peers`, `src/components/dialogs` and `src/lib/i18n`; `npm run typecheck`; `npm run lint`; Playwright `pairing-sheet-phone.spec.ts` (new, both themes), `mobile-overflow`, `qr-scanner-camera`, `sync-ui` and `sync-pairing-flows`. Each new assertion was shown red by putting the old style back.
