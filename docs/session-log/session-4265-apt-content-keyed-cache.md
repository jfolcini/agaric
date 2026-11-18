# Session 4265 — apt installs from a content-keyed .deb cache

Set out to stop the Ubuntu mirror from redding CI. Main run 44240707721 lost `validate / cargo-tests (2)` to "apt-get install exceeded 300s twice" (exit 75), and `cargo-coverage` went red behind it for want of shard 2's lcov. PR #6880's `mcp-tests` failed the same way.

**Root cause.** The skipped "Restore apt archives" step on main was by design: main ran the combined `actions/cache` step, and in job 134587774849 that step logged `Cache hit for: apt-tauri-Linux-v1` (61 MB). The install still pulled from the mirror, because the key was fixed. `actions/cache` never re-saves on an exact hit, so the key's .debs were frozen at the versions of its first save. Every `-updates`/`-security` bump since then, plus the fresh index from `apt-get update`, made apt want files the cache did not have. Shard 1 of the same run hit the cache too and still spent 3.5 minutes installing.

**What shipped.** `actions/apt-install` owns the cache behind `cache: 'true'` (off by default, so a job that signs or publishes restores nothing, #3542; `release.yml` stays off):
- The key is a hash of `apt-get install --print-uris` against the runner image's own lists (name, size and checksum; the URI is dropped because the mirror host differs per region). Same key means the same files, so a hit is complete. A package-list change or an image update moves the key by itself, with no `-vN` to bump.
- The first attempt installs with no `apt-get update`. On a hit apt opens no connection at all. Only a failed attempt runs the bounded, advisory update before the one retry, because the image's lists can name a .deb the archive has since dropped (it keeps one superseded version).
- Main or a branch dispatch saves on a miss, and only when the first attempt succeeded, since only that attempt installed exactly the files the key names.
- `warm-only` replaces `ci.yml`'s hand-written `lookup-only` probe of the `apt-e2e-tauri-runtime` key.

Every per-workflow cache step and its fixed key is gone (`_validate.yml` cargo-tests, `actions/toolchain`, `actions/e2e-tauri-runtime`, `e2e-tauri-weekly.yml`, six lanes of `scheduled-deep-checks.yml`). `cargo-coverage`'s `lcov` is now cached too. The install runs `-q` rather than `-qq`, so the log printed on a failure shows the `Get:` lines naming the mirror (with `-qq` the log was empty).

**Trap.** `apt_update`'s retry loop reused the outer `attempt` variable. After an update the retry believed it was attempt 1, marked itself cacheable and slept again. The new unit test caught it; the fix is `local attempt`.

**Verified.** `scripts/apt-install-action.test.mjs` passes, and each of its new assertions went red when the gating or the cacheable output was broken. The real-apt proof (scratch harness: a local mirror that accepts connections and never answers, with `archive`/`security.ubuntu.com` pointed at it, timeouts 15s): the old action with a frozen-key hit missing 5 of 54 .debs exits 75 after 80s; the new action on a genuine miss also exits 75 with `AGARIC_APT_INFRA`; the new action on a hit installs lcov and xdotool in 3s, with zero connections to the mirror and `cacheable=true`. prek over the changed files is green, zizmor included, and so are the lint job's node:test files.
