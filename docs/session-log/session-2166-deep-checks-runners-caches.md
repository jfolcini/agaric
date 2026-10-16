# Session 2166 — Deep checks leave runners for PRs and stop saving dead caches

Three items from the 2026-10-16 CI timing audit, plus #5620's review notes.

**Mutants cap.** The 24-shard `mutants` matrix gets `max-parallel: 6`. During
the main dispatch run 38857201664 the deep checks held 17–20 of the
account's 20 runners for about 40 minutes, and PR runs in that window took
47.6–50.3 minutes to `validate-all` against a 19.2-minute median. Six is 20
runners, minus 10 for one PR gate at its widest (`verify-lockfiles`, `lint`,
`mcp-tests`, 2 `vitest`, 3 `playwright`, 2 `cargo-tests`), minus 4 for the
deep lanes running beside mutants. Mutants used 914 runner-minutes in that
run, so its wall clock grows from about 1h40 to about 2.5 h. The three
`agaric-sync` rows, whose shard 0 is the only cache writer, move to the top
of `include` so they start in the first wave.

**`full-suite-frontend` runs on Node 22 only.** It ran the whole vitest
suite on Node 24 and then Node 22: 20.1 + 19.3 minutes, cancelled at its
40-minute timeout. The PR gate already runs it on Node 24 for every
frontend change. The timeout goes to 30: the Node 22 step took 9.4–17.9
minutes across 13 runs and up to 19.2 in the latest.

**Dead rust caches.** No deep-check lane restored a cache saved by an
earlier run (bench-slo 5/5, bench-smoke 4/4, full-suite-nextest 4/4,
full-suite-prek 4/4, fuzz 4/4 misses). Repo cache usage is about 13.7 GB
against the 10 GB limit, and each save evicts gate caches that are reused.
The rust-cache steps are gone from bench-smoke, bench-slo, bench-perf-gates
and fuzz. Fuzz runs on nightly, and rust-cache's key carries the rustc
version, so it could never match anyway. full-suite-prek and
full-suite-nextest get their cache from `.github/actions/toolchain`, whose
`rust-shared-key` is now optional: empty skips the cache, and those two
lanes pass none. Mutants keeps its cache, which hits within a run. The fuzz
corpus cache misses for the same eviction reason; it should survive once
these saves stop. If not, the next step is restoring it from the
`fuzz-artifacts` upload, which already contains the corpus.

#5620's notes: the dead `bench-perf-gates` cache step is deleted (above).
Its timeout comments quoted measurements (41.4, 9.2 minutes, run ids) and
now give only the reason.
