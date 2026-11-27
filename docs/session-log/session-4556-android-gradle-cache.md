# Session 4556 — android-build caches Gradle's modules: Maven Central's 429s outlast the retries

`main` went red at `017be5c4b` (run 46034458617) on `android-build`: `Could not resolve org.jetbrains.kotlin:kotlin-gradle-plugin-api:2.3.21`, `Received status code 429 from server: Too Many Requests` from `repo.maven.apache.org`. The retries #6901 added (`GRADLE_OPTS`: 8 tries from 2 s, doubling) ran for about 8.5 minutes and the rate limit held. It is not a one-off: five `android-build` failures since 2026-11-18 carry the 429 (runs 44387098882, 45568461353, 45639041256, 46034105752, 46034458617), all in `ci.yml`, two on `main`. The release and `android-launch-smoke` lanes have not hit it.

**Cause**

The job cached Rust and npm but not Gradle, so every run fetched its whole dependency set from Maven Central, from shared runner addresses.

**Fix**

`android-build` restores `~/.gradle/caches/modules-2` before the APK build and saves it from `main` after a green build: the restore/save split `apt-install` uses. The key is the hash of `src-tauri/gen/android/gradle/verification-metadata.xml`, which changes with the dependency set; `restore-keys` falls back to the previous entry, so a bump downloads only what is new. Gradle's dependency verification still checks every artifact it takes from the cache. The lock file and `gc.properties` stay out of the archive, as Gradle's caching guidance says.

**Cost**

About 300 MB (`modules-2` measured locally) on an Actions cache already near GitHub's 10 GB repository limit, so GitHub evicts the least recently used entries sooner. Not done: the release workflow's signed Android build stays uncached, since a cache there is a poisoning path into a signed artifact, and it has not hit the 429.

**Ran**

`prek run --files .github/workflows/ci.yml` (actionlint, zizmor). The fix is checked by `main`'s next run saving the entry and the run after it restoring it; a PR run only reads what `main` saved.
