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
   the next reader does not re-derive it. 59 sites.
2. **Nothing reports it, and the promise can reject** — one site: `use-block-dnd.ts:393` returned a promise all
   four of its callers dropped. That one is structural, and the fix is in the function, not at the call sites.
3. **The promise cannot reject** — `i18n.init` with `options.resources` set: i18next 26.4.0's `dist/esm` settles
   its deferred only through `deferred.resolve(t)`; `deferred.reject` does not appear in the file. A `.catch`
   there is a branch no production change can reach, so `void` with the version-pinned reason is the honest fix.

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

Two pre-existing defects surfaced while reading and are **not** fixed here, since neither is a floating promise:
`PagePropertyTable` omits `usePropertySave`'s `logTag` where `BlockPropertyDrawer` supplies it, so a failed
page-property save toasts but writes no structured log; and `AttachmentList.tsx:71` fires a success toast
unconditionally after `void handleDeleteAttachment(...)`, so a failed delete shows an error and a success toast
together (#4626 — the fix belongs in `useBlockAttachments`, where the success arm is).
