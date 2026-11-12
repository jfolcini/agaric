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
  so a new menu icon needs a mock line; `Link` was reused.
- Android does not register `agaric://`, so a link copied on a phone opens only on a desktop. The
  row still shows there; raised with the maintainer.

Ran: the page header, deep-link router and i18n vitest suites, typecheck, and the Playwright specs
`just e2e-related` selected. The WebdriverIO selections were left to CI.
