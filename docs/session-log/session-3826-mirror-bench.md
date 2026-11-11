# Session 3826 — Benches for the Markdown mirror

#5363's Performance boxes: the Criterion group, the `apply_page_source_inner` merge cost on a large page, the polling scan's idle cost, the re-scan after a snapshot catch-up, and the boot check.

## Premise check

- "The startup hash pass" is a misnomer. The mirror does not hash: its startup is a full pass that renders every page (`get_page_file_inner`) and compares it with the text last written, the shadow. It is benched as that.
- The reader-pool box held as written, with nothing to build. `mirror::spawn` gets `pools.read`, and every write goes through the ingest's `pools.write` inside `apply_page_source_inner`'s one transaction. The coordinator ticked it from that evidence.
- Boot: `mirror::spawn` sleeps one `TICK` before its first pass, on a background task, so the mirror cannot delay `setup`. The A/B boot measurement was skipped, as agreed; that is the evidence instead.

## The change

`benches/groups/mirror_bench.rs` is registered in `io_bench`. Its seeds are raw SQL per `benches/AGENTS.md`. Every case drives the real `Mirror::tick` with the ingest on, as the app runs it:

- `mirror_dirty_tick/{10,100,1000}`: a tick writing that many pages a sync named, in a 1000-page vault.
- `mirror_large_page_tick/2000`: a tick writing one page of 2K blocks. That is the whole-page render a change to a large page costs, the shape of logseq/db-test#1510.
- `mirror_startup_pass/10000`: the first tick of a freshly opened mirror over a folder it already wrote. It is a full pass that writes nothing.
- `mirror_idle_tick/10000`: a tick with nothing to write. It is the polling scan, one stat per file and per folder, paid every `TICK`.
- `mirror_catchup_pass/100000`: the full pass a sync naming no page asks for, at 2K pages × 50 blocks.
- `mirror_ingest_merge/2000`: `apply_page_source_inner` with `merge: true`, as an ingest saves, editing one block of a 2K-block page.

The shape probes:

- The setup checks one file per page and nothing diverged or failed.
- After timing, the dirty, large-page and merge cases check their writes landed, and the idle case checks it wrote nothing.
- Those checks run only when the timed loop ran: a Criterion name filter skips the loop but not the code after it, and the first filtered run panicked on that.

## Numbers

All numbers come from `cargo bench` with `CARGO_PROFILE_BENCH_LTO=false CARGO_PROFILE_BENCH_CODEGEN_UNITS=16` (not the shipped thin-LTO profile), on a shared cloud box at load 1.4 to 3.3. They show the group runs and roughly where it lands; each is Criterion's [low, mean, high] for 10 to 20 samples.

| Case | Time |
|---|---|
| dirty tick, 10 pages | 41.7, 43.8, 44.9 ms |
| dirty tick, 100 pages | 277, 292, 309 ms |
| dirty tick, 1000 pages | 0.83, 0.97, 1.23 s |
| large page tick, 2K blocks | 57.4, 58.4, 59.7 ms |
| startup pass, 10K pages | 6.98, 7.11, 7.24 s |
| idle tick, 10K files | 16.3, 17.5, 18.9 ms |
| catch-up pass, 100K blocks | 3.87, 3.95, 4.03 s |
| ingest merge, 2K-block page | 57.0, 58.4, 59.5 ms |

What they say:

- The idle tick costs about 17 ms every 2 s at 10K files, under 1% of one core. Polling stays cheap at that size, so the scan's cost alone does not call for `notify`.
- A change to a 2K-block page costs about 58 ms of background work per tick, off the UI thread. That is not the freeze logseq/db-test#1510 describes.
- A full pass costs about 0.7 ms per page at 5 blocks a page, so 10K pages take about 7 s on the background task. It runs at start, when the folder is set, on resume, after a sync naming no page, and hourly.

None of these is a problem to fix.

## Verification

- `io_bench --bench --test mirror_` passes every case, alone and under a name filter.
- Building with `cargo bench -p agaric --bench io_bench --no-run` failed every other time with cargo #6313's `expected Pool<Sqlite>, found a different Pool<Sqlite>`, as `benches/AGENTS.md` warns; a straight retry built.
- `target/debug` (17 GB) was cleared to fit the release build.
