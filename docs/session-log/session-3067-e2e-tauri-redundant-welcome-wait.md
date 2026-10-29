# Session 3067 — the real-backend lane stops waiting 5 s for a welcome modal that cannot appear

The brief: e2e-tauri boots the app once per spec file, the median spec takes 8.6 s with about 6 s of it boot, so boot once per group of specs instead. It asked for the design in the PR body first.

**Re-measured** from CI run 40827348319: boot is about 3–3.5 s per spec, not 6 s.
- The worker fork, TypeScript load and tauri-driver spawn take 0.85–1.24 s.
- Session creation up to `notes.db` appearing takes 0.4–1.1 s. It falls into two clusters, quantised by `before`'s 500 ms poll.
- `waitForAppReady` takes at most 1.6 s.

At those numbers, grouping saves about 30 s per shard in a first phase and about 1 min at best. It also retires `e2e-tauri/AGENTS.md`'s "One file, one vault". The full design is in the PR body for the maintainer to decide on.

**Found and fixed instead:**
- `dismissWelcomeModalIfPresent` waited up to 5 s for the welcome modal on every call. The modal mounts only while `agaric-onboarding-done` is unset, so every call after a session's first waited the whole 5 s for nothing. That is about 15 calls per run: `import-formats` makes 4, a `restartApp` makes 2, and several specs make 1–2. It now reads the flag first and returns at once when the flag is set.
- `before` polls for `notes.db` every 100 ms instead of every 500 ms.

**Measured:** the per-spec durations in the PR's real-backend run against run 40827348319 are in the PR body.

**Suites:** typecheck and lint. The real-backend lane runs in CI; this box cannot build and drive the app.
