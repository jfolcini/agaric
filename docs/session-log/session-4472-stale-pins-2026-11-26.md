# Session 4472 — eight stale pins, each checked against its upstream checksum

The `stale-pins` lane of the night deep-checks run (45727675233, on main 128984294) reported eight pins behind their upstreams past the 7-day cooldown. All eight move. Each moved through `node scripts/pins.mjs bump`, and each new artifact was checked against the checksum its upstream publishes.

**Moved.**
- `prek` 0.5.10 → 0.5.11:
  - The tarball matches the taiki manifest at the install-action SHA CI uses.
  - The manual-stage step's JSON count and its `prek run --hook-stage manual` output are unchanged: 31 hooks, all passed, on both versions.
- `cargo-deny` 0.20.2 → 0.21.0:
  - The tarball matches taiki.
  - `cargo deny check` (all four checks) passes on both versions, with the same warnings.
  - `scripts/prune-advisory-waivers.mjs` still reads a stale waiver from the JSON output.
  - 0.22 is on crates.io but not yet in taiki at the pinned SHA.
- `cargo-machete` 0.9.2 → 0.10.1:
  - The tarball matches taiki.
  - `cargo machete` finds nothing on both versions.
  - The `--version` format is unchanged, so `setup-hooks.sh`'s check still parses it.
- `temurin` 17.0.21+9 → 17.0.21+100000002:
  - This is a real release: `jdk-17.0.21.1+2`, published 2026-11-18. Adoptium's API writes a point release's semver this way in every line this month.
  - `setup-java` matches the API's semver, so the pin uses that form. The `pins.txt` header now says so.
  - The tarball matches the API checksum and the release's `.sha256.txt`.
- `android-ndk` r27c → r27d (27.3.13750724) and `android-build-tools` 36.0.0 → 36.1.0:
  - Both archives match the sha1 in Google's `repository2-3.xml` and hold the expected tools.
  - Nothing in the repo names either version.
- `npm` 12.2.0 → 12.2.3: package.json's `packageManager`, plus its two copies in `docs/BUILD.md` and `scripts/require-npm.sh`. The tarball's sha512 matches the registry `integrity`.
- `code-review-graph` 2.3.8 → 2.4.0 (`.mcp.json`):
  - The wheel's sha256 matches PyPI.
  - `serve` lists the same 30 tools.
  - Its graph schema migrates forward the first time 2.4.0 opens a local `.code-review-graph/graph.db`, and older versions then refuse that file. The file is gitignored and untracked.

**Not exercised here.** The Android pins and temurin can only run in CI; `android-build` runs on every PR.

**Ran.**
- `node --test scripts/pins.test.mjs`: 24 passed.
- `bash scripts/pins.sh version <name>` for each `pins.txt` pin.
- `scripts/require-npm.sh`.
- The tool runs listed above.
