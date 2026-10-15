# Session 2118 — Agenda badge-count SLO budget out of runner noise

The weekly `bench-slo` run aborts whenever any probe is over budget, which
leaves every later probe unmeasured. `count_agenda_batch_by_source @ 100K`
did this about one run in six, including a dispatched before-bench for
#5423 on main's code.

Its 30 ms budget dates from before #5538. That change gave the probe the
space filter every command now takes (`SpaceScope::Active` plus
`assign_all_to_slo_space`). The probe now measures what the app runs, and
its typical value moved from about 16 ms to about 20 ms. Production code did
not change. The `batch_resolve` probe in the same runs stayed flat, so the
shift is not a general slowdown. Runner spikes of 27 to 38 ms appear on both
sides of the step, and the 30 ms tripwire sits inside them.

The budget is now 40 ms, twice the mean of the bench-slo runs since #5538.
It still catches a doubling of the typical value and stays far under the
200 ms product target. The evidence is the probe's value in every bench-slo
log since July, pulled from the workflow's job logs.

Nothing compiled locally: the only change is a constant in the bench, and
CI builds it.
