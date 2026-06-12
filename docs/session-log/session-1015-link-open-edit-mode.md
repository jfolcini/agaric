# Session 1015 — Open external links in edit mode (#924 finding 1)

Part of the overnight best-in-class UX pass (2026-06-11/12).

## Shipped

- **#924 finding 1 — external links are openable while editing.** The ExternalLink extension
  set `openOnClick:false` with a docstring claiming "links open on Ctrl+Click" — but the base
  `@tiptap/extension-link` registers NO click handler when `openOnClick` is false, so links
  were un-openable in edit mode (only the static render opened them). Added a `handleClick`
  plugin prop: a plain click still places the caret (so the link text stays editable), and a
  **Ctrl/Cmd+Click** opens the URL via `openUrl` (the Tauri shell plugin), matching the
  static render and VS Code's modifier-click convention.

## Tests

New `e2e/external-link-open.spec.ts`: Ctrl+Click opens (asserts the `plugin:shell|open` IPC
fires); a plain click does NOT open (places the caret). Deterministic 6/6 with
`--retries=0 --repeat-each=3`; the existing link-edit e2e (features-coverage) unaffected;
`tsc -b` clean.

## Deferred

The finding's secondary half — an 'Open link' item in the block context menu — is left as a
smaller follow-up (the Ctrl/Cmd+Click affordance is the primary fix and is now covered).
