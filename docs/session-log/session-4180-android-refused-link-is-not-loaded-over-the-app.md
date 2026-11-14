# Session 4180 — Android: a link the opener refuses is not loaded over the app

Follow-up to session 4162, which left three things from the Android run of #6513 open.

## What shipped

- **`openUrl` has no `window.open` fallback in the Android app.** #6764 moved `openUrl` to the opener plugin and kept the fallback for when the opener rejects. The Android app has one web view, so that fallback loads the site over the app, where the back gesture cannot leave it: what #6774 showed on a phone when the shell plugin's call failed. In the Android app a rejected open now returns `false` and logs a warning.
- `tests/fixtures/release-vault/README.md` no longer says `counts.txt` holds the seq the compaction purged through; #6782 removed it.

## Declined, with the reason

- **The log line on leaving the app with back at the root** (`FORTIFY: pthread_mutex_lock called on a destroyed mutex`): the same log has `Zygote: Process 21171 exited cleanly (0)` for that process, with no signal and no crash dump. A thread raced the exit and lost; nothing is wrong for the user.
- **The quick-capture button over a form's submit button while the on-screen keyboard is up** (seen on 0.23.0 in Settings › Spaces › Create new space): hiding the button while any text field has focus fixes it, and `e2e/page-mode-touch.spec.ts` pins the opposite, the button showing while the page title has focus. Which of the two gives way is the maintainer's call; nothing changed.
- **Compiling the release vault's generator at head**, so a change to what it calls shows before the next release: the README says it is compiled at the release and never at head, because it must build against the tag it writes a vault for.

## Suites run

`npx vitest related src/lib/open-url.ts --run` (178 files; one test in `PagePropertyTable.test.tsx` timed out while an Android build ran beside it and passed when its file ran alone), `npm run typecheck`, oxlint and oxfmt on the changed files. The new test was shown red by removing the Android branch. Not run on a phone: the opener rejecting needs a URL its scope refuses, and every scheme a link can carry is in scope. Not run: the whole vitest suite and Playwright; CI's runs are the check.
