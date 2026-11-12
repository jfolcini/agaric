# Session 3980 — Save as Markdown file in the page menu

`Refs #6546` (the "Page menu: Save as Markdown file" item; the two Android items stay open).

The page kebab gains *Save as Markdown file* on desktop. It saves what *Export as Markdown*
copies, `pageMarkdownForCopy`, through `downloadBlob` as `<title>.md`, with `/` and the characters
Windows rejects made `_`. No Rust: the browser download path is the one "Export this space" and
the bug-report ZIP already use. The mock-lane spec reads the downloaded file's bytes.

Decisions and traps:

- The row is absent on Android, where the WebView saves no `blob:` download, and on a touch phone.
  Any extra row overflows the iPhone 13 page-actions sheet; Playwright's click then scrolls it and
  `e2e/page-source-edit.spec.ts` ("keeps its rows in place while it closes") goes red, wherever
  the row is placed. When the Android save path lands the sheet needs room first.
- `onSaveMarkdownFile` is optional because `PageHeader` really omits it on Android and phones.
  `PageHeaderMenu`'s oxlint complexity warning grows with it.
- The label has no ellipsis: no dialog asks anything. The toast says "to Downloads", as the
  bug-report toast does.
- `e2e/page-mode-bubbles.spec.ts` ("image dialog") failed once under load for two different
  builders tonight and passed alone each time.

Ran: the pages, export and i18n vitest suites, typecheck, and the Playwright specs
`just e2e-related` selected. The WebdriverIO selections were left to CI.
