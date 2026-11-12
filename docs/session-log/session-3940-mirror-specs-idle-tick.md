# Session 3940 — Mirror specs for a checkout and a space turned off, and the idle tick per setting

#5363: two real-backend checks the issue's test box asks for, and the idle-tick cost of each setting.

## The change

- **A checkout while reading back is off** (`e2e-tauri/mirror-read-back.e2e.ts`, a second test). With reading back off, every file is rewritten at once, as a checkout of another branch writes them. Once a pass has seen each file (listed as diverged and pending), two new pages are created in turn and their files awaited. The test then checks that no page that existed before changed, and that every file still holds what the checkout wrote.
- **A space turned off gets no new file** (`e2e-tauri/mirror-spaces.e2e.ts`). After the space is off, a page is added to it, then a block in a mirrored page is edited. Once that page's file shows the edit, no file exists for the new page.
- **The idle tick per setting** (`benches/groups/mirror_bench.rs`). `mirror_idle_tick` runs once per setting over one vault: 10K pages in one space and 100 in a second. The settings are the defaults, reading back off, copying on, and the second space turned off. `insert_space` builds a space's pages, for `vault` and for the second space.

## What the waits rest on

A pass runs only when something changed, so `last_pass_ms` neither advances each tick nor shows that a pass saw a given change. The first versions waited on it: the spaces spec timed out on its first real run, and the read-back wait could have been met by a pass already running.

A changed file is first left to settle for a tick, which lists it as diverged too. So the listing alone comes before any read-in, and the read-back test went green with the read-back gate removed. The two later passes, each shown by a new page's file, close that gap: the second began after the first ended. The first test in that spec makes its "page unchanged" check at the settling tick too, and it also passed with the gate removed. It is left as it was here and reported to the coordinator.

## Tests

- **Real backend:**
  - `just e2e-real e2e-tauri/mirror-read-back.e2e.ts`: passed;
  - `just e2e-real e2e-tauri/mirror-spaces.e2e.ts`: passed.
- **Falsified**, each in one command that restored `src/mirror/mod.rs` on exit:
  - The ingest no longer gated on reading back (`self.ingest.clone()`): the checkout test failed on the page comparison.
  - `load_layout` laying out an off space's pages the mirror had not written: the spaces spec failed on its last assertion, with a file for the new page. Its earlier checks, which still held, passed.
- **The bench:** `cargo bench --bench io_bench -- mirror_idle_tick`, three rounds. The first round stopped at a time limit before `space_off`. Each figure is Criterion's estimate.

  | Setting | Rounds 1 / 2 / 3 | Against the default |
  | --- | --- | --- |
  | default | 19.5 / 19.4 / 22.8 ms | the noise band, about ±10% |
  | read_back_off | 15.7 / 11.8 / 14.8 ms | faster in every round, outside the band |
  | copy_files_on | 20.4 / 18.2 / 17.4 ms | inside the band: no measurable change |
  | space_off | — / 20.3 / 20.3 ms | inside the band: no measurable change |

  The vault links no attachment, so `copy_files_on` measures the setting's fixed cost per tick only. `space_off` leaves out 100 pages of 10,100.
