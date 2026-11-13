# Session 3980 — Save as Markdown file in the page menu

`Refs #6546` (the "Page menu: Save as Markdown file" item; the two Android items stay open).

The page kebab gains *Save as Markdown file* beside *Export as Markdown*. It saves what the copy
takes, `pageMarkdownForCopy`, through `downloadBlob` as `<title>.md`, with `/` and the characters
Windows rejects made `_`, and the title cut to 200 bytes on a character boundary, as the mirror
cuts a name: WebKitGTK writes no file under a name past 255 bytes. No Rust: the browser download
path is the one "Export this space" and the bug-report ZIP already use. The mock-lane spec reads
the downloaded file's bytes. The copy row now wears the copy icon and the file row the download
icon, as in the diagram viewer.

Decisions and traps:

- The row is absent on Android, where the WebView saves no `blob:` download. It shows on a touch
  phone, which in a release is an Android one. On the iPhone 13 emulation its row makes the
  page-actions sheet overflow by one row, and `e2e/page-source-edit.spec.ts` ("keeps its rows in
  place while it closes") went red: its click landed while the sheet still slid in and scrolled
  the list to reach the row. The spec now waits for the slide to end, as its neighbour does, and
  still goes red when the sheet drops rows while closing.
- `onSaveMarkdownFile` is optional because `PageHeader` really omits it on Android.
  `PageHeaderMenu`'s oxlint complexity warning grows with it.
- The label has no ellipsis: no dialog asks anything. The toast says "to Downloads", as the
  bug-report toast does; WebKitGTK and WebView2 save there with no download handler.
- The mock-lane spec reads the clipboard only once the copy's toast shows: the copy lands after
  an IPC round trip, and under load the read came back empty.
- `e2e/page-mode-bubbles.spec.ts` ("image dialog") failed once under load for two different
  builders tonight and passed alone each time.

Ran: the full vitest suite, typecheck, lint, every prek hook in both stages, and the Playwright
specs `just e2e-related` selected. The WebdriverIO selections were left to CI.
