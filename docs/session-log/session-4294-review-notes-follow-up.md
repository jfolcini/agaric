# Session 4294 — review notes from #6878, #6882, #6883, #6886, #6890 and #6892

One follow-up PR for the non-blocking review notes of the PRs merged on 2026-11-18, plus the orchestrator's question about the Gradle verification workflow. Each note was checked against its review body and the code on `main`.

- **#6878, kept-page count without dedup:** dropped. `keep_unseen_local_blocks` (`agaric-engine/src/loro/engine/keep.rs`) mints a fresh `BlockId::new()` Trash page for every report, and the kept blocks then sit under it in the index, so no page is ever reported twice. A repeated title is a second page, and a title `Set` would undercount it.
- **#6882, the comment above `binaries:` in `release.yml`:** fixed; it restated the paths.
- **`gradle-verification-commit.yml` on `main`:** dropped. The job runs only for `workflow_run.event == 'pull_request'`, CI's `pull_request` trigger needs base `main`, so the head branch is never `main`, and `main`'s own CI run is a `push` event.
- **#6886:** all three dropped. The `MakeWriter` capture has about twenty copies across five crates and the integration tests; sharing one needs a cross-crate test-support export and fixes no failure. The `run_cache_tool` log test pins the warn-versus-info split that makes a failed cache refresh visible in a bug report. `host_env` stays because `update-desktop-database` and `gtk-update-icon-cache` link GLib and break under the bundle's env the same way `xdg-open` did.
- **#6890, the one-advance wait in `mirror-inbound.e2e.ts`:** dropped. The window needs a runner stalled past one mirror tick, and the reviewer's own condition ("if it ever shows up") has not been met: the only red real-backend run on 2026-11-18 was an apt mirror failure.
- **#6892, `DELETE FROM sqlite_stat1` on a never-analysed vault:** dropped. A migrated vault has no `sqlite_stat1` (checked on `dev.db`), and the first `PRAGMA optimize` creates it: `pragma_optimize_smoke_test_157_g` runs the job on such a vault and was green in `main`'s CI after 984eec4. Deleting rows never drops the table.
- **#6883, `runsOnRealBackend`'s throw:** declined in that PR; no change.
