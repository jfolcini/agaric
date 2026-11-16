# Session 4235 — the Rust mutation lane posts no annotations

Run 43825257615 showed about 45 "Missed mutant" warnings while its filer reported zero Rust findings. Under Actions, cargo-mutants posts a warning for every miss it sees.

- **Scan misses:** most come from the scan pass, which runs a filtered test subset. The confirm pass then kills them, as it did `SyncMessage::variant_name`.
- **Confirm misses:** the rest are confirm-pass survivors that `mutation-accepted.tsv` already records as equivalent.

Both `cargo mutants` calls in `scheduled-deep-checks.yml` now pass `--annotations=none`. The tracker issues stay the report.

## What ran

- The run's merged `missed.txt` (13 lines) through `node scripts/file-mutation-survivors.mjs --lane rust --dry-run`: 13 found, 13 suppressed as accepted.
- `prek run --files .github/workflows/scheduled-deep-checks.yml`.
