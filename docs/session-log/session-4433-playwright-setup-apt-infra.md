# Session 4433 — playwright-setup calls a runner whose apt holds no archive index infra

**Ask.** #7060's first run went red in `bridge-specs (2)`, at "Playwright setup". On that runner `apt-get update` fetched only packages.microsoft.com and no Ubuntu archive at all. Every universe font was then "Unable to locate", and the step exited 1, which reads as a diff failure. The same runner fault hit the lint job on 2026-11-18 (fixed for `apt-install` in cb6113e9f) and a deep-checks job on 2026-11-23. The maintainer chose the infra label only: no repair of the runner's apt sources, no extra retry.

**Fix.** `.github/actions/playwright-setup` now does what `apt-install` does since cb6113e9f:
- On an unresolvable package, it prints the release pocket's main and universe indexes.
- It exits 75 with `AGARIC_APT_INFRA` when either index is absent.
- `archive_indexed` is mirrored from `apt-install`, with a comment naming its twin.

**Trap.** The brief assumed apt's `E:` lines were in the step log. They were not. `playwright install-deps` runs apt with `stdio: "inherit"`, apt writes `E:` to stderr, and the step redirected only stdout, so a grep of the log could never match. install-deps' stderr now goes to the log too. The log is printed on every failed attempt, so nothing is lost from a failure, and a successful run keeps the live log to warnings and errors (c517f2f50). The builder caught this in its premise check, before writing a test that would have stubbed the lines onto stdout and passed.

**Also.** The new test had to be added to the lint job's explicit node:test list in `_validate.yml`. That list is not globbed, and a test missing from it runs nowhere.

**Decisions recorded here.**
- `rebuild_index` stays as it is, by the maintainer's choice. A sync import that changes structure clones the space's index and walks every live block. The cost grows with the number of blocks, and it was judged not worth measuring or fixing.
- #7060's review note that jiff 0.2.46 "costs compile time" had a wrong premise. serde_with's `jiff_0_2` feature is off in this build, and `cargo tree --target all -i jiff@0.2.46` prints nothing. The crate is a lockfile entry only and is never built. The other note, that the title said 3.24.0, was fixed in the squash title.

**Ran.**
- `node --test scripts/playwright-setup-action.test.mjs scripts/apt-install-action.test.mjs`: 17 pass.
- Against the unmodified action, the new tests fail `1 !== 75` on the no-index arm.
- Replacing the index check with `! true` reddens the same assertion.
- Dropping either alternative of the "cannot resolve" grep reddens exactly its own test. Review found that the first version fed both error lines to one test, so either half could go unnoticed. The `archive_indexed` twin comment now points both ways.
- prek over the changed files: zizmor, actionlint, markdownlint, typos and oxlint pass.
