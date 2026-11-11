# Session 3822 — hickory-proto 0.26.2 clears five new RustSec advisories

- On 2026-11-11, `cargo deny` started failing `lint` on every PR (first seen on #6509) with new advisories against `hickory-proto` 0.26.1, RUSTSEC-2026-0487 through 0491. Each says it's fixed in 0.26.2.
- Both `src-tauri/Cargo.lock` and `src-tauri/fuzz/Cargo.lock` move `hickory-proto` to 0.26.2. Nothing else moves: the version and checksum lines only.
- `cargo update -p hickory-proto --precise 0.26.2` under the pinned 1.95.0 toolchain also re-linked unrelated range dependencies to older versions (`windows-sys` 0.61.2 → older lines, `syn` 3.0.3 → 1.0.109, `getrandom` 0.4.2 → 0.3.4). That happens with `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=allow` too. Those hunks were not kept: the lock keeps exactly the `hickory-proto` change that the update made, whose dependency list is unchanged.
- Checked:
  - `cargo metadata --locked` accepts both lockfiles as they are;
  - `cargo fetch --locked` verifies the new checksum;
  - `cargo deny check` reads `advisories ok, bans ok, licenses ok, sources ok`. On `main` the advisories fail.
