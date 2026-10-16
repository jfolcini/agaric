# Session 2162 — Two PR-lane speedups from a CI timing audit

An audit of 52 successful `ci.yml` runs and the real-backend smoke's job logs
found two avoidable costs on pull requests.

The real-backend WebdriverIO smoke (`e2e-tauri-weekly.yml`) built the app
with `tauri build --debug`, whose `beforeBuildCommand` runs
`prepare-external-bins.mjs`, and that builds the `agaric-mcp` sidecar in
release: 12m19s of a 17-minute build step cold (run 38859986472), 4m13s of
5.4 minutes warm (run 38815251099). No spec or `wdio.conf.ts` uses the
sidecar; the MCP spec connects to the app's own socket. The build now
overrides `beforeBuildCommand` to `npm run build`. `externalBin` is no longer
in `tauri.conf.json`, so nothing needs the placeholder either. The audit also
blamed this job's cache misses on main-only saves; that was wrong. The
caches hit until the repo went over its 10 GB cache limit and evicted them,
so they stay.

`cargo test --doc --workspace` ran on `cargo-tests` shard 2, the slowest job
on backend PRs, for 2.9–3.1 minutes (runs 38849989109, 38852940484,
38860006295). Its uninstrumented build shares nothing with that job's
coverage-instrumented tree. It now runs at the end of `mcp-tests`, which has
the same `backend` gate, is in `validate-all`, builds the same profile and
finishes around minute 5–6. Expected: the critical path drops to shard 1's
time, about 2–3 minutes sooner.
