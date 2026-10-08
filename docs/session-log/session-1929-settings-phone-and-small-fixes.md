# Session 1929 — Settings on phones, and small Settings defects (#5344)

What shipped:

- **The tab rail on phones.** Below `sm`, the 11-tab rail stacked above the
  panel, so the panel started at y=682 on a 390×844 phone and a tab tap seemed
  to do nothing. A full-width `Select` grouped by section now replaces the rail
  there, and the panel starts at y=132. Its list fits the screen, so all 11 tabs
  show without scrolling. Rail tabs are 44px on coarse pointers.
- **44px dropdown options.** `SelectItem` gets `min-h-11` on coarse pointers.
  Every Select's options were 32px on touch. AGENTS.md asks for 44px, and the
  phone tab picker made Settings depend on it.
- **The quick-capture button covered the last control** after a full scroll,
  for example General's "Show tour". The main viewport now gets 9rem of bottom
  padding whenever that button shows: the same `useShouldShowMobileChrome`
  condition, the button's 5rem offset plus its 3.5rem size, plus a gap.
  - Graph is exempt. Its canvas is meant to run under the button, and the
    padding would have cut 128px off it.
  - The Pages list needs nothing extra: its last row ends 36px above the
    button.
- **Keyboard tab.** The nested `60dvh` scroll box is gone, so the list scrolls
  with the page.
- **Reminder time.** The input fits "09:00 AM" on touch (`w-40`).
- **Deadline copy.** The deadline setting's copy now says "the Agenda's Upcoming
  list" instead of "DuePanel", and the duplicate "0 = disabled" hint is gone.
- **Heading semantics.**
  - Five `<label>`s that named no control and acted as section titles are now
    `h3`: Notifications, Agent configuration, Connections, Recent activity, and
    Editor's allowed image domains. The issue listed four; review found the
    fifth.
  - The empty activity feed no longer adds an `h2`.

Left as is, with reasons:

- Settings jumps from the shell `h1` to these `h3`s, because `CardTitle` is a
  `div`. General already did this before this change, and the issue asked for
  `h3`.
- The test helper `openSettingsTab` clicks the rail tab when it is visible and
  uses the Select otherwise. The mobile-overflow sweep opens Settings tabs at
  both widths.

Verified:

- `npm run typecheck`.
- Full vitest: 871 files, 20 743 passed, 51 skipped, 1 expected fail.
- Playwright: 111 passed across settings-phone, settings, mobile-overflow,
  app-chrome, keyboard-customization, agent-access, properties-system,
  graph-view, sync-ui and editor-lifecycle.
- After the Select changes, the UI unit tests passed (36 files, 753 tests) and
  mobile-overflow passed (38).
- Every new e2e check went red against a reverted copy and was restored:
  - the picker panel position;
  - 44px rail tabs;
  - 44px options;
  - all options on screen;
  - the Show tour clearance;
  - the Graph exemption.
