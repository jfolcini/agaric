# Session 4276 — Android Gradle builds ride out a registry 429

Run 43889772262's `android-build` failed attempt 1 when Maven Central answered `:buildSrc`'s Kotlin plugin POMs with 429; attempt 2 passed unchanged. The cause is Gradle's own retry, read from the v9.6.1 source the wrapper pins: `ErrorHandlingModuleComponentRepository` retries a transient failure (`NetworkingIssueVerifier` counts 5xx, 408 and 429) `org.gradle.internal.repository.max.tentatives` times, 3 by default, waiting `org.gradle.internal.repository.initial.backoff` ms, 1000 by default, doubled each try, then disables the repository for the rest of the build. The failed Gradle run lasted 20 s and its log shows "Repository Gradle Central Plugin Repository is disabled".

Shipped: `GRADLE_OPTS` with 8 tries from 2000 ms on the three Android jobs (`ci.yml` `android-build`, `android-launch-smoke.yml`, `release.yml` `android-build-and-release`), about 4 min of backoff before Gradle gives up.

Proof, local, Gradle 9.6.1 against a Python server that answers 429 to the first N requests, with `org.gradle.jvmargs` set so the build runs in a separate daemon as Tauri's generated project does: defaults with N=4 fail after 3 requests 1 s and 2 s apart; the committed values with N=7 succeed on the 8th request, the requests 2, 4, 8, 16, 32, 64 and 128 s apart. So `GRADLE_OPTS` system properties reach the daemon.

Not done, and why:
- A Gradle dependency cache. `setup-java`'s `cache: gradle` saves in an always-run post step from any ref, so a run that fails mid-resolution freezes a partial cache under the exact key (it never restores with a prefix and never re-saves a hit), PR runs save too, and its default key globs Gradle files that `tauri android init` only creates later in the job. A hand-rolled `actions/cache` restore/save pair saved only on `main` avoids that but adds a Gradle home to the shared cache quota the Rust `target/` trees already crowd, for a path-gated job that `main` runs only when an Android path changes, so the nightly would often find it evicted. The retry fixes the observed transient failure on its own.
- `release.yml` gets the retry only: its own jobs restore no cache (`.github/AGENTS.md` § Caches, #3542), and this one signs and publishes.

Sweep of the 7 days to 2026-11-18 over `ci.yml`, `scheduled-deep-checks.yml`, `release.yml` and `android-launch-smoke.yml` runs (failed runs and every re-run attempt): job 133387826139 is the only Gradle or registry download failure. The three failed `android-launch-smoke` dispatches of 2026-11-12 on `claude/6553-ci-flaky-nightly` failed in the emulator scripts (inset parser, settle wait), and the re-run releases 0.24.0 and 0.25.0 only had macOS legs cancelled.

Ran: the pre-commit hooks over the three workflows. No CI yet.
