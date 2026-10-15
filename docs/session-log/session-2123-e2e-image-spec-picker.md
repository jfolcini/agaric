# Session 2123 — The image spec's stray click opened the date picker

`e2e-tauri/attachment-image-render.e2e.ts` (#5365, #5575) passed three
times and failed three times on two PRs that touch no frontend code. In two
failures a modal "Date picker" covered the sidebar. In the third, the
picker's input held the last character of the marker being typed.

The cause is in the helper, not the product. `typeVerified` clicked the
centre of the block editor before typing. After End and Enter, the new
editor is still moving down while the rows above settle: the pasted image's
static render resolves its bytes, and the attachment badge mounts. A centre
computed during that shift lands on the formatting toolbar's "Set due date"
button, which opens `BlockDatePicker`.

Reproduced on the mock lane by recording the centres WebDriver could compute
during the shift and clicking them once the layout settled. Two of them hit
"Set due date" and opened the dialog.

The fix: `typeVerified` clicks to focus only when the editor does not already
have focus, both before typing and before a retry's select-all. After
`enterBlankSibling` the caret is already in the new block, so nothing clicks.
The spec's image-decode wait came from an earlier wrong theory of the same
race (dropped keystrokes) and is deleted.

Ran: `npm run typecheck:e2e-tauri`, `npx vitest run e2e-tauri`, oxlint,
oxfmt. The real-backend lane runs only in CI; `e2e-tauri-weekly` is
dispatched on the branch to confirm it.
