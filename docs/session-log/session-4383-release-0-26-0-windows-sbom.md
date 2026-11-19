# Session 4383 — The 0.26.0 cut, and pins.sh hashing on Windows

This session cut 0.26.0 once #6986 (#6980) merged.

**The cut.** `scripts/release.sh 0.26.0` passed the release build, the vault and the upgrade test. Its push of `main` was then rejected, because #6985 merged during the build. Those commits touched only e2e specs, the mock, the Playwright list and one comment. So the signed bump was rebased onto `origin/main` and re-tagged, and `main` and the tag were pushed with GitHub reporting both verified.

**Windows SBOM step.** In the release run, `build-and-release (windows)` failed at "Generate SBOMs". The `pins.txt` sha256 for syft matched upstream's checksums file. The computed one came back as `\<sha256>`: GNU `sha256sum` escapes its output line with a leading backslash when the path it prints holds one, and Windows' `$RUNNER_TEMP` is `D:\a\_temp`. This was the first release since "build: one pins.txt for every external tool and download" sent the Windows downloads through `pins.sh fetch`. `sha256_of` now hashes from stdin, so no path is printed.

**What ran:** `node --test scripts/pins.test.mjs` (16 pass). The new `pins.sh fetch` case fails with the CI's exact `has \<sha256>` message when the stdin redirect is reverted.
