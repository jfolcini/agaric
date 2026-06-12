# Session 1005 — #921 f2/f3 + #925 f1 (keyboard editing)

Verified-or-fixed three keyboard-editing findings (much was already on main).

- **#921 f3** (Ctrl/Alt/Meta+Arrow at boundary navigates) — already on main
  (`use-block-keyboard.ts:276-309` carries `!ctrlKey && !metaKey && !altKey` guards) with
  tests; verified, no change.
- **#921 f2** (Backspace-at-start merge concatenated raw markdown → mangled markup) — **fixed**:
  new pure helpers `stripLeadingBlockMarker()` + `joinMergedContent()` in
  `useBlockKeyboardHandlers.ts`. On a paragraph join, a single leading block-construct
  marker (heading/blockquote/bullet incl. task list/ordered) is stripped from the current
  block's FIRST line only before concat, so the joined-in text stays inline and can't
  re-parse as a new list item/heading. Plain text + interior lines + inline marks untouched;
  verbatim carry-over when prev is empty. Tests: `foo`+`- bar`→`foobar` (no list), `foo`+`# h`
  →`fooh`, `foo`+`bar`→`foobar`.
- **#925 f1** (keyCode 229 / Gboard path untested) — **tests added**: dispatch
  `keydown {keyCode:229}` → asserts the keydown is swallowed (the #915 fallback) and the
  follow-up `beforeinput` drives delete/merge/split.

Verification: `vitest` use-block-keyboard.test.ts (79) + useBlockKeyboardHandlers.test.ts (63)
green; `tsc -b` clean.
