# Session 4434 — Unfinished tasks into the Due panel, the journal template in Settings, one button height on a phone

**Ask.** The maintainer's third pass over the UI review (#7040), after session 4426:

- "Unfinished tasks" at the top of today's journal looks redundant beside the task panels; move what is not duplicate into them.
- No drag handle on a phone, ever.
- Toasts beside the floating capture button, not above it.
- Buttons in one height, especially on a phone, with fewer button types.
- The journal template menu belongs in Settings, not the journal header.

**Shipped.**
- **Scheduled earlier.** "Unfinished tasks" listed open tasks whose due or scheduled date had passed. The Due panel's Overdue already listed every past-due one, so only the open tasks scheduled before today and not yet due were its own. Those are now a *Scheduled earlier* section under Overdue, dated by their scheduled date with *(Xd ago)*. They come from the same `list_unfinished_tasks` IPC, so no backend command is left without a caller. `UnfinishedTasks`, its tests and its strings are gone.
- **Journal template.** It is now Settings › General › *Journal template*: a select of the space's template pages and *None*, *Open*, and *New journal template*. Picking one unmarks the one before, which the journal's menu never did, so the space keeps one. The journal header's ⋮ and the day sheet's template rows are gone.
- **Drag handles.**
  - The sheets' grab bar came out in PR #7052, where review had caught a sheet pulled shut reopening shifted down; `usePullToDismiss` went with it.
  - Page mode's grip is hidden on a phone. A finger sliding over a block moved a pointer there and brought it.
- **Toasts.** A phone's toast sits on the capture button's bottom line, ending 0.5 rem left of it, and rises above the keyboard toolbar when that is pinned. Sonner sizes a phone toast as the screen less twice its left offset; `index.css` makes it honour the right offset.
- **One button height.**
  - **Before:** three text sizes (`sm` 193 uses, `default` 72, `xs` 69); `lg` and `icon-lg` unused; 21 call sites setting `h-7` and 28 setting `text-xs`; select triggers and text buttons at 32, 36, 40 and 44 px on touch.
  - **Now on a fine pointer:** text buttons are 28 (`xs`, which took over the `h-7` overrides), 32 and 36 px.
  - **Now on a coarse pointer:** every text size, a select trigger and a segmented toggle paint 36 px, with the 44 px target invisible. Inputs keep 44 px, since an input can carry no hit area.
  - `lg`, `icon-lg` and the call-site height overrides are gone. A pairing button's `touch-target` went too, since it painted a 44 px box.

**Ran.**
- `npm run typecheck`, oxlint, and the whole vitest suite.
- Playwright on the mock: the agenda, journal, phone, mobile, touch, settings, templates, sheet, menu and pairing specs.
- **Shown red:**
  - the Settings row's None test, with the old template left marked;
  - the scheduled-earlier hook test, with past-due tasks let through;
  - the toast placement, with sonner's width back;
  - the page-mode grip, with its phone rule removed;
  - the sheet's no-grab-bar check, with a handle element put back.
