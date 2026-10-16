# Session 2272 — Review notes from #5622 to #5660

The non-blocking notes from that sweep's merges, batched. #5640, #5641,
#5643, #5644, #5648, #5650, #5652, #5656 and #5657 left none.

- **#5622:** a reflowed comment line in `_validate.yml`'s vitest step ran
  past its neighbours; rewrapped.
- **#5623:** the note called session 2166's "later waves restore" claim only
  partly true. Session 2166's log says only that the `agaric-sync` rows "start
  in the first wave", which holds. The overclaim was in
  `scheduled-deep-checks.yml`'s comment. rust-cache saves in its post step,
  so only shards that start after the saver finishes restore its tree. The
  comment now says so.
- **#5631, note 1:** the PR body did not list a trade-off. An op projected
  SQL-only (`EngineMissingTarget`, the #1257 window) no longer gets another
  engine attempt on every boot once a snapshot pass runs after it. The
  variant doc on `SqlOnlyFallbackReason::EngineMissingTarget` already states
  the narrowed contract, so no code changed here. Whether such a block can
  stay missing from the engine for good belongs to #5628's engine-vs-SQL gap.
- **#5631, note 2:** `save_snapshot` had become test-only but stayed `pub`
  with its own head read. It moved into `snapshot.rs`'s tests module, so
  `save_all_engines` is the only production writer of `loro_doc_state`.
- **#5632:** the pointer to "session 2180's lesson on shared targets" had no
  target when it merged. #5633 added session 2180, which carries it.
- **#5633:**
  - The sanctioned `check-sqlx-cache-drift` skip in the batch skill's
    codegen reference left out that the pre-push verify re-runs the guard
    over the range, where a commit `SKIP` cannot reach it. The recipe now
    says the push takes `SKIP_CI_VERIFY` too.
  - `docs/BUILD.md` had copied CI's NDK pin into its prose; that line is back
    to "local can float", and the install recipe names `ci.yml` as the
    source of its versions.
  - The release section's `git grep 'REMOVE[ ]AFTER'` listed fenced examples
    and quotations the guard ignores. It is replaced by the guard's own
    report, which names each expired marker.
  - **Correction to session 2180:** its "Android SDK" bullet has the wrapper
    backwards. `sdkmanager` is the deprecated wrapper around the new
    `android` CLI, as `docs/BUILD.md` says.
- **#5635:**
  - `ReminderSettings.enabled`'s doc still sent the user to "Settings →
    Notifications"; that tab is now Tasks & reminders. The doc and its
    `bindings.ts` copy say so.
  - **Correction to session 2202:** its list of what moved says "Sync status
    and Retry went to the top of Sync & devices". Review dropped Retry, as
    the same log's last paragraph says; only the status moved, and the device
    list owns every sync action.
- **#5642:** the note said `MermaidDiagram.tsx`'s `viewerSvg` branch
  `if (!svgEl) return markup` cannot run, since a resolved `mermaid.render`
  returns an `<svg>` root. That holds, but the branch is also the null check
  `querySelector`'s type needs. Without it the code needs a non-null
  assertion, which oxlint rejects, or a cast, which is no simpler. It stays.
- **#5645:**
  - `PageBrowser.tsx`'s `createUnder` was a one-line helper with one
    caller; it is inlined. Nothing downstream is memoized on its identity.
  - The note asked whether `usePageCreation`'s exact, case-sensitive
    `existing` lookup should match the dialog's case-insensitive one. It
    should not: it mirrors the backend, whose `find_live_page_by_title`
    resolves only an exact title, so a case-insensitive lookup would return
    another page under the typed title. The dialog's own guard already
    re-runs its case-insensitive search before it calls `createPage`.
- **#5649:** the note said `apply_op_tx_with_mode` carries the replay fact
  twice, as `replay: bool` and `replay_dirty.is_some()`, and asked for no
  change unless those helpers' signatures move again. None did.
- **#5651:** the note flagged that the typing helper's 400 ms settled
  read-back could end a first attempt early on a slow render, costing a
  retry. The PR's e2e-tauri run (38931727903) retried nothing, and the
  typing-heavy specs dropped: `pages-most-linked` from 23.7 s to 9.9 s and
  `search-bm25-order` from 21.3 s to 5.3 s, with the control spec unchanged.
- **#5653:** the note said a chord deferred behind Enter skips the by-id
  handlers' remount when it runs before React commits the new focus, so the
  block could move without the editor. It does not: `EditableBlock` mounts
  the roving editor whenever its block becomes focused and the editor is
  elsewhere, so the commit that moves and focuses the new block mounts it
  there. When React commits first, the ref is current and the remount runs.
- **#5654:** no notes. One of its flakes was `locator.fill` on a block
  editor, the pattern `e2e/AGENTS.md`'s example taught. With the
  maintainer's approval the example now uses `replaceEditorText`, and a
  bullet says why.
- **#5655:**
  - Moving the freshness arm to 119 s lets a `<=`-to-`<` mutation in
    `peer_pulled_from_us_recently` survive. The reviewer accepted that as the
    deliberate trade the test's doc states.
  - The "Load more" repeat or skip that the PR described as unchanged is a
    deferred user-visible failure, so it is filed as #5659.
- **#5658:** session 2246 cited the commit code as
  `src/lib/inline-property-commit.ts`, the path before #5527 moved it to
  `src/stores/`. With the maintainer's approval the merged log is fixed in
  place, and so is #5365's body.
- **#5660:** its session log described setting up the real-backend lane
  locally, which belongs with the lane. `e2e-tauri/AGENTS.md` § Running had
  the recipe but not the Wayland caveat: `xvfb-run` sets only `DISPLAY`, so
  GTK opened the app on the desktop session. The recipe now strips
  `WAYLAND_DISPLAY` and forces `GDK_BACKEND=x11`. The lane workflow's comment
  that WebKitWebDriver cannot run on a dev box now points at that recipe.
