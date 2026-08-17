# Session 1344 — the check that passed without running anything

Session 1343 fixed the boot panic and ended on an open loop: "0.9.7's published
artifacts are broken. This branch fixes the source; the release itself needs
re-cutting once it lands." This session closes that loop, and then spends most of
its time on the more interesting half — why nothing caught it.

## 0.9.8

Cut from `main` at `2e10dd821`, all five version manifests bumped together, tag
pushed, and the Release workflow published it with all 24 jobs green. `latest.json`
resolves to 0.9.8 with correct minisign signatures for every platform.

The push went **directly to `main`**, bypassing branch protection, and GitHub
recorded three violations doing so: changes-must-be-made-through-a-pull-request,
2-of-2-required-status-checks, and **commits-must-have-verified-signatures**. The
first two are `bump-version.sh`'s intended path. The third took a wrong turn
before it was understood, and the wrong turn is the more useful half.

The obvious reading — "the release commit is unsigned" — is false.
`bump-version.sh` signs deliberately (`git commit -S` at :255, `git tag -s` at
:300), and `git log --format=%G?` returns `G` on `2e10dd821`. What GitHub
actually says is `verified=false, reason=unverified_email`: the signature is good
and made by key `6CD11759A20B6111`, whose UID is `jfolcini86@gmail.com`, while
the commit is authored as `t <t@t.t>`. The cryptography is fine; the binding to a
GitHub identity is not.

It stays invisible because every other commit's identity is laundered by the
merge — GitHub re-signs squash commits with its own web-flow key, so they land
`verified=true` no matter what the local `user.email` says. The release path is
the only one where a locally-authored commit reaches `main` directly, and so the
only place the placeholder identity is ever tested. Filed as #4082.

## Verifying the release, and getting a false green on the first try

0.9.7 taught that "CI is green" and "the artifact starts" are different claims, so
0.9.8's AppImage was downloaded from the release page and launched. It exited **0,
in 0.23 seconds, with no output**, which looks like a pass if you are reading the
exit code and looks like nothing at all if you are reading the log.

It was `tauri-plugin-single-instance`. An Agaric was already running on the
machine; the second process handed its arguments to the first and exited
successfully, exactly as designed. The check had not booted anything.

Re-running under `dbus-run-session` — a private session bus, so the
single-instance handoff has nothing to find — the published artifact stayed up
for 15s and printed no panic and no `SetLoggerError`, which rules out the 0.9.7
failure mode specifically. It is worth being precise about how much that proves,
given what the Tier 2 section below goes on to establish: staying alive is weaker
evidence than it looks. The unambiguous confirmation is a different one — a
0.9.8 build has been running on this machine for hours with a real
`Journal · Work · Agaric` window, which is a boot no amount of exit-code reading
can argue with.

So the first attempt at "does it start" reproduced, in miniature and within ten
minutes, the precise failure mode of the thing it was verifying: a check that
returns success without executing the program. That is now the load-bearing
comment in the CI step below.

## #4080 — two tiers

**Tier 1, a boot-path test.** `init_logging` is reachable only from Tauri's setup
hook, so the entire sequence — bridge install, appender build, registry
composition, subscriber install — had never once run in a test. 3550 tests passed on
a binary that aborted there. `boot_path_tests::init_logging_completes_the_real_boot_sequence`
drives the real function against `tauri::test::mock_app()` and a `TempDir`. Its
assertions (live subscriber, log dir created) are almost incidental; the
load-bearing claim is that the call returns at all. Pre-#4079 it aborted the
process.

**Tier 2, launch the artifact.** A new `Smoke-boot the repacked AppImage (Xvfb)`
step starts the real repacked AppImage under `xvfb-run`, against a throwaway
`AGARIC_DATA_DIR` with `AGARIC_E2E_SANDBOX=1` so a dropped override fails loudly
instead of opening a real vault.

The check asserts two things, and it took two rounds to get there.

The first draft asserted only liveness: `timeout` fires at 20s, exit code 124
means the app was still up, pass. Testing that draft against a deliberately
broken configuration killed it. `AGARIC_E2E_SANDBOX=1` with no `AGARIC_DATA_DIR`
is a combination `app_paths::decide` is *required* to reject — and the app,
handed it, stayed alive for the full timeout and returned 124. The fatal-boot
path puts up a dialog and waits, so the process is very much alive while having
completed no boot at all. A liveness-only check reports that as a pass. The
second draft of a check whose whole purpose is "stop believing green means
working" had reproduced the bug a third time.

So the step now leads with positive proof: `init_logging` creates
`$AGARIC_DATA_DIR/logs/agaric.log` and writes "log directory initialized" into
it, and the step requires that file, non-empty, containing that line. It lands
under the throwaway data dir, so finding it proves two things at once — boot got
past the phase that aborted in 0.9.7, and the sandbox override took effect, so
the run never went near a real vault.

Only then does the exit code get checked, where the **only** passing value is
124. Every other outcome is a failure with its own message, **including exit 0**:
a desktop app that boots stays up, and a quiet immediate success is precisely the
shape a false green takes here. 137 (ignored SIGTERM), 101 (Rust panic, the 0.9.7
shape) and everything else are separated so the log says which happened.

Placement matters as much as the check: it sits after the icon verification and
**before `Replace AppImage on draft release with repacked build`**, the first step
that uploads anything. `generate-latest-json` and `publish-release` both require
this job, so a build that cannot start now produces no signed asset and no updater
manifest at all.

Linux only. macOS and Windows runners have a session, but whether the WebView
initialises headlessly there needs its own spike before a release is gated on it.
Runners have no libfuse2, so `APPIMAGE_EXTRACT_AND_RUN=1` is set — that exercises
the real AppRun, the bundled libraries and the real binary, but not the squashfs
mount path, which is the one launch failure this step still cannot see.

`Verify repacked AppImage` was also renamed to `Verify repacked AppImage (icon +
size only)`. Its four assertions all passed on 0.9.7. The name promised more than
the step delivered, and a name that over-promises is how a gap stays invisible.

## 0.9.7

Marked as a **pre-release** with a caution banner naming the panic and pointing at
0.9.8. `tauri.conf.json`'s updater endpoint is
`releases/latest/download/latest.json`, and GitHub's `latest` excludes
pre-releases — so this both removes 0.9.7 from the download path and is, usefully,
the mechanism for yanking a bad release: had 0.9.8 been the broken one, flipping it
to pre-release would have rolled `latest` back rather than requiring a new build.
