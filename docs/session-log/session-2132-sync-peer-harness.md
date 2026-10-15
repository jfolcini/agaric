# Session 2132 — A headless sync peer for the real-backend lane

#5365's sync scenarios need a second device, and the real-backend lane drives
one app. `e2e_sync_peer` (`src-tauri/diagnostics/src/bin/`) is that device:

- It opens its own vault and runs the app's own sync daemon and commands on
  it.
- It is scripted over stdin with one JSON command per line, and reports on
  stdout.
- It lives in `agaric-diagnostics`, so it never ships in the bundle.

`e2e-tauri/sync-peer.ts` drives it. `sync-two-device.e2e.ts` is the first
spec on it:

1. The spec opens Settings › Sync & devices and starts pairing.
2. The peer decodes the dialog's QR, as a phone's camera would. The QR
   carries the app's address, which a CI runner cannot rely on mDNS to find.
3. A session is a pull by the device that dials (#610), so the app has to
   dial the peer as well. Pairing leaves it no address for the peer, so the
   spec types one into the device list, as a user without mDNS would.
4. One edit crosses in each direction, and both sides are checked.

The spec found a product bug: "Sync now" never dialled while the peer was
announcing on mDNS, because the debounce behind it restarted on every mDNS
event. #5595 fixes it; the spec passed against that fix before this
merged. The harness needed its own fix too: the peer now runs `bootstrap_spaces`, or
its writes stay SQL-only and are never exported.

`wdio.conf.ts` builds the peer before the run, and so does a new step in
`e2e-tauri-weekly.yml`. That build recompiles the tauri crates once more,
because `tauri build` builds only the app crate with the CLI's
`custom-protocol` feature.

Lane, at the branch head:

- The peer builds.
- Its five unit tests pass. They cover the stdin protocol: a unit command
  needs only its name, a command missing a field is refused, and `pair`
  takes the QR fields and ignores the QR version.
- Dropping the protocol's `rename_all = "snake_case"` reddened three of them.
- Clippy, cargo-deny and cargo-machete are clean.
- `src-tauri/Cargo.lock` is as cargo writes it. The fuzz lock does not
  involve the diagnostics crate.

The spec itself runs only in CI. `e2e-tauri-weekly` is dispatched on this
branch.
