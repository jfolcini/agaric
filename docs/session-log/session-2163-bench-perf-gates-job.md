# Session 2163 — The 20k perf gates get their own job

`bench-slo` (scheduled-deep-checks) did two full Rust compiles in one job:
the bench-profile build for `interactive_slo`, then a test-profile build for
the `#[ignore]`d 20k-row perf gates. Five of its last twelve runs hit the
45-minute cap, including the 2026-10-16 dispatch on main (run 38857201664):
every `interactive_slo` probe had passed by 06:24, the perf-gate compile
started at 06:24:20, and the job was cancelled at 06:28. So the Pages sort
gates had not run to completion on main.

The perf-gate steps move verbatim into a new `bench-perf-gates` job, gated
on the same lane selection and run in parallel, with its own Rust cache key
that it never saves: no deep-check cache was restored by a later run, and
every save evicts gate caches under the repo's 10 GB limit.
`bench-slo` goes from 45 to 55 minutes: setup, the cold bench build and all
probes took up to 41.4 minutes in that run. `bench-perf-gates` gets 25: the
nextest work took up to 9.2 minutes where it finished. Both jobs restore no
Rust cache today: branch dispatches don't save it, and main's run never got
to its save step.

Not fixed here: `created_and_alphabetical_sort_perf_gate_20k_pages` and
`conformance_fuzz` failed on branch runs, and five failures were
`interactive_slo` budget panics. Those are results, not lane problems.
