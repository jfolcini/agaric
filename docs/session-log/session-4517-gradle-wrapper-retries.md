# Session 4517 — The Gradle wrapper retries its download

**Ask.** #7136's `android-build` went red on a cause outside its diff. Root-cause it, alongside the one allowed re-run.

**Found.**
- The Rust build finished; the Gradle wrapper then fetched `gradle-9.6.1-bin.zip` from services.gradle.org, got a connection reset, and failed with `Attempt 1/1 failed`.
- The wrapper retries the distribution download only when `gradle-wrapper.properties` sets `retries`; the default is none. The job's `GRADLE_OPTS` retries cover Maven Central, not the wrapper's own download.
- The wrapper JAR the pinned tauri CLI template ships reads `retries` and `retryBackOffMs` (`WrapperExecutor`, `Install`), so the keys take effect without touching tauri-owned files.

**Done.**
- `scripts/patch-android-build.sh`, which already pins `distributionSha256Sum` in the generated properties, writes `retries=3` and `retryBackOffMs=2000` beside it: four tries, 2 s apart and doubling. Every Android build runs the script (`ci.yml`, `release.yml`, `android-launch-smoke.yml`, `setup-android.sh --init-project`).

**Ran.**
- The script on a scaffold-shaped fixture, twice: both runs exit 0, and the properties end with one copy each of the checksum, `retries` and `retryBackOffMs`.
- `shellcheck`, `shfmt -d`: clean.
- Not shown: a retry against a real reset. The PR's `android-build` run shows the wrapper still downloads with the keys present.
