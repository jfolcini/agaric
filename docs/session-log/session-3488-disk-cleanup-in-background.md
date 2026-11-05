# Session 3488 — cargo-tests frees disk in the background

Part of the slow-tests sweep. The `validate / cargo-tests` shards are CI's long pole, and on main runs 41955690680 and 41961818614 each shard spent 119 s in "Free up runner disk space" before any setup step started: sequential `rm -rf` of the preinstalled dotnet, GHC, PowerShell, Chromium, Android and CodeQL trees.

The deletes now run in a background process launched by that step, and a new "Wait for the disk cleanup" step sits right before the nextest step, which is the only step that needs the space: the job died mid-test, never in setup, before the cleanup existed (#6262, #6272). The background script runs the deletes under `set -e` and records their exit status, so the wait step fails the job if they did not all succeed. The original step failed the job the same way. The other three copies of the step (ci.yml's android-build, release.yml, android-launch-smoke.yml) are off the PR gate's critical path and unchanged.

The saving is measured on this PR's own CI run against the main runs above. `prek run --files .github/workflows/_validate.yml` passed (actionlint, zizmor).
