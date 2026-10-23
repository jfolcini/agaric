# Session 2890 — ctutils 0.4.4 for RUSTSEC-2026-0385

`cargo deny`'s advisories check went red on every PR: RUSTSEC-2026-0385 reports non-constant-time mask generation and `u128` comparisons in `ctutils` before 0.4.4, a transitive dependency. Both lockfiles move it to 0.4.4 with `cargo update -p ctutils --precise 0.4.4`: `src-tauri/Cargo.lock` and the fuzz workspace's own lock. Nothing else moved.

`cargo deny check advisories` passes locally. CI compiles the bump; it is a patch release.
