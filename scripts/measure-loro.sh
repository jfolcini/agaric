#!/usr/bin/env bash
# Measure what one space's Loro engine costs (snapshot size, export, rehydrate,
# heap, cold first sync, the attachment scan) and what a write costs on a vault
# pulled from a peer beside the vault that wrote it (#6563, for #6811).
#
#   scripts/measure-loro.sh [MAX_BLOCKS]
#
# MAX_BLOCKS skips the Loro scales above it (10000 skips the 100K one); default:
# every scale. Prints the benches' result lines and keeps the whole output in
# $MEASURE_LORO_LOG (default src-tauri/measure-loro.log). Measurement only: no
# threshold, nothing here fails on a number.
#
# The profile is the release one without LTO, as the numbers in
# docs/architecture/operations.md § Loro engine cost were taken: the shipped
# thin LTO does not finish on a shared box. CI sets the shipped values instead so
# the lane's earlier bench build is reused.
set -euo pipefail

cd "$(dirname "$0")/../src-tauri"
log="${MEASURE_LORO_LOG:-measure-loro.log}"
export CARGO_PROFILE_BENCH_LTO="${CARGO_PROFILE_BENCH_LTO:-off}"
export CARGO_PROFILE_BENCH_CODEGEN_UNITS="${CARGO_PROFILE_BENCH_CODEGEN_UNITS:-16}"
if [ -n "${1:-}" ]; then
  export LORO_SNAPSHOT_MAX_BLOCKS="$1"
fi

# One criterion filter for both groups; every other group's fixtures still run
# whatever the filter says, which costs about a minute.
cargo bench --bench engine_bench -- 'loro_snapshot|pulled_vault' 2>&1 | tee "$log" \
  | grep -E '^(loro_snapshot_bench|pulled_vault_bench):'
