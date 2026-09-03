# Session 1493 — The last 64 floating promises in production code

`typescript(no-floating-promises)` is on in `.oxlintrc.json` but only fires under `oxlint --type-aware`, which
CI runs and the pre-commit hook does not, so the diagnostics accumulated: 120 across the tree, 64 of them in
production files. #4445 is the burndown of those 64. The 56 in test and script files stay — a floating promise
in a test is caught by the runner, and the two shapes want different fixes.

A floating promise is not automatically a bug. What makes it one is an unhandled rejection: the promise settles
`rejected`, nothing is listening, and the browser logs it with no user-facing trace. So each of the 64 was
resolved by opening its callee and asking who reports the failure, not by pattern. Three answers came back, and
each gets a different fix:

1. **The callee already reports it** — it toasts through `notify`, or calls `reportIpcError`, or its whole body
   is inside `try`/`catch`. There is nothing to add, and the fix is `void` plus one line naming the reporter, so
   the next reader does not re-derive it. 59 sites. A line that names no reporter — "Body catches and logs every
   failure, so this cannot reject." — only restates `void`, so those seven carry the `void` and no comment.
2. **The chain is already terminal, but the wrapper hands its callers a promise anyway** — one site:
   `use-block-dnd.ts:393` ends in a `.catch` that predates this diff, so no rejection ever went unhandled; what
   tripped the lint is that all four callers dropped the promise it returned. The fix is in the function — it
   returns `void` now — not at the call sites, and not the `void` operator on the chain itself: a chain ending in
   `.catch(handler)` is already handled, as `PageBrowserBatchToolbar.tsx:190` and a dozen bare `.catch` statements
   elsewhere rely on.
3. **The promise cannot reject** — `i18n.init` with `options.resources` set: i18next 26.4.0's `dist/esm` settles
   its deferred only through `deferred.resolve(t)`; `deferred.reject` does not appear in the file. A `.catch`
   there is a branch no production change can reach, so `void` with the version-pinned reason is the honest fix.

Reading the call sites for answer 1 turned up one that was wrong. `BootGate`'s Retry button set `retrying` and
dropped `boot()`, clearing the flag from a `useEffect` on `state` — but a hard boot failure re-`set`s the *same*
`error` state, so a second failure changes nothing for that effect to observe and the button stays disabled,
spinner and all, until the app is restarted. `useBootStore.boot`'s own doc says it returns a promise "so the
BootGate retry button can `await` the transition and gate its disabled-during-refresh UI on it"; it now does
(`void boot().finally(…)`), and the effect that stood in for it is gone. The existing test covered only the arm
where the state leaves `error`; the reject arm is now pinned too, and shown red against a copy of the shipped
shape.

The `void` sites are 59 different callees, so the repetition is in the justification and not in the code; a
`fireAndForget()` wrapper would hide which callee owns the reporting and still need the per-site line. Where a
real repeat did exist — five `applyDate` calls in `DateChipEditor` — one block comment covers them all.

One test: `EmojiPicker.loading.test.tsx` gains the reject arm of a pair whose resolve arm it already had.
`loadEmojiDataset()` is a dynamic `import()`, so a chunk fetch failure genuinely rejects; the test asserts the
`.catch` logs with its exact message. Falsified twice against a copy — removing the `.catch` reds it through the
runner's unhandled-rejection surface, and changing the message reds the argument assertion — restored
`cmp`-identical each time.

Measured, both trees built from source rather than taken from a claim: `oxlint --type-aware` reports **120**
`no-floating-promises` at `HEAD` (64 production, 56 test) and **56** after (0 production, 56 test), with total
diagnostics unchanged at 477. `npm run typecheck` exit 0; the 100 vitest files covering the touched modules run
2,925 tests green; `oxfmt --check` clean over all 34 changed files.

Two pre-existing defects surfaced while reading. `PagePropertyTable` omitted `usePropertySave`'s `logTag` where
`BlockPropertyDrawer` supplies it, so a failed page-property save toasted but wrote no structured log — one line,
so it is fixed here rather than described. The other is not: `AttachmentList.tsx:71` fires a success toast
unconditionally after `void handleDeleteAttachment(...)`, so a failed delete shows an error and a success toast
together. That one needs a behaviour change in `useBlockAttachments`, where the success arm is, and a test of its
own — #4626.
