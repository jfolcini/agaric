# Session 3326 — the Animations setting reaches every overlay

Part 2 of the maintainer's ask: micro-animations whose speed the Settings › Appearance › Animations setting controls. The audit found the setting did not reach most motion already in the app. The repo's `@utility duration-*` set only `transition-duration`. tw-animate-css times `animate-in` / `animate-out` from `--tw-duration` with a fixed `.15s` fallback. So every Radix entry and exit (popover, select, tooltip, dialog, sheet) ran 150 ms at Full and at Fast alike, and a dialog's `duration-moderate` (200 ms) ran 150 ms. Every bare `transition-*` (every `Button`, checkbox, switch, chevron) ran Tailwind's fixed 150 ms. The "Open in new tab" context menu on page links had no entry animation, unlike the other menus.

`src/index.css` changes three things:
- the `duration-*` utilities also set `--tw-duration`;
- a base-layer rule gives any element carrying `animate-in` / `animate-out`, variants included (`data-[state=open]:animate-in` is not the class `.animate-in`), `--tw-duration: var(--duration-normal)`;
- `@theme` sets `--default-transition-duration: var(--duration-normal)`.

`--duration-normal` is 150 ms at Full, so nothing changes at Full except the dialogs and sheets, which now run the 200 ms their classes always asked for. `ContextMenuContent` takes the popover's fade and zoom. Off and reduced motion were already instant through the unlayered reset and stay so.

`e2e/motion-speed.spec.ts` reads computed durations at Full and Fast: a button's transition, a Select's list, the search dialog, and a page row's right-click menu. On `main` it failed at Fast (button 0.15s, not 0.075s) and at Full (dialog 0.15s, not 0.2s). With only the context menu reverted, its `animationName` was `none`. A first try of the base rule matched only `.animate-in`, and the Select list stayed at 0.15s on Fast until the selector took variant classes too.

Left as recommendations for the maintainer, not built: collapse and indent motion, sonner's own unscaled timing, the hard-coded 150 ms navigation beat in `App.tsx`, dnd-kit's default sortable transition.

Ran: `npm run typecheck`; vitest over `src/components/ui` and `src/components/common` (1097 tests); the new spec at Full and Fast.
