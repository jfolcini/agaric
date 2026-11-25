# Session 4419 — advisory waivers that match nothing fail the check

**Ask.** Main's `validate / lint` was red on `cargo deny`. Drop the stale advisory waivers and make the check fail on them, so they are cleaned up as they go stale.

**Why main was red.** Two new advisories: `url` 2.5.8 (RUSTSEC-2026-0592, `Url::origin()` recursion) and `cookie` 0.18.1 (RUSTSEC-2026-0594, private-jar nonce reuse after fork). Under them were 21 `advisory-not-detected` warnings.

**One view.** `deny.toml` pruned the graph to four targets and left unsound advisories in transitive crates out, so `cargo deny` saw less than `cargo audit`, OSV and Scorecard. A waiver could look stale to one and live to the others, and the file said not to trust the warning. With no `targets` and `unsound = "all"`, `cargo deny` reads the whole lockfile, and licenses, bans and sources stay clean. In that view, 17 of the 21 waivers match nothing: the ten GTK3 notices RustSec withdrew on 2026-08-14, fxhash and the five unic crates (no longer in the lockfile), and rand's thread_rng notice (every rand copy is patched). The other four (atomic-polyfill, `im::OrdSet`, glib, sized-chunks) are live and stay.

**Strict.** `unused-ignored-advisory = "deny"` fails `cargo deny` on a waiver that matches nothing. The npm-audit hook runs `better-npm-audit --json` and fails on an unused `.nsprc` waiver. The full prek suite runs both on main every night, so a waiver is flagged the night after its advisory is withdrawn or patched, even with no dependency change.

**What the wider view found.**
- rustix 1.1.4 (RUSTSEC-2026-0486): updated to 1.1.6.
- heapless, nine advisories: 0.7 (postcard) and 0.8 (loro-delta) have no fix, and 0.9.4 clears the release-age gate only later today, so they are waived. In non-test code, postcard, loro-delta and generic-btree use only `heapless::Vec`, which no advisory names except the panicking-Drop one. The release profile's `panic = "abort"` covers that one.

**The fixes still in the cooldown.** `url` 2.5.9 (published 2026-11-20) and `cookie` 0.18.3 (2026-11-23) are younger than the 7-day release-age gate, so they are waived with the date each clears it. Neither Agaric, Tauri nor wry calls `Url::origin()`. Tauri builds `cookie` without its `private` feature, so the vulnerable jar is not compiled in. When either is bumped, its waiver goes unused and the check fails until the waiver is deleted.

**npm.** The picomatch waiver matched nothing: npm audit no longer reports GHSA-fc5q-39xc-vjpf. The minimatch waiver was two numeric keys, one for each ID npm serves. better-npm-audit also matches an entry named by its GHSA ID against the advisory URL, so one entry named GHSA-g3hv-75wg-m249 replaces both.

**Falsified.** A probe waiver for RUSTSEC-2025-0057 in `deny.toml` fails `cargo deny check advisories` with `advisory-not-detected`. A probe for GHSA-fc5q-39xc-vjpf in `.nsprc` fails `scripts/npm-audit-retry.sh`. Turning the unused check off reddens the new wrapper test.

**Ran:** `cargo deny check` (all four ok), `scripts/cargo-audit-guard.sh`, `scripts/npm-audit-retry.sh`, `node --test scripts/npm-audit-retry.test.mjs scripts/sbom.test.mjs`, `node scripts/sync-audit-from-deny.mjs --check`, prek on the changed files (pre-commit and manual stages).

**The nightly deep checks' other reds.** `full-suite-nextest (2)` ran every real-backend spec in one Playwright process with no `--shard`, against the config's 25-minute `globalTimeout`, which is sized for one shard. The three nights before took 21.0 to 21.6 minutes. On 2026-11-24 the runner was slow (nextest took 213 s against about 135 s), and 103 specs did not run before the ceiling, with none failing. The bridge run is now split across both legs with `--shard "$SHARD/2"`. The weekly `stale-pins` lane was red on `android-emulator`, which `just pin-bump` moved to 16970787. The one failed mutants shard (agaric-engine 12) found no apt index on its runner, an infra fault.
