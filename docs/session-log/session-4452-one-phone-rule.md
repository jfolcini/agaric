# Session 4452 — one phone rule: `usePhoneLayout` decides the phone surfaces

Part of the #7040 UI review, item M1. The maintainer decided on 2026-11-25 that one hook picks the phone surfaces: a width under 768 px, or touch with a short screen. That is the sidebar's rule, so a phone in landscape gets them too. They also approved naming the hook in `AGENTS.md`.

**What shipped**

- **`usePhoneLayout()`** returns `useIsMobile() || (useIsTouch() && short screen)`. The sidebar's short-viewport query moved into it, and `use-sidebar-state` calls the hook.
- **Phone surfaces follow the hook:**
  - `useDialogOrSheet` and all its callers;
  - the block and page menus (menu sheet or dropdown);
  - the `side=` sheets: properties, history, outline, shortcuts and references;
  - the journal calendar, the emoji picker, the palette body and the toaster;
  - the agenda's results box.
- **The phone header and its touch-only layout** follow `useIsTouch() && usePhoneLayout()`. Every former `isTouch && isMobile` site moved together, so a narrow mouse window keeps its tab bar and history buttons, as `TabBar` intends.
- **`useShouldShowMobileChrome`** keeps its tablet term (touch without a keyboard under 1024 px). Its phone term is now the hook, so a landscape phone has the search-sheet trigger and the capture button.
- **Kept on touch alone:** finger affordances (toolbars, drag, swipe, gutter) and the soft-keyboard sheets in `BlockListItem` and `AddPropertyPopover`, which are not phone-surface choices.

**Decisions and traps**

- **"Short" is the screen, not the viewport:** `(max-device-height: 499px)`.
  - Since #6790 the Android soft keyboard shrinks the layout viewport. A tablet in landscape matched the old `max-height` query as soon as the keyboard opened, and flipped to the drawer.
  - Extended to dialogs, that flip remounted the new-page dialog mid-typing and dropped the text.
  - Not yet verified on a real Android WebView.
- **Landscape-phone specs must set `screen` as well as `viewport`.** Playwright's Desktop Chrome descriptor leaves a 1080 px screen.
- **False premises in the issue:**
  - A narrow mouse window has no day ⋮: it shows the inline Blocks | Page switch, like `PageHeader`.
  - Sonner's 600 px breakpoint was already neutralised by passing both offsets.
- **Left alone:** the Pages header stays on width, so a landscape phone gets its two-row form.

**Tests**

- `usePhoneLayout.test.ts`: a narrow mouse window, portrait and landscape phones, a tablet with the keyboard up, rotation. Each term was shown red by removing it, and by going back to `max-height`.
- `phone-bottom-sheets` gains a landscape phone at 915×412: the new-page sheet, shortcuts, header, block menu, page ⋮, toast and the absent recent-pages strip. It also gains a tablet whose keyboard shrinks the viewport. All were red on unchanged code.
- Width-only mutations at each site (E1–E22) were red.
- `mobile-drawer`'s short-screen test now sets `screen` as well as `viewport`.
- `just check-fe` passed. The phone, mobile, touch, sheet, menu, sidebar and dialog specs passed, and 19 bridge specs passed as local copies.
