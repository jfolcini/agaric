# Session 2165 — The backlink badge-count SLO budget leaves runner noise

`count_backlinks_batch @ 100K` (`interactive_slo`) failed the weekly lane at
105.05 ms against its 100 ms budget on a branch whose Rust was identical to
main, where the same probe had measured 99.46 ms hours earlier.

It is not a regression. Normalised against `count_agenda_batch_by_source` in
the same log, the probe is flat at about 3.9x (mean 3.94, range 3.49–4.35)
across 23 bench-slo runs from 10-06 to 10-16, with no step at any commit.
Its SQL and fixture have not changed since June. Its absolute value follows
runner speed: 47–105 ms across those runs.

The budget is now 160 ms: twice the 81.7 ms mean of the 22 runs since #5538,
the convention #5576 used for the agenda badge budget, and under the 200 ms
product target at 100K blocks. It still catches a doubling of the typical
value. The 100 ms budget dated from the first gate (May), when the probe
measured about 62 ms.
