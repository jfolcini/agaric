# Session 4485 — the taken-port test holds its port from the start

`a_taken_port_falls_back_and_the_new_one_is_kept_6526` failed once in tonight's full Rust run. The panic was at the test's own `UdpSocket::bind(first)`, with `AddrInUse`. The test launched a daemon, stopped it, and only then bound the port the daemon had released. Anything that bound that port in the gap failed the test before the daemon was involved.

**Fix.** The test binds a port on `OLD_NETWORK` itself, seeds it as the kept port with `peer_refs::set_sync_port`, and holds it through one launch. It still asserts that the launch falls back to a new port on the same IP and keeps that port for the next launch. `the_next_launch_binds_the_port_the_last_one_bound_6526` still covers a launch keeping the port it bound.

The sibling test has the same shape of gap, between its two launches, but it has not failed, and a held port would defeat what it tests. It is unchanged.

**Ran.**
- The three port tests in `endpoint_follows_network`: 3 passed.
- With the supervisor's `set_sync_port` call disabled, the test goes red at its `get_sync_port` assertion (kept 51941, bound 43360).
- `cargo clippy -p agaric-sync --all-targets -- -D warnings` and `cargo fmt --all --check`.
