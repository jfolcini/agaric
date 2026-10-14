# Session 2035 — Fix main: rustls advisories

Four RustSec advisories against rustls 0.23.45 (RUSTSEC-2026-0346 to 0349)
were published, and `cargo deny` turned `lint` red on every PR. rustls
0.23.46 fixes them; `cargo update -p rustls` moves only that crate. The
update also re-pointed an unrelated `syn` edge of
`data-encoding-macro-internal`; that hunk was reverted to keep the lockfile
change to rustls alone, and `cargo metadata --locked` accepts the result.

The fuzz workspace's own lockfile is left alone: no rustls requirement
changed, so it stays valid, and `cargo deny` does not read it.

Suites run: `cargo deny check advisories`, `cargo metadata --locked`.
