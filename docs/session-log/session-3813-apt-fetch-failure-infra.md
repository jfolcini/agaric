# Session 3813 — apt-install retries a download the mirror cannot serve, then calls it infra

- From 13:51Z on 2026-11-11, `main`'s CI, #6502, #6504, #6505 and this PR's own runs failed in every job that had to download a .deb. The cause was `Temporary failure resolving 'azure.archive.ubuntu.com'`, and `apt-get install` exited 100.
- `actions/apt-install` retried only an install that timed out, so a download failure went straight to red as an ordinary failure. It never got the `AGARIC_APT_INFRA` marker and exit 75 that mean "rerun the job".
- The install's stderr is now kept and printed after each attempt. When apt reports a download it could not make (`Temporary failure resolving`, `Could not resolve`, `Failed to fetch`, `Unable to fetch some archives`), the step waits a minute and retries once, reusing the .debs already fetched. If the second try fails the same way, it exits 75 with the marker, and apt's log prints once. A package apt cannot find still fails at once with apt's own status.
- **Tried and removed: dropping the unresolvable mirror before the retry.**
  - The idea was to remove each host apt reported as unresolvable from `/etc/apt/apt-mirrors.txt` and refresh the package lists from the next mirror.
  - On this PR's own run (f9d3dd460, `cargo-tests (2)` and `mcp-tests`), the drop fired, and the retry then failed on `Temporary failure resolving 'archive.ubuntu.com'`.
  - The runners could resolve no Ubuntu mirror at all, while both hosts served their `InRelease` normally from outside GitHub.
  - No case on record shows the drop helping, so it went, per AGENTS.md § How we work.
- Test: `scripts/apt-install-action.test.mjs` runs the action's own `run:` script, read from `action.yml`, against stubbed `sudo`, `apt-get` and `sleep`. Four cases:
  - a download that fails twice: exit 75, two installs, one wait;
  - one that fails once: passes on the retry;
  - a missing package: exit 100, no retry;
  - a clean install.
- The test is registered in `_validate.yml`'s script-test step.
- Red: on main the two download cases fail (exit 100 where 75 and 0 are expected). Falsified, each half broken in turn: no infra classification reddens the twice case only; no retry reddens both download cases.
- The marker was seen working on a real runner: `mcp-tests` on a9990f586 ended in `AGARIC_APT_INFRA` and exit 75.
