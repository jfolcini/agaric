# Session 3620 — apt `.deb` caches for the bundle lane and the weekly Rust lanes

Follow-up to #6403. On a slow-mirror day, two lanes that download every Tauri `-dev` package from the mirror went red with `AGARIC_APT_INFRA`.

- `ci.yml`'s `build` (main run 42119020760, job 127582157440) calls `actions/toolchain` with `bundle-deps`, and both of the toolchain's cache steps were skipped for it so its superset stayed off the shared `apt-tauri-*-v1` key. The steps now pick the key per lane: `apt-tauri-bundle-<os>-v1` for the bundle lane, `apt-tauri-<os>-v1` otherwise. Main saves, other refs restore, the same as before.
- bench-smoke (0) (run 42104958625, job 127517276964) had the same cause and no superset: it installs exactly the shared list and never restored it. `scheduled-deep-checks.yml` had the same block in clippy-clean, bench-smoke, bench-slo, bench-perf-gates, mutants and fuzz; each now restores `apt-tauri-<os>-v1` read-only. This workflow runs on main only weekly, so it reads the key the per-push Rust lanes save and never writes it.
- Not shown before merge: a branch run never saves the bundle key, so a PR run shows a miss that falls back to the mirror. The first main push that runs `build` saves it, and the next one restores it.
