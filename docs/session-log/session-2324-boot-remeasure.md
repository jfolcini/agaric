# Session 2324 — Boot re-measured after #5418 step 2: the rehydrate dominates at scale

#5419 (show the window before recovery; gate writes, sync and MCP read-write)
was parked until #5418 step 2 shipped and boot was re-measured. Step 2 is in
0.18.0. This is the re-measure, with the committed harness
(`scripts/measure-boot.mjs`) and the frontend `boot resolved` milestone added
in session 2284.

**Method.** Isolated release boots: Wayland stripped, a private D-Bus, no
network, the run's own XDG directories, and a `.backup` copy of the vault.
There were 14 boots per scenario, in two passes of seven. The box was busy
with other builds (load 7–16), so absolute numbers run high and spreads are
wide. The scenarios:
- a copy of the maintainer's vault at rest;
- the same with 789 ops rewound, the busy case;
- a synthetic vault seeded through the app's own commands with
  `e2e_sync_peer`: 5,000 pages, 99,992 blocks and 140,305 ops.

Medians in ms:

| Step | Vault, quiet | Vault, busy | Synthetic 100K |
|---|---|---|---|
| process start → first log line | 235 | 175 | 139 |
| log start → rehydrated | 84 | 71 | 1,562 |
| log start → replay done | 94 | 708 | 1,664 |
| log start → sync started | 102 | 808 | 1,783 |
| log start → `boot resolved` | 700 | 1,312 | 2,154 |
| frontend part | 563 | 466 | 372 |
| Loro rehydrate | 26 | 21 | 1,512 |
| replay | 4 | 607 | 7 |

**Reading.**
- On the real vault at rest, about 100 ms of backend work precedes the
  window. The window opens 2–3 ms after the backend finishes, so the
  frontend part is webview load plus JS boot, which B+C cannot hide.
- The busy case needs a crash since #5418 step 2; a clean exit leaves one
  op.
- At 100K blocks the Loro rehydrate is about 85% of the time before the
  window. It imports a 30 MB snapshot holding the whole op history, then
  rebuilds the block index.

**Decision, per #5419's gate.** One step dominates, so trim it synchronously
before considering B+C. The rehydrate trim is filed separately, and #5419
waits for that re-measure.

**Harness fixes.**
- The copy skips the vault's `logs/`. Otherwise a vault that has booted
  before feeds its old milestone lines to the harness first.
- The harness records `window focus changed` as an optional milestone,
  separating the backend from the webview.

Before and after every run, the mtimes under the real
`~/.local/share/com.agaric.app` were unchanged, and so were the baseline's
mtimes and checksum.

Gates: `node --check`, oxlint and oxfmt on the harness. It has no test of
its own.
