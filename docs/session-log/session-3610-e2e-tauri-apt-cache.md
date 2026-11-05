# Session 3610 — e2e-tauri shards install from a `.deb` cache

The real-backend shards downloaded their runtime packages from the Ubuntu mirror on every run, with no cache; a slow mirror stalled one shard per run for most of its budget, and after #6397 it failed as `AGARIC_APT_INFRA` and needed a re-run.

- The shards' runtime apt list moved into a composite, `.github/actions/e2e-tauri-runtime`: restore `apt-e2e-tauri-runtime-<os>-v1`, install, save on a miss when on main or a branch dispatch. A miss installs from the mirror under #6397's bound.
- `ci.yml`'s new `e2e-tauri-apt-cache` job runs it on every main push, so the key is written by a lane main runs often (#5853: this lane runs on main weekly, too rarely to keep its own key). A `lookup-only` probe ends the job on a hit. It runs on a fresh runner, so Keep-Downloaded-Packages leaves exactly the closure a fresh shard fetches, `libwebkit2gtk-4.1-0` included; downloading from a job that had already installed the Tauri dev packages would have missed that closure.
- Rejected: adding the list to `actions/toolchain`'s `apt-tauri` set, which would install the WebDriver, Xvfb and window-manager stack in every lane that compiles Rust.
- Not provable before merge on a PR run, which only restores. A branch `workflow_dispatch` saves on its miss, so a second dispatch shows the hit.
