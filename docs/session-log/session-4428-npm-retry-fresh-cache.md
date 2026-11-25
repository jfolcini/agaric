# Session 4428 — each npm audit retry asks the registry again

**Ask.** Fix every flake. `validate / lint` failed `npm audit signatures` twice:
- #7050's first run, on `playwright@1.65.1`;
- this PR's first push, on `@tiptap/extension-code-block-lowlight@3.34.0`.

Both times the registry's attestations endpoint answered `OK` where JSON belongs. Then fold in the sweep's non-blocking review notes.

**Cause.** The retries never asked the registry again.
- npm stores what the registry answered in its cache, and the attestations endpoint sends `cache-control: max-age=31557600` (one year).
- So the first attempt's bad body was stored, and every retry got it back from the cache. Run twice in one cache, `npm audit signatures --loglevel http` logs the second fetch of an attestation as `(cache hit)`.
- That is why all five attempts failed on one URL across four minutes in this PR's first run, while other lint jobs restoring the same CI cache key passed. The fault was one bad answer, replayed.
- `--prefer-online` is not enough: the GET carries `last-modified`, so a revalidation can return 304 and keep the cached body.

**Fix.** `scripts/npm-audit-retry.sh` runs each attempt with its own empty npm cache (`npm_config_cache` under one `mktemp -d`, removed on exit).
- This PR's first push widened the backoff to about four minutes, on the belief that the fault lasted minutes. That belief came from the replay, so the backoff goes back to 5 s then 15 s.
- New test: "every attempt runs with its own empty npm cache". It fails on main's wrapper, where all three attempts share one cache.

**Review notes from the sweep.**
- **#7043:** `holdPeer` and `pullFromPeer` copied one wait. They now share `waitSyncIdle()`.
- **#7054 (this PR's first push), "the four-minute wait also stalls the local pre-push hook":** moot, since the backoff is back to 20 s.
- **#7038, "a stale waiver still waits out the retries":** 20 s, as that note says, harmless. Left.
- **#7038, "`audit_strict` throws the report away on a real advisory":** premise wrong. In `--json` mode better-npm-audit writes its exception and security-report tables to stderr, which streams into the log; only the JSON on stdout is captured. A live `npx better-npm-audit audit --json` printed both tables on stderr.
- **#7038, "redo the rustix bump with `--precise` to drop the windows-sys/syn churn":** premise wrong. #7038's description shows `cargo update -p rustix --precise 1.1.6` on main's lock giving the same edges, all to versions already in the lock.
- **#7049, "the fuzz lock sits ahead of src-tauri/Cargo.lock":** premise partly wrong.
  - tauri: the app was already on 2.12.6 from #7042, #7049's base.
  - sqlx: 0.9.1 reaches the app with #7053.
  - notify-rust: 4.19 stays out of the app on purpose (#7048 closed, evidence in #7051). zbus 6 in the fuzz graph costs only fuzz build time, #7049's other note.
- **#7051, "lock-only wry/tao" and "Desktop builds don't change":** the same `cargo update` also re-resolved some `windows-sys`, `syn` and `proc-macro-crate` edges, so Windows and proc-macro builds change too. #7051's description was fixed before merge; `session-4422-desktop-integration-crates.md` keeps the old wording.

**Ran:**
- `node --test scripts/npm-audit-retry.test.mjs`: the new test fails on main's wrapper and passes with the fix.
- `bash scripts/npm-audit-retry.sh` and `bash scripts/npm-audit-retry.sh npm audit signatures` against the live registry: both exit 0, with no temp directory left behind.
- `shfmt -d` and `shellcheck -S warning` on the wrapper.
- oxlint and oxfmt on the test.
- `npm run typecheck:e2e-tauri` for `waitSyncIdle`.
