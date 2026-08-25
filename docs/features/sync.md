<!-- markdownlint-disable MD060 -->
# Sync

Agaric syncs across your own devices over local WiFi. **No cloud, no accounts, no third-party servers.** Edits converge automatically via CRDT — there is no conflict dialog because there are no merge conflicts to resolve.

## What you can do

- **Pair a new device** via QR code (scan with the new device's camera) or by typing a 4-word passphrase.
- **See your paired devices** in Settings → Sync & Devices (the **DeviceManagement** tab).
- **Manually trigger a sync** from the sidebar's Sync button.
- **Cancel an in-flight sync** while it's running.
- **Unpair** a device (with confirmation).
- **Rename a device** so it's recognisable in your list.
- **Set a manual address** for an already-paired peer on your subnet, when mDNS discovery is unavailable. This does not help a device you have not paired yet, and does not reach across subnets — see the pitfalls below.

## Pairing flow

1. On the **first device**: Settings → Sync & Devices → *Pair new device*. The **PairingDialog** opens with a QR code and a 4-word passphrase. The session lasts 5 minutes (the countdown pauses while you're typing on the other side).
2. On the **second device**: same path. Choose *Scan QR code* (camera) or *Enter passphrase* (4 word boxes).
3. On scan / entry, each device proves it knows the passphrase and the two add each other to their peer lists. There is no certificate exchange: the connection itself authenticates each device's cryptographic key, and that key is remembered on first contact (TOFU) — subsequent connections must present the same one.
4. The first sync runs immediately. Large vaults use **snapshot catch-up** (see below) so you don't wait for thousands of small operations.

If the camera isn't available (no permission, headless device), you can also upload a screenshot of the QR code.

If you click the Sync button before any device is paired, the **NoPeersDialog** appears with a direct path into the pairing flow.

## What the user sees

- **Sidebar Sync button** with a status dot:
  - Grey: idle.
  - Spinning + blue: syncing now.
  - Red: last attempt failed (toast offers *Retry*).
  - Strikethrough WiFi: offline.
- **Tooltip** on the Sync button: state plus *"Last synced N ago"*.
- **Per-peer progress** while a sync is running (operations sent / received, then attachment-file transfer with byte progress).
- **Retry toast** per peer on failure — partial failures don't blow up the whole batch.

## How sync runs

- **Discovery**: mDNS announces and discovers peers on the local network. On Android, Agaric holds a multicast lock so mDNS keeps working when the screen is off.
- **Automatic triggers**: edits queue a debounced sync; the daemon also runs a periodic resync tick. Both back off exponentially on failure, per peer, with jitter so two devices don't lock-step.
- **Offline / foreground awareness**: a device that goes offline stops trying immediately; a device that backgrounds skips its resync ticks until foreground. Coming back online retries immediately.
- **Wire**: QUIC (over UDP), encrypted with TLS 1.3. CRDT operations, snapshots and attachment bytes all flow over the same connection.

> **A first-ever pair has now been observed on real hardware**: a Linux desktop
> and an Android phone, both on 0.9.8 and on the same WiFi, completed a first
> pair over QUIC, the responder logging that it accepted an unpaired device on a
> verified passphrase proof. Two things had to be cleared first and neither was
> Agaric — a VPN on **the phone** that swallowed every unicast dial to the
> desktop, and a default-deny firewall on **the desktop**. Both are pitfalls
> below, and which device carries which is worth noting: the capturing tunnel was
> on the handset.
>
> **A full two-way sync end to end is still unverified (#3507)**: the
> initiator-side apply that aborted on `blocks.parent_id` (#4083) was fixed
> afterwards and has not yet been exercised against two live devices. Nor has
> a genuinely restrictive network: the fabric carried multicast fine and the two
> blockers were host configuration on either end — though the fabric was not
> blameless, since it was numbered out of *public* address space, and that is what
> made the phone's VPN treat the whole subnet as internet-bound. An isolated guest
> network, AP/client isolation and two subnets all remain untested. The run is recorded in
> [`session-1345`](../session-log/session-1345-first-live-pair-and-what-it-cost-to-believe-the-tools.md).

## Snapshot catch-up

When a peer is so far behind that the log has been compacted past its frontier (typical on a fresh device, or after a long absence), the responder sends a full snapshot instead of replaying the log. Snapshots stream as raw bytes on the same connection and apply atomically, so a snapshot apply can never half-fail. It is a *merge*, not a wipe: anything you wrote on the catching-up device that the other side had not seen yet survives. The first sync of a fresh device on a large vault might take a moment; subsequent syncs are incremental.

## Per-peer settings

In **DeviceManagement** you can per-peer:

- **Rename** the device (the name shows up in tooltips, sync progress, the activity feed).
- **Set a manual address** (`host:port`) for an already-paired peer on your subnet that mDNS hasn't surfaced (e.g. it hasn't re-announced since a restart). It is not a way to reach another network — see the pitfalls below.
- **View status** (last sync, last error).
- **Unpair** — confirmation required (non-reversible without re-pairing).

## What's not synced

- **Local-only state**: keyboard customisations, sidebar width, recent tabs, last-opened view per space, theme preference, draft autosave entries that never persisted.
- **Link preview cache** (each device fetches independently).
- **MCP / agent activity feed** (per device).

## Pitfalls to know

- **Both devices must be on the same local network — always, and for a first pair specifically it must also carry multicast.** Agaric does not relay over the internet, and pairing for the first time requires working mDNS multicast between the two devices — that's currently the only way a device learns how to dial the other. If multicast doesn't reach (an isolated guest WiFi, AP/client isolation, multicast disabled on the router, two subnets), there's no way to complete a first pair — not even by typing an address, since the manual-address field only appears for a peer you've already paired.
- **A VPN can swallow the LAN even when both devices are on the same WiFi.** If the tunnel is not bypassable, whether your LAN escapes it depends on the address range the router hands out: a LAN numbered out of *public* address space is treated as internet-bound and routed into the tunnel. That range can look local without being private — `192.160.x.x` is one digit from `192.168.x.x` and is public. Link-local multicast (`224.0.0.251`, which mDNS uses) still escapes, which makes the symptom distinctive and misleading: **discovery works and every connection attempt dies** — the other device appears in your list and no sync ever starts. Turning the VPN off is the test. **Check every device, not just the desktop** — in the one recorded case the capturing tunnel was an enterprise profile on the Android phone, and the desktop was fine. Note also that this symptom has had at least one other cause: before #3853 a desktop bound its Docker bridge and advertised that over mDNS, which looks identical from the outside. **Since #4299 the app names this case itself**: when a dial times out against a peer mDNS is still announcing, Agaric asks the operating system which *source address* it would actually send that peer's traffic from, and if that address falls outside the subnet the sync endpoint bound — outside it, not merely different from it, so a second address on your own LAN (a `br0` bridge, a docked laptop's other NIC) is never mistaken for a tunnel — the peer's failure reads *"discovered on the network, but traffic to this device is being routed elsewhere - a VPN or firewall may be capturing your LAN"* instead of a bare timeout. The measurement is about **this** device's own routing, so the message appears on the captured device — the other end still shows a bare timeout, which is one more reason to check every device. It is a diagnosis, not a fix — the sync still does not happen until the capture is lifted — and it deliberately says *routed elsewhere* rather than *VPN*, because a split-tunnel client, a corporate agent, a mis-scoped default route and a second link on a *different* subnet all produce the same measurement.
- **The manual address is not an across-network route.** Once paired, a peer's row in Device Management gains a manual `host:port` field, but it only helps for a peer on the same subnet Agaric bound — typically one that hasn't re-announced over mDNS yet. The sync endpoint is deliberately LAN-confined: it installs no relays and binds a single subnet as a non-default route, so a destination outside that subnet has no socket to leave by and the dial cannot be attempted at all. A VPN- or internet-routed address will not work.
- **First-launch firewall prompt** (especially on macOS): allow incoming connections so peers can reach Agaric. Agaric listens on **UDP**, and on a port the operating system picks fresh at each launch — so a hand-written rule has to allow the application, not a fixed TCP port. On Linux there is no prompt at all: a `ufw` or firewalld default-deny policy drops the inbound half silently, and since the port moves every launch the workable rule names the interface and protocol rather than a port: `ufw allow in on <iface> proto udp from <subnet>` — for example `from 192.168.1.0/24`. Scope it to the **subnet**, not to a single peer address: a default-deny policy drops inbound mDNS too, so the machine that needs this rule is precisely the one whose peer never appeared in the device list to have its address read off. A single-host form (`from <peer-ip>`) is tighter once you do know the address, but it is pinned to that peer's current DHCP lease, so a lease rotation silently reinstates the drop unless you also hold a DHCP reservation. Either form grants more than Agaric — it opens **every** UDP port on that interface to the permitted source, which is the price of a port the OS picks fresh at each launch.
- **mDNS on Android needs multicast — built in.** Some routers disable multicast; if your other devices can see each other on the network but Agaric can't, that's the likely cause.
- **TOFU on first pair.** If you re-install Agaric on a peer and its app data is wiped, the device comes back with a different cryptographic identity — you'll need to unpair and re-pair.
- **Upgrading from a pre-QUIC build re-establishes trust once.** Existing pairings survive the upgrade, but the old certificate could not be converted into the new key, so each pair silently re-learns the other's identity on its first sync after the update. Do the first post-upgrade sync on a network you trust.
- **A desktop on both WiFi and Ethernet only accepts on one of them.** If two devices are on the same LAN but only reachable across different interfaces, they may show up in discovery and still fail to connect. Agaric prefers a physical interface over a cellular or virtual one, and between two of the same kind it prefers the one carrying your default route — so it is usually the interface your other internet traffic already uses. Unplugging the one you do *not* want it on is the reliable way to force the choice.
- **Pairing session is 5 minutes.** If the timer expires, restart from the first device.
- **The Sync button does the minimum.** It triggers what's already due; if you've just edited something, the auto-sync may have already fired by the time you click.
- **Unpairing only takes effect on the device you do it from.** There is no message telling the other device it has been unpaired — that device keeps its half of the pairing and keeps trying to sync, and every attempt is refused. It notices on its own within a minute or two and its entry for you turns into a **Pairing lost** state that says to pair again; until then it may still show a recent sync time. To be rid of a pairing on both sides, unpair on both, or pair again to revive it.
- **Unpaired by mistake?** Pair again from either device. The new pairing replaces the previously remembered identity via TOFU, and clears the *Pairing lost* state on the device that was left behind.
