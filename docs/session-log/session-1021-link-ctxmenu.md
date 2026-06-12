# Session 1021 — 'Open link' block-context-menu item (#924 finding 1, secondary half)

Part of the "fix all UX backlog" pass (2026-06-12).

## Shipped

- **#924 f1 (context-menu half) — "Open link".** Ctrl/Cmd+Click already opens external links in
  the editor (#946); this adds the discoverable non-modifier path. The link-detection plumbing
  already existed (the "Copy URL" sibling: the right-click / long-press handlers in
  `useBlockTouchLongPress` detect `.external-link` under the trigger and thread its `href` to
  `BlockContextMenu` as `linkUrl`). Added the missing **"Open link"** action (`openUrl(href)`,
  toasts on failure) above the existing Copy-URL item; both are grouped and lead the menu when a
  link is under the trigger, and are absent otherwise.

## Tests

BlockContextMenu renders "Open link" only with a `linkUrl`, calls `openUrl` + closes, toasts on
failure, is first. 2962 touched-area tests green; `tsc -b` clean. New
`e2e/external-link-context-menu.spec.ts` (right-click link → Open link → `plugin:shell|open`
IPC; plain block offers no Open link) — verified 4/4 with `external-link-open`.

With this, **#924's finding 1 is fully done** (Ctrl/Cmd+Click + context-menu "Open link").
