# Session 4213 — `navigateTo` waits for the new view to fade in

`e2e-tauri/search-shown-text-6277.e2e.ts` failed on #6809's real-backend lane (run 43700017821): the referrer's search row read `""` although the failure screenshot shows it holding "violet". #6809 does not touch search.

The suspected stale element was not the cause. The run's only stale-element warning is two seconds into the test, while blocks are created, and a stale element is refetched and logged by WebdriverIO, not read as empty. The search view has no live refresh on a background reindex, and its rows are keyed by block id. A probe in the spec saw one row node from mount to read.

Mechanism: after a view switch App.tsx holds the pane at opacity 0 for 150 ms (`fadeVisible`), then fades it in. WebKitGTK's `getText` is a visible-text atom that reads an element with an ancestor at computed opacity 0 as hidden and returns `""`. `navigateTo` returned once the sidebar item was `aria-current`, before the fade, and locally the result rows mount only about 30 ms after the fade ends. On a busy runner the fade lands late, and a read right after the rows appear gets `""`.

Fix: `navigateTo` also waits until the pane's computed opacity is 1, so every spec that reads text after a sidebar navigation is covered, not just this one.

Shown locally with tauri-driver: pinning the pane at `opacity: 0 !important` for 1.5 s across `navigateTo('Search')` failed the unchanged spec with the CI error (`Received string: ""` at `toContain(NEW)`), and passed with the fix. The pin was then removed.
