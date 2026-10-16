# Session 2192 — A committed boot-timing harness

#5418's replay numbers (chunked replay against a copy of the real vault) came
from a harness that lived only in a session scratchpad, and AGENTS.md says a
performance claim needs a committed one that reproduces it.
`scripts/measure-boot.mjs` is that harness ported to Node. It boots each
release binary on a fresh copy of a vault backup with the apply cursor
rewound, A/B interleaved. It reads replay and sync-start milestones from the
JSON log and prints per-binary medians. `src-tauri/benches/AGENTS.md` points
to it, since boot time is not a bench.

What it needs to be safe is in its header: a `.backup` copy rather than the
live vault, `AGARIC_E2E_SANDBOX` so a missing data dir fails the boot, no
network so the copied identity cannot sync, and a private D-Bus so the
single-instance plugin cannot hand off to a running Agaric. The frontend's
"boot resolved" moment is not timed: `main` logs no milestone for it, and
#5418's claim rests on the backend ones.

Validated with two rounds of two scratch builds against a vault copy with
789 ops rewound. Every milestone was found, the copies were removed, and no
process was left behind. The first round ran cold for both binaries, hence
the header's five-round advice. Those numbers came from a loaded box and are
not a measurement.
