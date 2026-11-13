# Session 3964 — Copy app link in the page menu

`Refs #6555` (the "Page menu: Copy app link" item).

The page kebab gains *Copy app link*: it writes `agaric://page/<ULID>` through `@/lib/clipboard`
and confirms with a toast, or says so when the clipboard write fails. No Rust: `parse_deep_link`
and the frontend's `dispatchLaunchUrl` already accept that shape. A vitest round trip passes the
copied string through `dispatchLaunchUrl` and checks the tabs store, so a change to the URL shape
or to the router's `page` host goes red.

Decisions and traps:

- The row sits at the top, beside *Open in new tab*. Below *Export as Markdown* it moved the rows
  that `e2e/page-source-edit.spec.ts` ("a tap on the buffer while the page menu closes") taps
  through on a phone sheet, and an existing spec is the contract.
- The lucide mocks in `PageHeader.test.tsx` and `PageHeaderMenu.test.tsx` list icons one by one,
  so a new menu icon needs a mock line; `Link` was reused. It is also *Add alias*'s icon, two
  groups further down.
- `onCopyAppLink` is optional, as `onEditSource`, `onOpenHistory` and `onOpenInNewTab` are, though
  `PageHeader` always passes it: required, the row would show in every `PageHeaderMenu.test.tsx`
  render and break that file's menu-item counts and first-focus assertions. It lifts
  `PageHeaderMenu` past oxlint's warn-level complexity limit.
- A test pins the row in the arrow-key order, which is a hand-kept list beside the render.
- Android does not register `agaric://`, so a link copied on a phone opens only on a desktop. The
  row still shows there; raised with the maintainer.

Ran: the full vitest suite, typecheck, oxlint, every pre-commit hook and the manual stage, and the
Playwright specs `just e2e-related` selected; `bookmarked-pages.spec.ts:180` and
`meeting-attachments.spec.ts:124` fail there with this change reverted too. The page actions sheet
at 360x640 reaches its height cap and scrolls to *Delete page*. The WebdriverIO selections were
left to CI.
