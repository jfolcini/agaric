# Session 4434 — iroh 1.4.1 → 1.5.0

**Ask.** Move the iroh stack to 1.5.0 and show nothing breaks: the LAN-only posture, discovery, QUIC and TLS, and Android. iroh 1.5.0 was six days old; the maintainer waived the 7-day release-age cooldown for it.

**The bump.** `iroh` and `iroh-dns` at `=1.5.0` in `agaric-sync`, `iroh-base` at `=1.5.0` in `agaric-store`. `iroh-mdns-address-lookup` re-resolves to 0.6.1, the newest release and the one already locked, now built against iroh 1.5.0. No source change.

- iroh 1.5.0 requires `noq`, `noq-proto` and `noq-udp` 1.5.0, `netwatch` and `portmapper` ^0.20.2 and `iroh-relay` ^1.4.2, so those move with it; `netwatch` and `portmapper` 0.20.2 were a few hours short of seven days old and have no older release iroh accepts. They bring `netdev` 0.47.0, `igd-next` 0.18.0, `netlink-proto` 0.13.0 and `simple-dns` 0.13.1.
- `iroh-relay` 1.5.0 asks for `lru` ^0.19, and cargo picks 0.19.2, two days old. Both lockfiles hold 0.19.0: `lru = "=0.19.0"` in `agaric-sync/Cargo.toml` for the one resolve, then removed, as session 4431 did for the Loro family.

**Release notes, 1.4.2 and 1.5.0, checked in the crate sources.**

- Relay and DNS defaults: nothing. `endpoint/presets.rs` and `address_lookup/` are byte-identical between 1.4.1 and 1.5.0, and so is all of `iroh-dns`. The 1.4.2 fixes are in the relay actor and the relay's frame codec, which a `RelayMode::Disabled` endpoint never runs.
- The opt-in internet fallback (#4549): `RelayUrl` now adds a trailing slash to a path that lacks one, and the relay's own paths are joined under the URL. Agaric pins `iroh::defaults::prod::default_na_east_relay()`, whose path is `/`, and stores no relay URL, so a 1.4.1 device and a 1.5.0 device still name the same relay.
- QUIC: noq 1.5.0 adds per-stream path affinity and removes unfair send scheduling, both local, plus receive-path fixes. Nothing Agaric sets is deprecated (clippy with `-D warnings` is clean). TLS: `rustls` does not move.
- Android: `ndk-context` and `jni` are the versions `netdev` 0.46.2 used; `netdev` 0.47.0 only shares its netlink helpers with the Linux backend, and `netwatch`'s Android monitor is unchanged. `android_context.rs` needs nothing. CI never launches the APK on a PR, so `android-launch-smoke.yml` is dispatched on the branch.

**Not checked.** A 1.4.1 device syncing with a 1.5.0 device over a real link: two iroh versions of one major cannot be linked into one test binary.

**Left alone.** `sync_daemon/tests/endpoint_follows_network.rs` records a by-hand observation "on iroh 1.4.1"; it was not repeated on 1.5.0.

**Ran.**
- `cargo nextest run --workspace -E 'package(agaric-sync)'`: 1,071 passed, the `transport::endpoint` guard tests among them.
- `cargo clippy --workspace --all-targets -- -D warnings`, `SQLX_OFFLINE=true cargo check --workspace --all-targets`, `cargo deny check`, `cargo machete`.
- The whole-workspace suite and the doc-tests, in the pre-push verify.
