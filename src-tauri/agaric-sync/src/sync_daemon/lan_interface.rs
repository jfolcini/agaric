//! Which local interface the sync endpoint binds, and why (#3853).
//!
//! ## The bug this module replaces
//!
//! `lan_bind_target` used to walk `if_addrs::get_if_addrs()` and return the
//! **first** interface whose address satisfied `Ipv4Addr::is_private()`. Two
//! independent defects fell out of that single loop, both measured on the
//! maintainer's hardware:
//!
//! * **`is_private()` is not "the LAN".** RFC 1918 is `10/8`, `172.16/12`,
//!   `192.168/16` and nothing else. A LAN numbered `192.160.160.0/24` — which
//!   *looks* private and is not — was skipped on both devices, so each fell
//!   through to something unrelated. On a host with no RFC 1918 interface at
//!   all the loop fell all the way to loopback and sync was silently dead.
//! * **First match is not the right match.** `docker0`, `lxdbr0`, `incusbr0`,
//!   `veth*`, `br-<hash>`, WireGuard / Tailscale tunnels and VM bridges are all
//!   equally "private" and commonly enumerate before the real NIC. The
//!   maintainer's desktop bound `192.168.32.1` (a bridge) while its LAN address
//!   was `192.160.160.80`, then advertised the bridge over mDNS.
//!
//! Both defects are invisible at runtime: the bind succeeds, mDNS announces,
//! the daemon logs "started", and the two UIs spin until the session TTL.
//!
//! ## The policy
//!
//! [`decide`] is a **pure function** over a list of candidate interfaces plus an
//! optional "which address does the default route leave from" hint. It never
//! touches the OS, so the whole policy is table-testable — the previous code had
//! no test that could have caught either defect, because any test of it would
//! have had to assert something about the host's real interfaces.
//!
//! Candidates are first **rejected outright** for reasons that make an address
//! unusable as a LAN bind at all (see [`Verdict`]), then the survivors are ranked:
//!
//! 1. **Class**: the kind of link it sits on ([`LinkKind`]) first, then whether the
//!    address is CGNAT. Hard-ordered, best first:
//!    1. physical-named, ordinary unicast
//!    2. physical-named, CGNAT (`100.64/10`)
//!    3. cellular WAN, ordinary unicast
//!    4. cellular WAN, CGNAT
//!    5. virtual or point-to-point, ordinary unicast
//!    6. virtual or point-to-point, CGNAT
//! 2. **The default route**, as a tiebreak *within* a class.
//! 3. Enumeration order, so the result is deterministic.
//!
//! ### Why cellular is its own rank and not folded in with virtual
//!
//! The two are deprioritised for different reasons and by different amounts, and
//! collapsing them costs the case in the middle. A bridge, a tunnel and a soft-AP are
//! links the peer you are pairing with is *definitionally* not on: `docker0`'s
//! neighbours are containers, `wg0`'s are the far end of a tunnel. A carrier link is
//! merely one the peer is *usually* not on — a private or corporate APN can land the
//! device inside an enterprise network where the other device really is reachable, which
//! is why [`CELLULAR_NAME_PREFIXES`] is a deprioritisation and not a rejection.
//!
//! Giving both the same rank made that middle case turn on enumeration order: a modem
//! holding a real subnet tied every up virtual bridge on the host and beat it, or lost to
//! it, on ifindex alone. On a device with no Wi-Fi and no Ethernet — exactly the device
//! whose only address is the modem's — that can bind `docker0` and reproduce #3853 from
//! the other side. Ranking cellular strictly between physical and virtual is what makes
//! the modem lose to a real NIC (which is the point of the list) *and* beat a bridge
//! (which is what it did before the list existed).
//!
//! A hotspot's soft-AP interface (`ap0`) stays [`LinkKind::Virtual`]: #3869 tried
//! promoting it to physical, so a tethering phone would prefer its own hotspot over the
//! cellular link it is sharing, and that promotion was reverted (see the note on
//! [`VIRTUAL_NAME_PREFIXES`]) because it regressed the isolated-LAN case — the one these
//! docs call the interesting one. A real fix for the hotspot case needs a soft-AP ranking
//! key between the route tiebreak and the index, not a class change; see #4108. Note that
//! the cellular rank does **not** supply it: it moves the carrier link *up*, so `ap0` and
//! a modem are still not ordered the way that case wants.
//!
//! ### Why the default route is a tiebreak and not the primary key
//!
//! Issue #3853 suggests "prefer the interface carrying the default route", and
//! that is right on a desktop — but it is exactly wrong on the reporting phone.
//! When a VPN is up the default route deliberately points **away** from the LAN,
//! at a `tun`/`wg` interface. Making the default route the primary key would
//! pick the tunnel and reproduce the bug in a new costume. Ranking class first
//! and using the route only to break ties inside a class keeps the desktop case
//! (the route names the real NIC, which is already the best class) while refusing the
//! phone case (the tunnel is [`LinkKind::Virtual`], or rejected outright as a `/32`).
//!
//! ### What it selects on the two measured configurations
//!
//! Both rows are `ip -4 addr` output, transcribed rather than imagined — the first
//! draft of the desktop row invented `virbr0`/`virbr1`, names the deprioritisation
//! list already caught, and so tested nothing about the real machine.
//!
//! | Device | Interfaces (verbatim) | Selected |
//! |---|---|---|
//! | Desktop | `wlp2s0 192.160.160.80/24` up, `docker0 192.168.32.1/24` DOWN, `lxdbr0 10.0.6.1/24` up, `incusbr0 10.0.7.1/24` DOWN, `zcctun0 100.64.0.1/16` point-to-point | `192.160.160.80` |
//! | Phone | `192.160.160.102/24` (Wi-Fi), `10.70.121.252/32`, `10.193.146.251/32` (VPN), `100.64.0.1/16` (CGNAT) | `192.160.160.102` |
//!
//! `lxdbr0` is why the deprioritisation list is load-bearing on this hardware and not
//! only on a hypothetical one: with no default route to break the tie — an isolated
//! LAN, the router down, Wi-Fi with no internet — or with the bridge on the lower
//! ifindex, `10.0.6.1` wins on enumeration order alone and #3853 reproduces verbatim
//! on the reporter's own desktop.
//!
//! ## Why not `netdev`
//!
//! `netdev` 0.45 is already in the tree (via `netwatch` → `iroh`) and exposes
//! `get_default_interface()`, so a direct dependency looked free. It is not:
//!
//! * On Android its interface enumeration goes through
//!   `os::android::api::collect_interface_extras`, gated on the crate's
//!   **default** `android-extra` feature, which calls
//!   `panic::catch_unwind(ndk_context::android_context)`. Under this repo's
//!   `[profile.release] panic = "abort"` `catch_unwind` does not catch, so a
//!   missing Android context is a SIGABRT — the precise hazard
//!   [`crate::android_context`] exists to document and #3847 removed from our
//!   own call sites. A direct `netdev` call would put one back.
//! * Its default-route lookup is itself a UDP `connect()` probe, and it probes
//!   `10.254.254.254` — inside RFC 1918. On a host with 10/8 virtual networks
//!   (which is the maintainer's desktop: `10.0.6.1`, `10.0.7.1`) that probe can
//!   be captured by a virtual interface's route instead of the default route,
//!   which is the very confusion being fixed here.
//!
//! [`default_route_source_ipv4`] is therefore ~10 lines of our own, probing
//! `192.0.2.1` (TEST-NET-1, RFC 5737 — guaranteed never to be a real LAN and
//! never routed on the internet). No packet is sent: `connect(2)` on a UDP
//! socket only performs a routing-table lookup and fixes the source address.
//!
//! ## Residual coverage — what this change still does not pin
//!
//! Listed rather than left to look covered. The failure #3853 kept reproducing is *a
//! rule that is correct but not wired in*, and it recurs at every seam that needs the
//! real host or a live daemon; naming those seams is the only honest substitute for a
//! test of them.
//!
//! * **`daemon_loop`'s mDNS announce.** `session_supervisor::daemon_loop` passes the
//!   selected `lan_ip` to `MdnsService::announce`; replacing that argument with `None`
//!   compiles and leaves the whole suite green. Pinning it needs a `SyncDaemonContext`
//!   (pool, materializer, scheduler, identity) *and* a live `mdns_sd::ServiceDaemon` —
//!   which the crate already records as unavailable to unit tests, see
//!   `handle_mdns_init_result_no_event_path_is_ok_only` — and `daemon_loop` does not
//!   return. Both seams *under* it are pinned: the bind side by
//!   `lan_bind_target_returns_the_bind_policy_decision_not_a_fallback`, and the record
//!   side by `mdns::tests::the_announced_record_carries_exactly_the_bound_address`. What
//!   remains unpinned is the pair of hops between them:
//!   `daemon_loop` → `MdnsService::announce` → `announce_info`.
//! * **`daemon_loop`'s `host_addrs` argument.** The same seam, one hop earlier:
//!   `session_supervisor::daemon_loop` hands [`BindDecision::host_addrs`] to
//!   `SyncService::bind`, and replacing that argument with `&[]` compiles and leaves the
//!   suite green — because every test binds loopback or an RFC 1918 address, which the
//!   locality gate waves through whatever list it is given. It goes wrong only on a host
//!   whose LAN is numbered out of public space, which is the reporting hardware and no CI
//!   runner. Both seams around it *are* pinned: that `SyncService::bind` reads the list it
//!   is given rather than a fresh sweep, by
//!   `transport::service::tests::the_locality_gate_reads_the_host_addresses_the_caller_passed`,
//!   and that the list this decision yields satisfies the gate, by
//!   `the_bind_gate_is_answered_from_the_sweep_that_chose_the_address`. What is unpinned
//!   is the argument between them, for the same reason the announce above is: `daemon_loop`
//!   needs a full `SyncDaemonContext` and does not return.
//! * **Machine-conditional halves of the host-reading tests.** Three assertions are
//!   exercised only on a machine that has the interface in question, and are *equivalent
//!   mutants* — not silent gaps — on machines that do not: the public `lan_only` gate
//!   (`transport::endpoint`) needs a publicly-routable address the host holds; the
//!   `operstate down ⇒ not up` direction of the flag cross-check needs a NO-CARRIER
//!   interface carrying IPv4; and its `IFF_POINTOPOINT` direction needs a
//!   point-to-point interface carrying IPv4. The reporting desktop has all three
//!   (`192.160.160.80`, `docker0`/`incusbr0`, `zcctun0`); a plain CI runner has none.
//!   The `operstate unknown ⇒ up` direction is asserted to have run, so the branch this
//!   module's `is_up` mapping turns on is never vacuous on any Linux host that exposes
//!   `/sys/class/net`.
//! * **Non-Linux flag mappings, and Linux without `/sys`.** The cross-check reads
//!   `/sys/class/net` and is Linux only, and skips where a hardened container runtime
//!   masks that directory — there is no kernel answer to compare against, and a test with
//!   no oracle that fails is reporting on the sandbox, not on this code. On Windows
//!   `if_addrs` reports the adapter's real RFC 2863 status, where `Unknown` means "the
//!   adapter did not say" rather than POSIX's "no carrier", so rejecting it there is
//!   stricter than it needs to be. Untestable from here, and not changed on speculation.
//! * **The production route probe's destination.** `route_source_ipv4` is pinned against
//!   loopback; that TEST-NET-1 is the right target for the real probe is an argument
//!   about which routes could capture it, and no test on one machine can settle it.

use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};

use crate::transport::endpoint::{MIN_IPV4_PREFIX_LEN, is_publicly_routable};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/// One IPv4 address on one local interface, reduced to the fields the policy reads.
///
/// Deliberately **not** `if_addrs::Interface`: the policy must be exercisable from a
/// table of literals, and `if_addrs::Interface` carries a platform-conditional field
/// (`adapter_name` on Windows) that a test table cannot spell portably.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LanInterface {
    /// Kernel interface name (`eth0`, `wlan0`, `docker0`, `tun0`, …).
    pub name: String,
    /// The IPv4 address assigned to it.
    pub ip: Ipv4Addr,
    /// The CIDR prefix that came with the address.
    ///
    /// **Only meaningful once [`is_contiguous_netmask`] has passed on [`Self::netmask`]**
    /// — see that field. [`rejection`] applies that gate before it reads this value, so
    /// nothing downstream of a [`Verdict`] sees a prefix derived from a mask that does
    /// not describe a subnet.
    pub prefix_len: u8,
    /// The netmask that came with the address, carried verbatim (#4105).
    ///
    /// Not redundant with [`Self::prefix_len`], because on POSIX the prefix is *derived*
    /// from this and the derivation cannot fail. `if-addrs` 0.15 computes it as
    /// `netmask.octets().count_ones()` with **no contiguity check**
    /// (`if-addrs-0.15.0/src/lib.rs:283`), so a non-contiguous mask yields a
    /// plausible-looking prefix that describes no subnet at all: `255.0.255.0` arrives
    /// here as `prefix_len == 16`. That value is not cosmetic — [`BindDecision::prefix_len`]
    /// becomes `BindOpts::set_prefix_len`, the egress confinement that keeps the endpoint
    /// LAN-only — so a fictitious prefix is a confinement boundary that is either too
    /// narrow (real LAN peers unreachable) or too wide. Keeping the mask lets
    /// [`rejection`] refuse such an interface instead of binding the fiction, and lets
    /// [`BindDecision::passed_over`] name the mask in the log so the host is diagnosable.
    ///
    /// On Windows the direction is reversed and the check is a no-op: `prefixlen` is the
    /// OS's own `IP_ADAPTER_UNICAST_ADDRESS.OnLinkPrefixLength` and `if-addrs`
    /// *synthesises* the mask from it bit by bit, so it is contiguous by construction.
    ///
    /// **`prefix_len == 0` stays ambiguous, deliberately.** On POSIX `if-addrs`
    /// substitutes `0.0.0.0` both for a NULL `ifa_netmask` — which `getifaddrs(3)`
    /// documents as possible — and for a netmask that is not an `AF_INET` sockaddr
    /// (`lib.rs:272`), so "the kernel said /0" and "there was no readable netmask" are
    /// the same two values here and no check in this module can separate them. That is
    /// not a gap this fix can close: the information is gone before the crate returns.
    /// Both land on [`Verdict::PrefixTooBroad`] (a `/0` cannot confine egress either
    /// way), which is the outcome either reading wants, and `0.0.0.0` *is* contiguous, so
    /// the contiguity gate deliberately says nothing about it.
    pub netmask: Ipv4Addr,
    /// The interface is operationally up — `if_addrs::IfOperStatus::Up`.
    ///
    /// **What that actually means, per platform**, because the RFC 2863 enum name is
    /// misleading and the difference decides whether the strict `== Up` mapping is a bug.
    /// On POSIX (`if-addrs` 0.15 goes through `getifaddrs(3)`) the crate synthesises the
    /// status from a single bit: `IFF_RUNNING` set → `Up`, clear → `Unknown`. It never
    /// returns `Down`, so `Unknown` there *is* "no carrier". Linux sets `IFF_RUNNING`
    /// when the link is administratively up **and** `netif_oper_up()`, which counts
    /// `IF_OPER_UNKNOWN` as up — the backward-compatibility case for drivers that never
    /// call `netif_carrier_*`. A tun/tap, a loopback or a NIC whose driver reports
    /// `operstate unknown` therefore arrives here as `Up`, not as a rejection.
    ///
    /// Measured on the reporting desktop: `lo` and `zcctun0` (`operstate unknown`) → `Up`;
    /// `docker0` and `incusbr0` (`operstate down`, NO-CARRIER) → `Unknown`. Treating
    /// `IfOperStatus::Unknown` as usable would make this field unconditionally `true` on
    /// every POSIX host and readmit `docker0 192.168.32.1` — the exact address #3853 bound.
    ///
    /// Windows is the exception: there the value is the adapter's real
    /// `IP_ADAPTER_ADDRESSES::OperStatus`, where `Unknown` does mean "the adapter did not
    /// say". Rejecting it there is stricter than necessary; see the residual note on
    /// `the_flag_mapping_matches_what_the_kernel_reports`.
    pub is_up: bool,
    /// `IFF_POINTOPOINT`. True for `tun`/`ppp`-style tunnels whatever they are named.
    pub is_p2p: bool,
}

impl LanInterface {
    /// Test/`decide` convenience constructor.
    ///
    /// The netmask is derived from `prefix_len`, so every fixture built this way is
    /// contiguous — which is what the ordinary case is. The non-contiguous fixtures
    /// #4105 needs are built with `tests::with_netmask`, which sets the two
    /// independently and is the only way to spell the disagreement.
    #[cfg(test)]
    fn new(name: &str, ip: &str, prefix_len: u8) -> Self {
        Self {
            name: name.to_owned(),
            ip: ip.parse().expect("test literal is a valid IPv4 address"),
            prefix_len,
            netmask: netmask_for_prefix(prefix_len),
            is_up: true,
            is_p2p: false,
        }
    }
}

/// The contiguous netmask `prefix_len` names — the inverse of `count_ones` on a
/// well-formed mask.
///
/// Test-only: production reads the mask the OS reported and never reconstructs one, so
/// that a disagreement between the two is visible rather than papered over.
/// `pub(crate)` because `session_supervisor`'s tests build candidates too.
#[cfg(test)]
pub(crate) fn netmask_for_prefix(prefix_len: u8) -> Ipv4Addr {
    // `u32::MAX << 32` is a shift overflow, so /0 is spelled out rather than shifted.
    let bits = if prefix_len == 0 {
        0
    } else {
        u32::MAX << (32 - u32::from(prefix_len.min(32)))
    };
    Ipv4Addr::from(bits)
}

/// Is `netmask` a well-formed netmask — set bits first, clear bits after, no gaps?
///
/// A mask is contiguous iff its leading one-bits and trailing zero-bits account for all
/// 32 of them. `255.255.255.0` gives `24 + 8`; `0.0.0.0` gives `0 + 32`;
/// `255.255.255.255` gives `32 + 0`. The non-contiguous `255.0.255.0` gives `8 + 8`,
/// which is the case #4105 is about — `count_ones` calls it a `/16` and nothing
/// downstream can tell that the `/16` describes no subnet the interface is on.
///
/// Stated as leading+trailing rather than the `!m + 1` power-of-two identity because the
/// latter wraps to zero on `0.0.0.0` and so needs a special case for the one mask most
/// likely to be a *substituted* value rather than a reported one.
fn is_contiguous_netmask(netmask: Ipv4Addr) -> bool {
    let bits = u32::from(netmask);
    bits.leading_ones() + bits.trailing_zeros() == 32
}

/// Interface-name prefixes that name a *virtual* interface.
///
/// Matching is by name prefix, which is a heuristic and is treated as one: a hit only
/// **deprioritises** a candidate, it never excludes it. A host whose only interface is a
/// bridge still gets that bridge rather than loopback.
///
/// `br-` carries its hyphen deliberately. Docker's user-defined networks are
/// `br-<hash>`, while a plain `br0` is the conventional name for a bridge a user built
/// on purpose and may well be their LAN.
///
/// `bridge` is the macOS form and is safe to take whole, because every `bridgeN` there is
/// system-created: `bridge0` is the Thunderbolt/AWDL bridge and `bridge100`+ are Internet
/// Sharing, which is otherwise an ordinary-looking `192.168.2.1` outranking nothing. It
/// does not collide with Linux's user-built `br0` (see
/// `bare_br0_is_not_treated_as_a_docker_network`), and a Mac that *is* sharing its
/// connection still binds `bridge100` when that is its only rankable interface.
///
/// # This list is best-effort, and deprioritisation is what makes that acceptable
///
/// A name cannot actually tell you what an interface is for, and several entries here are
/// *wrong on some hosts*: `vmbr0` on Proxmox, `lxdbr0` on an LXD host and `incusbr0` on an
/// Incus one are frequently the machine's real LAN bridge, with the physical port enslaved
/// to them and carrying no address of its own. Because a hit only reorders, the case that
/// matters most is still correct: when such a bridge is the only rankable candidate it is
/// selected anyway, and when the machine also has an addressed physical NIC the bridge
/// losing to it is the right answer.
///
/// **The residual case**, stated rather than papered over: a Proxmox/LXD host where
/// `vmbr0`/`lxdbr0` *is* the LAN **and** some other deprioritised interface is also
/// addressed and up — a Tailscale or Docker interface, say. Both are then
/// [`LinkKind::Virtual`] with an ordinary address, so the class ordering has nothing left
/// to say and the default-route hint alone decides. On
/// such a host the route normally leaves via the LAN bridge, which is the right answer;
/// with no default route (isolated LAN, router down) the tie falls to enumeration order
/// and the choice is arbitrary. That is loud rather than silent — more than one candidate
/// is rankable, so the decision is a WARN carrying the full `passed_over` list — and
/// fixing it properly needs the routing table, not a name.
///
/// Adding a prefix is therefore cheap only when the name is *system-assigned*: entries
/// that a user could plausibly have chosen for their own LAN interface do not belong here.
///
/// # `ap0` is deliberately still here (#3869, reverted)
///
/// `ap0` — the Android / Linux soft-AP interface — is the one name on this list that was
/// briefly removed. #3869 promoted it to physical so that a tethering phone would prefer
/// its own hotspot over the cellular link it is sharing, and that promotion was
/// reverted: once `ap0` is [`LinkKind::Physical`], the only thing separating it from the
/// LAN the device
/// actually joined is the default-route tiebreak, and that tiebreak has nothing to say
/// with no default route (an isolated LAN — see the module docs) or when the route hint
/// names a *third* interface (a wired uplink or VPN carrying the route while the LAN is
/// Wi-Fi). Either way the tiebreak falls through to enumeration order, and a soft-AP that
/// happens to come up first wins, taking the device off the LAN it joined — the same
/// failure shape #3853 described, with the roles reversed. See
/// `a_hotspot_does_not_outrank_the_lan_the_device_actually_joined` for the pinned
/// property and the mechanism in more detail.
///
/// [`CELLULAR_NAME_PREFIXES`] is the other, independently correct half of #3869 and is
/// unaffected by this revert: a carrier link is deprioritised because no LAN peer can
/// ever be on it, which does not depend on `ap0`'s class.
///
/// The real fix needs a soft-AP ranking key that sits *between* the route tiebreak and
/// the index — narrow enough to prefer `ap0` over a same-class carrier link without ever
/// outranking a joined LAN — which is a ranking change, not a name-list edit, and is not
/// made here. Tracked at #4108.
///
/// Vendors also name the soft-AP `wlan1`, `swlan0` or `softap0`; none of those are on
/// this list, so they are already treated as physical and unaffected by any of this.
const VIRTUAL_NAME_PREFIXES: &[&str] = &[
    "docker",    // Docker's default bridge + gwbridge
    "br-",       // Docker user-defined networks (NOT bare `br0`, see above)
    "virbr",     // libvirt
    "lxd",       // LXD bridges (`lxdbr0`)
    "incusbr",   // Incus bridges (`incusbr0`)
    "vmbr",      // Proxmox bridges
    "bridge",    // macOS system bridges: `bridge0` AWDL, `bridge100`+ Internet Sharing
    "vEthernet", // Hyper-V / WSL2 host adapters (`vEthernet (WSL)`)
    "veth",      // container veth pairs
    "vmnet",     // VMware
    "vboxnet",   // VirtualBox
    "tun",       // OpenVPN / generic TUN (also caught by `is_p2p` on Linux)
    "tap",       // OpenVPN / generic TAP
    "utun",      // macOS / iOS tunnels
    "wg",        // WireGuard
    "tailscale", // Tailscale
    "zt",        // ZeroTier
    "p2p0",      // Android Wi-Fi Direct (a transient negotiation link, not the hotspot)
    "ap0",       // Android / Linux soft-AP: deliberately still deprioritised — see the
                 // doc comment above (#4108)
];

/// Does this name look like a virtual interface?
fn has_virtual_name(name: &str) -> bool {
    VIRTUAL_NAME_PREFIXES
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

/// Interface-name prefixes that name a *cellular WAN* link (#3869).
///
/// Deprioritised for a reason none of [`VIRTUAL_NAME_PREFIXES`] can claim: a carrier link
/// is not a broadcast domain the user's other device can be on. A bridge at least has
/// neighbours — containers, VMs, a tethered peer — so the residual case there is "the
/// bridge really is the LAN". On a consumer APN the peer you are trying to pair with is
/// not on your mobile operator's access network, whether that hands out CGNAT
/// `100.64/10` or, as several operators do, ordinary `10/8` space.
///
/// It is not an *absolute*: a private or corporate APN can land the device inside an
/// enterprise network where another device really is reachable. That is why this is a
/// deprioritisation and not a rejection, and why the rank it is given is
/// [`LinkKind::Cellular`] — strictly below a physically-named NIC, strictly *above* a
/// bridge or a tunnel. It therefore loses to any Wi-Fi or wired NIC, which is the right
/// answer even on such an APN, and still beats `docker0`/`virbr0`/a VPN, which is what it
/// did before this list existed. An earlier revision of this list gave it the same rank
/// as a bridge, which on the corporate-APN device — no Wi-Fi, no Ethernet, one up bridge
/// — left ifindex to choose between the only link with a peer on it and a link with
/// none.
///
/// This was introduced alongside an attempt to have a phone acting as a hotspot rank its
/// soft-AP interface **above** the cellular link it is sharing, by promoting `ap0` to the
/// physical rank (see the note on [`VIRTUAL_NAME_PREFIXES`]). That promotion was reverted
/// — it regressed the isolated-LAN case — and `ap0` therefore stays [`LinkKind::Virtual`],
/// which a cellular link now outranks. So the hotspot-vs-carrier case this was meant to
/// fix is not merely unfixed, it is ordered the wrong way round; it is tracked, still
/// open, at #4108.
///
/// This list stays regardless, because it earns its keep independently: it is the same
/// treatment the module docs give the VPN case — the default route deliberately pointing
/// away from the LAN — applied to a carrier link, rank on what the link *is* and let the
/// route only break ties inside a class. That keeps a LAN NIC winning over a cellular
/// uplink even when the uplink happens to carry the default route (a laptop LTE modem
/// with a lower route metric than Wi-Fi, say), which sharing the physical rank with the
/// LAN would not have prevented.
///
/// Deprioritisation, not rejection, for the usual reason: a phone with no Wi-Fi has
/// nothing else, and a single rankable cellular interface is still selected (see
/// `a_cellular_interface_is_still_chosen_when_it_is_the_only_candidate`).
///
/// # How often this actually fires, measured
///
/// On a Pixel 8 (Android 15) the kernel exposes `rmnet0`..`rmnet29`, but only the two
/// carrying a live PDN hold an IPv4 address at all — and each holds it as a **`/32`**
/// (`10.73.39.114/32`, `10.89.153.63/32`). [`rejection`] already refuses those as
/// [`Verdict::HostRoute`] before any ranking runs, so on that hardware this list changes
/// nothing and the 28 address-less `rmnet*` links never reach [`host_candidates`] either.
/// It bites where a modem is handed a subnet rather than a host route — laptop
/// `wwan*`/`wwp*` cards and operators that hand out a real prefix — which is the case
/// `a_cellular_uplink_does_not_outrank_the_lan_even_via_the_route_hint` fixtures with a
/// `/24`. Android's own `rmnet*` shape (a `/32`, rejected before ranking runs, per the
/// measurement above) is not this case, which is why the hotspot-vs-carrier scenario
/// #4108 tracks is not exercised here.
///
/// # Both spellings of a laptop WWAN card
///
/// `wwan` is the *kernel's* name. On any distribution with systemd's predictable naming
/// on — which is every mainstream one — udev renames the card to `ww` + its topology, so
/// the ordinary spelling of the laptop modem this list is justified by is
/// `wwp0s20f0u6i12` (the path form: PCI bus `0`, slot `s20`, function `f0`, USB port
/// `u6`, interface `i12`), which `wwan` does not match. Without `wwp` the one case the
/// list exists for was the one case it missed.
///
/// `wwp` rather than bare `ww`: `ww` would also cover the `wwx<mac>` and `wws<slot>`
/// forms, but a two-character prefix is below the bar this list sets — it is short enough
/// that a name a user chose could collide with it, and the path form is what a USB modem
/// (i.e. all of them) actually gets. Checked against every name in this module's own test
/// tables under `starts_with`: `wwp` matches `wwan0`? no; `wg0`? no; `wlan0`, `wlp2s0`,
/// `veth7a1b`, `vmbr0`, `br0`? no. Nothing outside `ww*` begins with two `w`s.
///
/// Every entry is a modem name assigned by a driver, udev or the RIL, never by a user,
/// which is the bar [`VIRTUAL_NAME_PREFIXES`] sets for adding a prefix. Deliberately
/// *not* here: `ppp`, which is already caught by `IFF_POINTOPOINT`, and `usb0`/`rndis0`,
/// which name the *receiving* end of USB tethering — a link whose peer is precisely the
/// device we want to reach.
const CELLULAR_NAME_PREFIXES: &[&str] = &[
    "rmnet",  // Qualcomm / Android (`rmnet0`, `rmnet_data0`, `rmnet_ipa0`)
    "ccmni",  // MediaTek
    "pdp_ip", // iOS / older Android PDP contexts
    "wwan",   // Kernel-style WWAN (`wwan0`) — ModemManager, laptop WWAN cards
    "wwp",    // systemd/udev predictable WWAN (`wwp0s20f0u6i12`) — see above
    "qmimux", // QMI multiplexed carrier channels
];

/// Does this name look like a cellular WAN interface?
fn has_cellular_name(name: &str) -> bool {
    CELLULAR_NAME_PREFIXES
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

/// `100.64.0.0/10` — RFC 6598 carrier-grade NAT.
///
/// Not `is_private()`, and not internet-routable either. It is what a CGNAT'd mobile
/// network hands out, so it can be a device's only address — hence deprioritised rather
/// than rejected.
fn is_cgnat(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 100 && (64..128).contains(&o[1])
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

/// What the policy concluded about one candidate.
///
/// The rejection variants are the *hard* exclusions — an address for which binding
/// cannot produce a reachable LAN endpoint. Everything else is ranked, and the
/// `PassedOver*` variants record why a rankable candidate lost, which is what the log
/// line needs: #3853's whole difficulty was that nothing ever said what was passed over.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Verdict {
    /// The address the endpoint will bind.
    Chosen,
    /// RFC 2863 operational state is not `Up` — on POSIX, `IFF_RUNNING` is clear, i.e.
    /// no carrier (see [`LanInterface::is_up`]).
    ///
    /// A rejection rather than a deprioritisation, which is the opposite call from the
    /// virtual-name heuristic two fields down, and deliberately so. That heuristic can be
    /// *wrong* about a usable interface, so it only reorders; "no carrier" is the kernel
    /// reporting a fact, and an address on a link with no carrier reaches no peer. The
    /// alternative — rank it last but keep it — would bind a dead link and log success,
    /// whereas rejecting it produces the loopback fallback, which is loud and says sync
    /// is unreachable. On the reporting desktop this is what refuses `docker0`.
    NotUp,
    /// `127.0.0.0/8`. Binding it is the fallback, never a selection.
    Loopback,
    /// `169.254.0.0/16` — an address a host assigns itself when DHCP failed.
    LinkLocal,
    /// Unspecified / broadcast / multicast / documentation: not a unicast host address.
    NotUnicast,
    /// A `/32`. There are no on-link neighbours in a host route, so binding it confines
    /// egress to the address itself — functionally identical to loopback for LAN sync.
    /// This is what the two `10.x.x.x/32` VPN addresses on the reporting phone are.
    HostRoute,
    /// A prefix broader than [`MIN_IPV4_PREFIX_LEN`], which `lan_only` would reject
    /// anyway because it cannot confine egress to a LAN.
    PrefixTooBroad,
    /// The netmask has a gap in it, so no prefix length describes this interface's
    /// subnet (#4105).
    ///
    /// A rejection, for the same reason [`Self::NotUp`] is one: the alternative is
    /// binding a prefix that is *known* to be wrong. `if-addrs` derives the prefix by
    /// counting set bits, so `255.0.255.0` arrives as a confident-looking `/16` and
    /// becomes the egress-confinement boundary — either too narrow, and peers on the
    /// real subnet are unreachable, or too wide. Refusing produces the loopback fallback
    /// (loud, and it says sync is unreachable) or lets a sane interface win instead,
    /// where binding the fiction is silent and wrong. The mask itself is in
    /// [`BindDecision::passed_over`], because "not contiguous" without the value is not
    /// something an operator can act on.
    NetmaskNotContiguous,
    /// Rankable, but a virtual / point-to-point interface and a better class existed.
    PassedOverVirtual,
    /// Rankable, but a cellular WAN interface and a better class existed (#3869).
    ///
    /// Distinct from [`Self::PassedOverVirtual`] because the reason text is the whole
    /// point of these variants and "virtual or point-to-point interface" is untrue about
    /// `rmnet0` — which is also frequently `IFF_POINTOPOINT`, so the two facts overlap and
    /// the more specific one is reported.
    PassedOverCellular,
    /// Rankable, but CGNAT and a better class existed.
    PassedOverCgnat,
    /// Rankable, but *both* virtual / point-to-point **and** CGNAT (the worst class).
    ///
    /// Its own variant rather than folding into [`Self::PassedOverVirtual`]: the reporting
    /// desktop's `zcctun0 100.64.0.1` is exactly this pair, and a log line that names only
    /// the tunnel half sends the reader looking for the address reason that is already
    /// known. Selection is unaffected — [`class`] already ranks the pair last.
    PassedOverVirtualCgnat,
    /// Rankable, but *both* cellular **and** CGNAT — the ordinary shape of a carrier
    /// interface, and the same "name both halves" argument as
    /// [`Self::PassedOverVirtualCgnat`] (#3869).
    PassedOverCellularCgnat,
    /// Rankable and in the winning class, but the winner carried the default route and
    /// this candidate did not.
    ///
    /// Split from [`Self::PassedOverEnumerationOrder`] in #3869. One variant used to cover
    /// both, reporting "does not carry the default route" even when `route_hint` was
    /// `None` and *nothing* carried it — an audit line stating a cause that did not apply,
    /// in exactly the isolated-LAN case the module argues is the interesting one.
    PassedOverDefaultRoute,
    /// Rankable and in the winning class, and the default route did not separate the two:
    /// the winner was simply enumerated first.
    ///
    /// This is the arbitrary outcome — the residual case the `VIRTUAL_NAME_PREFIXES` docs
    /// describe — and saying so is the difference between a reader checking their routing
    /// table for an answer that is there and one checking it for an answer that is not.
    ///
    /// **"Did not separate them" is not "there is none."** This verdict is emitted
    /// whenever [`default_route_source_ipv4`]'s answer fails to name the winner *alone*,
    /// which is three different situations: there is no default route; there is one and it
    /// leaves via an address that is not in contention; or it names an address that the
    /// loser holds too (the same IP on two interfaces). The middle one is not
    /// hypothetical — it is what the measured Pixel 8 does, where the probe answers with
    /// an `rmnet*` `/32` that [`rejection`] has already filed as [`Self::HostRoute`]. An
    /// earlier wording said "no default route separated them", which reads as the first
    /// situation and is false in the other two; that is the same family of untruth #3869's
    /// item 3 removed from [`Self::PassedOverDefaultRoute`], so the reason text now names
    /// all three.
    PassedOverEnumerationOrder,
}

impl Verdict {
    /// Human-readable reason, for the log line.
    fn reason(self) -> &'static str {
        match self {
            Self::Chosen => "chosen",
            Self::NotUp => "interface is not operationally up",
            Self::Loopback => "loopback",
            Self::LinkLocal => "link-local 169.254/16 (DHCP failed)",
            Self::NotUnicast => "not a unicast host address",
            Self::HostRoute => "/32 host route — no on-link peers (VPN / point-to-point)",
            Self::PrefixTooBroad => "prefix too broad to describe a LAN",
            Self::NetmaskNotContiguous => {
                "netmask is not contiguous, so no prefix describes this subnet"
            }
            Self::PassedOverVirtual => "virtual or point-to-point interface",
            Self::PassedOverCellular => "cellular WAN interface — no LAN peer is on it",
            Self::PassedOverCgnat => "CGNAT 100.64/10 — a carrier network, not a LAN",
            Self::PassedOverVirtualCgnat => {
                "virtual or point-to-point interface, on CGNAT 100.64/10"
            }
            Self::PassedOverCellularCgnat => {
                "cellular WAN interface, on CGNAT 100.64/10 — no LAN peer is on it"
            }
            Self::PassedOverDefaultRoute => "does not carry the default route",
            Self::PassedOverEnumerationOrder => {
                "same class as the chosen interface, and the default route did not \
                 separate them (there is none, it leaves via an address neither holds, or \
                 it names both) — chosen on enumeration order"
            }
        }
    }
}

/// Hard exclusions, applied before any ranking.
fn rejection(candidate: &LanInterface) -> Option<Verdict> {
    if !candidate.is_up {
        return Some(Verdict::NotUp);
    }
    let ip = candidate.ip;
    if ip.is_loopback() {
        return Some(Verdict::Loopback);
    }
    if ip.is_link_local() {
        return Some(Verdict::LinkLocal);
    }
    if ip.is_unspecified() || ip.is_broadcast() || ip.is_multicast() || ip.is_documentation() {
        return Some(Verdict::NotUnicast);
    }
    // Before either prefix gate (#4105): both of those read `prefix_len`, and on a
    // non-contiguous mask that value is `count_ones` of a mask with a gap in it — a
    // number that passes or fails those gates for no reason connected to the interface's
    // actual subnet. `255.0.255.0` sails through both as a `/16`.
    if !is_contiguous_netmask(candidate.netmask) {
        return Some(Verdict::NetmaskNotContiguous);
    }
    if candidate.prefix_len >= 32 {
        return Some(Verdict::HostRoute);
    }
    if candidate.prefix_len < MIN_IPV4_PREFIX_LEN {
        return Some(Verdict::PrefixTooBroad);
    }
    None
}

/// What kind of link a candidate sits on — the *primary* ranking key, best first.
///
/// Three ranks rather than "on the LAN / off it", because the two ways of being off the
/// LAN are not equally bad and the difference decides a real case (#3869 follow-up):
///
/// * [`Self::Physical`] — nothing says this is not the user's LAN, so it is the default
///   and the best rank. `usb0`/`rndis0` land here deliberately: they are the *receiving*
///   end of USB tethering, a link whose peer is precisely the device we want to reach.
/// * [`Self::Cellular`] — a carrier link ([`CELLULAR_NAME_PREFIXES`]). Usually no LAN
///   peer is on it, but "usually" is the operative word: a private or corporate APN can
///   put the device inside a network where the peer really is reachable.
/// * [`Self::Virtual`] — a virtual-named ([`VIRTUAL_NAME_PREFIXES`]) or point-to-point
///   (`IFF_POINTOPOINT`) link. The peer is *definitionally* not on it: `docker0`'s
///   neighbours are containers, `wg0`'s is the far end of a tunnel.
///
/// The `Ord` derive **is** the ranking, so the declaration order above is load-bearing:
/// `Physical < Cellular < Virtual`.
///
/// A candidate that is both cellular-named and `IFF_POINTOPOINT` — which `rmnet*`
/// routinely is — is [`Self::Cellular`]. That is the same call [`decide`] makes when it
/// picks the loser's [`Verdict`]: "cellular WAN" is the fact that explains the ranking,
/// where "point-to-point" merely restates a flag.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum LinkKind {
    /// Nothing in the name or the flags says this is not a LAN.
    Physical,
    /// A cellular WAN link (#3869).
    Cellular,
    /// A virtual-named or point-to-point link.
    Virtual,
}

/// Which kind of link this candidate sits on.
fn link_kind(candidate: &LanInterface) -> LinkKind {
    if has_cellular_name(&candidate.name) {
        LinkKind::Cellular
    } else if candidate.is_p2p || has_virtual_name(&candidate.name) {
        LinkKind::Virtual
    } else {
        LinkKind::Physical
    }
}

/// Ranking class — **lower is better**, and the `Ord` derive is the whole ordering.
///
/// A struct with two ordered fields rather than a hand-numbered `u8`: the ordering the
/// module docs describe is exactly "link kind, then CGNAT", and writing it as a widened
/// key means adding a rank cannot silently renumber the ones around it. The `u8` this
/// replaced folded cellular in with virtual, which tied a modem holding a real subnet
/// with every up bridge on the host and left ifindex to separate them.
///
/// Field order is the key order: `link` dominates, so a physical CGNAT address still
/// outranks an ordinary virtual one — that was true of the numbered form too and is the
/// right call, since CGNAT is a fact about the address and the link kind is a fact about
/// who can be on the other end of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Class {
    /// What kind of link the address sits on.
    link: LinkKind,
    /// The address is CGNAT `100.64/10` — a carrier network, not a LAN.
    cgnat: bool,
}

/// The best class there is: an ordinary unicast address on a physically-named link.
///
/// Named rather than spelled out at the one comparison that needs it, because "the winner
/// is not in the best class" is the condition, not "the winner's class is greater than
/// some literal".
const BEST_CLASS: Class = Class {
    link: LinkKind::Physical,
    cgnat: false,
};

/// Ranking class — lower is better. See the module docs for the ordering rationale.
fn class(candidate: &LanInterface) -> Class {
    Class {
        link: link_kind(candidate),
        cgnat: is_cgnat(candidate.ip),
    }
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/// Severity the caller should log the decision at.
///
/// Split out from the `tracing` call so a test can assert "this fires a WARN" without a
/// subscriber. The loopback fallback used to be a single WARN nobody read; a decision
/// that passed something over is now equally loud, because #3853's desktop *did* find a
/// candidate — so the old warning never fired and nothing looked wrong.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Level {
    Info,
    Warn,
}

/// The outcome of [`decide`]: where to bind, and the full audit trail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BindDecision {
    /// The socket address to hand `SyncService::bind`.
    pub bind: SocketAddr,
    /// The prefix to confine egress to: the chosen interface's own netmask, verbatim.
    ///
    /// Never below [`MIN_IPV4_PREFIX_LEN`], and not because anything clamps it —
    /// [`rejection`] refuses a broader prefix outright, where the reason can be logged
    /// next to the alternatives instead of being silently widened into a bind the
    /// interface does not actually describe. An earlier revision clamped here as well,
    /// which was unreachable code: no value reaching this point can be below the
    /// minimum.
    ///
    /// And it is a prefix that genuinely came from a netmask: [`rejection`] refuses a
    /// non-contiguous mask ([`Verdict::NetmaskNotContiguous`], #4105), so the
    /// `count_ones` `if-addrs` performs cannot hand this field a number that describes
    /// no subnet.
    pub prefix_len: u8,
    /// The selected LAN address, or `None` when this is the loopback fallback.
    ///
    /// `None` is the caller's signal that **no peer can reach this endpoint**.
    pub lan_ip: Option<Ipv4Addr>,
    /// Every candidate and what was concluded about it, in enumeration order.
    pub verdicts: Vec<(LanInterface, Verdict)>,
    /// The chosen address is reachable from outside the LAN (#3853, SECURITY.md).
    ///
    /// The locality gate in `lan_only` was widened from "RFC 1918" to "an address this
    /// host holds", because the reporting user's home LAN is `192.160.160.0/24` — real
    /// public space. That is the right call for them and it has a cost: on a VPS, a
    /// cloud box or a non-NAT ISP connection, the sync listener now starts on an
    /// internet-facing address where it previously refused to start at all.
    ///
    /// There is no address-shaped signal that separates "my LAN is numbered out of
    /// public space" from "I am on a VPS" — the two look identical from inside the
    /// host — so demoting globally-routable addresses in the ranking is not available:
    /// it would put `lxdbr0 10.0.6.1` back ahead of `wlp2s0 192.160.160.80` and
    /// reproduce #3853 on the reporting hardware. What is available is loudness, and
    /// this flag is it: it forces [`Level::Warn`] and selects a log line that says the
    /// listener is reachable from off-LAN.
    pub internet_facing: bool,
    /// How loudly the caller should log.
    pub level: Level,
}

impl BindDecision {
    /// Every IPv4 address this decision was made from, for `lan_only`'s locality gate.
    ///
    /// # Why the bind must not enumerate the host a second time (#3869)
    ///
    /// `lan_only` refuses a publicly-routable bind address unless the host actually holds
    /// it, and it used to answer "does the host hold it" with its own `getifaddrs(3)`
    /// sweep — a second one, taken after this decision had already been made from the
    /// first. Two sweeps are not merely one syscall too many: an address that goes away
    /// between them (DHCP lease expiring, Wi-Fi roaming, a hotspot toggled) makes the
    /// second sweep disagree with the first, `lan_only` return `BindAddressNotPrivate`,
    /// and `daemon_loop` fail outright — where a genuinely address-less host would have
    /// come up on the loopback fallback and said so. The narrow failure was strictly
    /// louder than the total one.
    ///
    /// Threading this list into the bind closes the window by construction: the chosen
    /// address is one of the entries in [`Self::verdicts`], so the gate is answered from
    /// the same enumeration that chose it and the daemon's bind can no longer be refused
    /// for locality at all. The gate keeps its meaning for every other caller of
    /// `lan_only`, which supplies a bind address this module never picked.
    ///
    /// Derived from `verdicts` rather than stored alongside it, so the two cannot drift:
    /// `verdicts` holds every enumerated address — rejected ones included, since loopback
    /// and a NO-CARRIER bridge are addresses the host holds just as much as the winner —
    /// and anything missing from it is missing from the log line too, which is loud.
    ///
    /// IPv4 only, because `decide` only ever ranks and binds IPv4; an IPv6 bind address
    /// would need the v6 half of the sweep and does not arrive from here.
    pub fn host_addrs(&self) -> Vec<IpAddr> {
        self.verdicts
            .iter()
            .map(|(candidate, _)| IpAddr::V4(candidate.ip))
            .collect()
    }

    /// One-line summary of everything that was *not* chosen, for the log.
    pub fn passed_over(&self) -> String {
        let summary: Vec<String> = self
            .verdicts
            .iter()
            .filter(|(_, verdict)| *verdict != Verdict::Chosen)
            .map(|(candidate, verdict)| {
                // A rejected-for-contiguity candidate reports the mask instead of the
                // prefix (#4105). Its `prefix_len` is `count_ones` of a mask with a gap
                // in it — a number that names no subnet — so printing it would put a
                // confident `/16` in the audit line for an interface whose whole problem
                // is that no prefix describes it, and would hide the one value an
                // operator needs to recognise their own host.
                if *verdict == Verdict::NetmaskNotContiguous {
                    return format!(
                        "{}={} netmask {} ({})",
                        candidate.name,
                        candidate.ip,
                        candidate.netmask,
                        verdict.reason()
                    );
                }
                format!(
                    "{}={}/{} ({})",
                    candidate.name,
                    candidate.ip,
                    candidate.prefix_len,
                    verdict.reason()
                )
            })
            .collect();
        if summary.is_empty() {
            "none".to_owned()
        } else {
            summary.join(", ")
        }
    }
}

/// The loopback fallback: bind, accept nothing from outside, and say so.
///
/// Failing to start the daemon instead would take the scheduler, discovery and dormancy
/// down with it, so the daemon still comes up — but this is never quiet.
fn loopback_fallback(verdicts: Vec<(LanInterface, Verdict)>) -> BindDecision {
    BindDecision {
        bind: SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
        prefix_len: MIN_IPV4_PREFIX_LEN,
        lan_ip: None,
        verdicts,
        internet_facing: false,
        level: Level::Warn,
    }
}

/// Choose the interface the sync endpoint binds. Pure — no syscalls, no globals.
///
/// `route_hint` is the source address the kernel would use for an off-link destination
/// (see [`default_route_source_ipv4`]), or `None` when there is no default route or the
/// probe failed. It breaks ties *within* a class and never promotes across classes.
pub(crate) fn decide(candidates: Vec<LanInterface>, route_hint: Option<Ipv4Addr>) -> BindDecision {
    let mut verdicts: Vec<(LanInterface, Verdict)> = Vec::with_capacity(candidates.len());
    let mut rankable: Vec<usize> = Vec::new();

    for candidate in candidates {
        match rejection(&candidate) {
            Some(verdict) => verdicts.push((candidate, verdict)),
            None => {
                // Placeholder; overwritten once the winner is known. Every index pushed
                // here is reassigned in the loop below, and if there is no winner there
                // are no indices, so this value never reaches a log line.
                rankable.push(verdicts.len());
                verdicts.push((candidate, Verdict::PassedOverEnumerationOrder));
            }
        }
    }

    // Best class first; inside a class the default-route holder first; then enumeration
    // order, which the index as the final key makes deterministic.
    //
    // `map(…).min()` rather than `min_by_key(…)` (#4116): `min_by_key` calls its key
    // function on *each comparison*, so `class(candidate)` — up to 26 `starts_with`
    // scans across `VIRTUAL_NAME_PREFIXES` + `CELLULAR_NAME_PREFIXES` — ran O(n log n)
    // times instead of once per candidate. Materialising the key makes it linear and
    // matches the loop below, which already reuses a materialised `class(candidate)`.
    // The measured Pixel 8 enumerates 48 links; this still runs once per daemon start,
    // not per sync, so the change is consistency rather than a measured win.
    let winner = rankable
        .iter()
        .copied()
        .map(|idx| {
            let candidate = &verdicts[idx].0;
            let on_default_route = u8::from(route_hint != Some(candidate.ip));
            (class(candidate), on_default_route, idx)
        })
        .min()
        .map(|(_, _, idx)| idx);

    let Some(winner) = winner else {
        return loopback_fallback(verdicts);
    };

    let winning_class = class(&verdicts[winner].0);
    let winner_ip = verdicts[winner].0.ip;
    // Did the route hint actually decide anything? Only if it names the winner: the
    // winner holds the minimum of `(class, off-route, idx)`, so no loser can be the one
    // on the default route. When it does not name the winner — `None`, or an address no
    // candidate holds — every same-class candidate carried the same route penalty and
    // enumeration order is what separated them. #3869: reporting the route as the cause
    // in that case is an audit line asserting something that did not happen.
    let route_named_the_winner = route_hint == Some(winner_ip);
    for &idx in &rankable {
        if idx == winner {
            verdicts[idx].1 = Verdict::Chosen;
            continue;
        }
        let candidate = &verdicts[idx].0;
        let candidate_class = class(candidate);
        verdicts[idx].1 = if candidate_class <= winning_class {
            // Same class as the winner — a strictly better class is impossible, the
            // winner holds the minimum — so what it lost was the route tiebreak or,
            // failing that, enumeration order. The two are not the same fact and are no
            // longer reported as one. A candidate holding the winner's own address (the
            // same address on two interfaces) tied on the route penalty too, so order is
            // what separated it even when the hint names the winner.
            if route_named_the_winner && candidate.ip != winner_ip {
                Verdict::PassedOverDefaultRoute
            } else {
                Verdict::PassedOverEnumerationOrder
            }
        } else {
            // A strictly worse class, so the verdict names the class — both halves of it
            // where both apply. The reporting desktop's `zcctun0 100.64.0.1` is exactly
            // that pair, and a line naming only one half sends the reader looking for a
            // second reason that is already there. `Class` is the same value the ranking
            // used, so the reason cannot describe an ordering that did not happen.
            match (candidate_class.link, candidate_class.cgnat) {
                (LinkKind::Cellular, false) => Verdict::PassedOverCellular,
                (LinkKind::Cellular, true) => Verdict::PassedOverCellularCgnat,
                (LinkKind::Virtual, false) => Verdict::PassedOverVirtual,
                (LinkKind::Virtual, true) => Verdict::PassedOverVirtualCgnat,
                (LinkKind::Physical, true) => Verdict::PassedOverCgnat,
                // Unreachable: this is `BEST_CLASS`, and the winner holds the minimum, so
                // it cannot be strictly worse than the winner's class. Filed under the
                // order rule rather than panicking — this runs on the daemon's start path
                // and a wrong word in an audit line is not worth taking sync down for.
                (LinkKind::Physical, false) => Verdict::PassedOverEnumerationOrder,
            }
        };
    }

    let chosen = &verdicts[winner].0;
    let bind = SocketAddr::from((chosen.ip, 0));
    // The interface's own netmask, verbatim. Not clamped: `rejection` has already
    // refused anything below `MIN_IPV4_PREFIX_LEN`, so a clamp here could never change
    // a value — it was unreachable code that read like a guard.
    let prefix_len = chosen.prefix_len;
    let lan_ip = Some(chosen.ip);
    // The bind is reachable from off-LAN. See `BindDecision::internet_facing`: this is
    // the one case where the decision can be entirely unanimous and still deserve a
    // warning, because what it widens is the attack surface, not the odds of pairing.
    let internet_facing = is_publicly_routable(&bind);
    // WARN whenever the decision was not unanimous — either more than one candidate was
    // genuinely in contention, or the winner is itself a virtual / CGNAT interface that
    // peers on the physical LAN are unlikely to reach — or when the address we bound is
    // internet-facing.
    //
    // The count is over `rankable`, not `verdicts`. `verdicts` holds every enumerated
    // address including loopback, which every host has and none can bind as a LAN, so
    // `verdicts.len() > 1` was true on every real machine: the daemon warned on every
    // start and the `Info` arm was reachable only from a synthetic list with no loopback
    // in it. That made the internet-facing warning — the whole mitigation for a bind that
    // may be reachable off-LAN — indistinguishable from routine noise. A rejected
    // candidate could never have been bound, so it is not something that was "passed
    // over" in any sense the reader can act on; it still appears in `passed_over()` when
    // one of the other clauses does fire.
    //
    // The quiet case is therefore a host with exactly one rankable ordinary private NIC,
    // whatever else it enumerates alongside — loopback, a NO-CARRIER bridge, a `/32` VPN.
    let level = if internet_facing || rankable.len() > 1 || winning_class > BEST_CLASS {
        Level::Warn
    } else {
        Level::Info
    };

    BindDecision {
        bind,
        prefix_len,
        lan_ip,
        verdicts,
        internet_facing,
        level,
    }
}

// ---------------------------------------------------------------------------
// Host inputs
// ---------------------------------------------------------------------------

/// The IPv4 source address the kernel would use to reach an off-link destination — i.e.
/// the address on the interface carrying the default route.
///
/// **No packet is sent.** `connect(2)` on an unbound UDP socket performs a routing-table
/// lookup and fixes the source address; there is no handshake and no datagram. The
/// destination is `192.0.2.1` — TEST-NET-1 (RFC 5737), a documentation range that is
/// never routed on the internet and never used as a LAN, so the lookup cannot be
/// captured by a virtual interface's route the way `netdev`'s own `10.254.254.254` probe
/// can (see the module docs).
///
/// Returns `None` when there is no default route (`ENETUNREACH`), which is a normal
/// answer on an isolated LAN — the caller then ranks on class alone.
fn default_route_source_ipv4() -> Option<Ipv4Addr> {
    const PROBE: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1)), 9);
    route_source_ipv4(PROBE)
}

/// The IPv4 source address the kernel would use to reach `dest`.
///
/// The destination is a parameter only so a test can aim the probe somewhere with a
/// route that is guaranteed to exist — every host has one for `127.0.0.0/8` — and get a
/// deterministic answer. Nothing in production calls it with anything but the TEST-NET-1
/// address above.
fn route_source_ipv4(dest: SocketAddr) -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0))).ok()?;
    socket.connect(dest).ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(v4) if !v4.is_unspecified() => Some(v4),
        _ => None,
    }
}

/// Every IPv4 interface address on this host, in enumeration order.
fn host_candidates() -> Vec<LanInterface> {
    let interfaces = if_addrs::get_if_addrs().unwrap_or_else(|e| {
        tracing::warn!(error = %e, "if_addrs::get_if_addrs failed; binding loopback only");
        Vec::new()
    });
    interfaces
        .iter()
        .filter_map(|iface| {
            let if_addrs::IfAddr::V4(v4) = &iface.addr else {
                return None;
            };
            Some(LanInterface {
                name: iface.name.clone(),
                ip: v4.ip,
                prefix_len: v4.prefixlen,
                // Carried, not recomputed: `prefixlen` is `count_ones` of this on POSIX,
                // and the two disagree exactly when the mask has a gap in it — the case
                // `rejection` refuses (#4105). See `LanInterface::netmask`.
                netmask: v4.netmask,
                is_up: iface.oper_status == if_addrs::IfOperStatus::Up,
                is_p2p: iface.is_p2p,
            })
        })
        .collect()
}

/// Enumerate the host, apply [`decide`], and log the outcome.
///
/// This is the only impure entry point; everything it decides is decided by [`decide`].
pub(crate) fn select_bind_target() -> BindDecision {
    let candidates = host_candidates();
    let route_hint = default_route_source_ipv4();
    let decision = decide(candidates, route_hint);

    let passed_over = decision.passed_over();
    if let (true, Some(ip)) = (decision.internet_facing, decision.lan_ip) {
        // Deliberately its own line rather than a field on the line below: this is the
        // only outcome that widens the attack surface rather than narrowing the odds of
        // pairing, and SECURITY.md § In scope names "opens a listening port the user
        // did not ask for" explicitly. The daemon still starts — a host whose LAN is
        // numbered out of public space (the reporting hardware) must still be able to
        // sync — but it never does so quietly. See `BindDecision::internet_facing` for
        // why no address-shaped rule can tell that host apart from a VPS.
        tracing::warn!(
            bind = %ip,
            prefix_len = decision.prefix_len,
            "the sync endpoint is bound to a GLOBALLY-ROUTABLE address, so the listener \
             may be reachable from outside your local network. This is correct when your \
             LAN is numbered out of public address space, and wrong on a VPS or a cloud \
             host — in which case disable sync or firewall this port"
        );
    }
    match (decision.level, decision.lan_ip) {
        (_, None) => tracing::warn!(
            passed_over = %passed_over,
            "no usable LAN IPv4 interface found; the sync endpoint binds loopback and NO \
             PEER WILL BE ABLE TO REACH IT. Sync will appear to start and then time out."
        ),
        (Level::Warn, Some(ip)) => tracing::warn!(
            bind = %ip,
            prefix_len = decision.prefix_len,
            default_route_source = ?route_hint,
            passed_over = %passed_over,
            "sync endpoint bind address selected from several candidates; if peers cannot \
             reach this device, compare this address with `ip route get 1.1.1.1`"
        ),
        (Level::Info, Some(ip)) => tracing::info!(
            bind = %ip,
            prefix_len = decision.prefix_len,
            "sync endpoint bind address selected"
        ),
    }
    decision
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    //! Table-driven over synthetic interface lists.
    //!
    //! Nothing in the policy table reads the host's interfaces. That is the point: the
    //! code this replaces could not be tested at all without asserting something about
    //! the machine the test happened to run on, which is exactly why two defects sat in a
    //! five-line loop with full coverage elsewhere in the module. The last section is the
    //! deliberate exception — the impure entry points, where the host *is* the input, and
    //! each of those tests says what it can and cannot pin.

    use super::*;

    /// Names the chosen interface, for readable assertion messages.
    fn chosen(decision: &BindDecision) -> Option<&LanInterface> {
        decision
            .verdicts
            .iter()
            .find(|(_, verdict)| *verdict == Verdict::Chosen)
            .map(|(candidate, _)| candidate)
    }

    fn p2p(mut iface: LanInterface) -> LanInterface {
        iface.is_p2p = true;
        iface
    }

    fn down(mut iface: LanInterface) -> LanInterface {
        iface.is_up = false;
        iface
    }

    /// Give a candidate a netmask that does not have to agree with its `prefix_len`
    /// (#4105).
    ///
    /// `LanInterface::new` derives one from the prefix, which is the ordinary case and
    /// cannot express the defect: on POSIX the prefix is `count_ones` of whatever mask
    /// the kernel reported, so the fixture has to be able to say "this mask, that bit
    /// count" — `255.0.255.0` with `prefix_len == 16`, which is exactly what `if-addrs`
    /// hands us for that mask.
    fn with_netmask(mut iface: LanInterface, netmask: &str) -> LanInterface {
        iface.netmask = netmask
            .parse()
            .expect("test literal is a valid IPv4 netmask");
        iface
    }

    // -- The two measured configurations from #3853 --------------------------

    /// The maintainer's desktop, transcribed from `ip -4 addr` on that machine.
    ///
    /// Verbatim, in kernel enumeration (ifindex) order, including the two interfaces
    /// that are administratively up but `state DOWN` and the point-to-point tunnel. An
    /// earlier revision of this fixture invented `virbr0`/`virbr1` — names the
    /// deprioritisation list already caught — while the machine actually runs `lxdbr0`
    /// and `incusbr0`, which it did not. A fixture that is easier than the hardware
    /// tests the hardware's easier twin.
    fn desktop_interfaces() -> Vec<LanInterface> {
        vec![
            LanInterface::new("lo", "127.0.0.1", 8),
            LanInterface::new("wlp2s0", "192.160.160.80", 24),
            down(LanInterface::new("docker0", "192.168.32.1", 24)),
            LanInterface::new("lxdbr0", "10.0.6.1", 24),
            down(LanInterface::new("incusbr0", "10.0.7.1", 24)),
            p2p(LanInterface::new("zcctun0", "100.64.0.1", 16)),
        ]
    }

    /// The desktop as measured. Its LAN is `192.160.160.0/24`, which is **not** RFC
    /// 1918, so the old `is_private()` gate skipped it; a bridge won instead and that
    /// unreachable address went out over mDNS.
    #[test]
    fn desktop_shape_picks_the_real_lan_over_every_bridge_and_tunnel() {
        let decision = decide(
            desktop_interfaces(),
            Some("192.160.160.80".parse().unwrap()),
        );

        assert_eq!(
            decision.lan_ip,
            Some("192.160.160.80".parse::<Ipv4Addr>().unwrap()),
            "the real LAN address must win over every bridge and tunnel; passed over: {}",
            decision.passed_over()
        );
        assert_eq!(
            decision.bind,
            "192.160.160.80:0".parse::<SocketAddr>().unwrap()
        );
        assert_eq!(
            decision.prefix_len, 24,
            "the interface's own netmask, not a guess"
        );
        assert_eq!(chosen(&decision).map(|c| c.name.as_str()), Some("wlp2s0"));

        // Every candidate attributed to its own cause, so the log line names them.
        let reasons: Vec<(&str, Verdict)> = decision
            .verdicts
            .iter()
            .map(|(candidate, verdict)| (candidate.name.as_str(), *verdict))
            .collect();
        assert_eq!(
            reasons,
            vec![
                ("lo", Verdict::Loopback),
                ("wlp2s0", Verdict::Chosen),
                ("docker0", Verdict::NotUp),
                ("lxdbr0", Verdict::PassedOverVirtual),
                ("incusbr0", Verdict::NotUp),
                // Point-to-point *and* CGNAT: the log must say both, not just the first
                // of the two the classifier happens to test for.
                ("zcctun0", Verdict::PassedOverVirtualCgnat),
            ],
            "the audit trail must distinguish 'down' from 'deprioritised'; #3853's whole \
             difficulty was that nothing said what was passed over"
        );
    }

    /// The same desktop with **no default route**, and the bridge enumerating first.
    ///
    /// This is #3853 verbatim on the reporter's own machine, and the test the fixture
    /// above cannot be: with a route hint pointing at the winner, the hint decides and
    /// the deprioritisation list is never consulted. Take the hint away — an isolated
    /// LAN, the router down, Wi-Fi with no internet — or let `lxdbr0` take the lower
    /// ifindex (it does, whenever LXD starts before the Wi-Fi driver loads) and
    /// `10.0.6.1` wins on enumeration order alone unless `lxd` is in the list.
    #[test]
    fn desktop_shape_with_no_default_route_still_picks_the_real_lan() {
        let mut candidates = desktop_interfaces();
        // Bridge before NIC — the ordering the reporter's machine produces when LXD
        // wins the boot race.
        candidates.swap(1, 3);
        let decision = decide(candidates, None);

        assert_eq!(
            decision.lan_ip,
            Some("192.160.160.80".parse::<Ipv4Addr>().unwrap()),
            "with no route to break the tie the name-based deprioritisation is the only \
             thing standing between the user and #3853; passed over: {}",
            decision.passed_over()
        );
        assert_eq!(chosen(&decision).map(|c| c.name.as_str()), Some("wlp2s0"));
    }

    /// Every virtual-name prefix the desktop and the phone actually run, one assertion
    /// each, against an ordinary NIC that must beat all of them with no route hint.
    ///
    /// A table rather than one composite case so a single missing prefix names itself in
    /// the failure. `lxd`/`incusbr` are the two the first draft of this module missed on
    /// the reporting hardware; the rest are the same class of thing on other platforms.
    #[test]
    fn every_virtual_name_prefix_loses_to_a_physical_nic() {
        for name in [
            "docker0",
            "br-1a2b3c4d",
            "virbr0",
            "lxdbr0",
            "incusbr0",
            "vmbr0",
            "bridge0",   // macOS Thunderbolt/AWDL bridge
            "bridge100", // macOS Internet Sharing
            "vEthernet (WSL)",
            "veth7a1b",
            "vmnet1",
            "vboxnet0",
            "tun0",
            "tap0",
            "utun3",
            "wg0",
            "tailscale0",
            "zt5u4b",
            "p2p0",
            "ap0",
        ] {
            let candidates = vec![
                LanInterface::new(name, "10.0.6.1", 24),
                LanInterface::new("eth0", "192.168.5.5", 24),
            ];
            let decision = decide(candidates, None);
            assert_eq!(
                chosen(&decision).map(|c| c.name.as_str()),
                Some("eth0"),
                "{name} enumerates first and is private; a physical NIC must still win \
                 with no route hint. Passed over: {}",
                decision.passed_over()
            );
        }
    }

    /// The reporting phone. Wi-Fi is `192.160.160.102/24` (not RFC 1918); alongside it
    /// sit two `/32` VPN addresses and a `/16` CGNAT address, and **the default route
    /// goes out of the VPN**, which is why the route hint cannot be the primary key.
    #[test]
    fn phone_shape_picks_wifi_over_the_slash32_vpn_and_cgnat() {
        let candidates = vec![
            LanInterface::new("tun0", "10.70.121.252", 32),
            LanInterface::new("tun1", "10.193.146.251", 32),
            LanInterface::new("ap0", "100.64.0.1", 16),
            LanInterface::new("wlan0", "192.160.160.102", 24),
        ];
        // The VPN carries the default route — the hint points at an address we reject.
        let decision = decide(candidates, Some("10.70.121.252".parse().unwrap()));

        assert_eq!(
            decision.lan_ip,
            Some("192.160.160.102".parse::<Ipv4Addr>().unwrap()),
            "Wi-Fi must win even though the default route leaves via the VPN; passed \
             over: {}",
            decision.passed_over()
        );
        assert_eq!(chosen(&decision).map(|c| c.name.as_str()), Some("wlan0"));
    }

    /// Same phone, but the VPN advertises a routable prefix rather than a `/32`, so the
    /// `/32` rejection cannot be what saves us — the class ordering has to.
    #[test]
    fn a_vpn_carrying_the_default_route_never_beats_physical_wifi() {
        let candidates = vec![
            LanInterface::new("wg0", "10.8.0.5", 16),
            LanInterface::new("wlan0", "192.168.1.44", 24),
        ];
        let decision = decide(candidates, Some("10.8.0.5".parse().unwrap()));

        assert_eq!(
            chosen(&decision).map(|c| c.name.as_str()),
            Some("wlan0"),
            "a tunnel that owns the default route is still a tunnel; passed over: {}",
            decision.passed_over()
        );
    }

    // -- The textbook case the old code also got wrong ------------------------

    /// Defect B on its own: an ordinary `192.168.1.0/24` LAN, where both candidates are
    /// RFC 1918 so `is_private()` cannot discriminate and enumeration order decided.
    #[test]
    fn plain_lan_beats_docker0_even_though_both_are_rfc1918() {
        let candidates = vec![
            LanInterface::new("docker0", "172.17.0.1", 16),
            LanInterface::new("wlan0", "192.168.1.50", 24),
        ];
        let decision = decide(candidates, Some("192.168.1.50".parse().unwrap()));

        assert_eq!(
            chosen(&decision).map(|c| c.name.as_str()),
            Some("wlan0"),
            "docker0 enumerates first and is private; it must still lose; passed over: {}",
            decision.passed_over()
        );
    }

    /// And it must still lose when there is no default route at all, so the name-based
    /// deprioritisation is load-bearing on its own.
    #[test]
    fn docker0_loses_even_with_no_default_route_hint() {
        let candidates = vec![
            LanInterface::new("docker0", "172.17.0.1", 16),
            LanInterface::new("eth0", "192.168.1.50", 24),
        ];
        let decision = decide(candidates, None);

        assert_eq!(
            chosen(&decision).map(|c| c.name.as_str()),
            Some("eth0"),
            "with no route hint the virtual-name tiebreak must still decide; passed \
             over: {}",
            decision.passed_over()
        );
    }

    /// A globally-routable address must not be excluded merely for being routable —
    /// that is defect A. `192.160.160.0/24` is real public space and it is this user's
    /// LAN.
    #[test]
    fn a_globally_routable_address_is_not_excluded() {
        let candidates = vec![LanInterface::new("eth0", "192.160.160.80", 24)];
        let decision = decide(candidates, None);

        assert_eq!(
            decision.lan_ip,
            Some("192.160.160.80".parse::<Ipv4Addr>().unwrap()),
            "a non-RFC1918 LAN address is a LAN address"
        );
    }

    /// …but it is never selected *quietly*, and every other clause of the level rule is
    /// pinned here beside it (#3853, SECURITY.md § In scope).
    ///
    /// **Every fixture carries loopback**, because every host does. An earlier revision
    /// omitted it, and that single omission is what let the level rule count
    /// `verdicts.len()` — which includes loopback — and still look pinned: the `Info` arm
    /// was reachable *only* from a list no machine can produce, so in production the
    /// daemon warned on every start and the internet-facing warning below meant nothing.
    /// A fixture that is easier than the hardware tests the hardware's easier twin.
    ///
    /// One assertion per clause, deliberately, so a dead clause names itself. Delete
    /// `internet_facing` or `rankable.len() > 1` and exactly one line here goes red;
    /// delete `winning_class > BEST_CLASS` and two do — the `bridge_only` line below *and*
    /// `a_virtual_interface_is_still_chosen_when_it_is_the_only_candidate`, which
    /// asserts the same WARN from the other side. Mutating `level` to always-`Warn`
    /// kills the first assertion here, and widening the count back to `verdicts.len()`
    /// kills it too, since loopback is now in the list.
    #[test]
    fn only_a_single_ordinary_private_nic_is_decided_quietly() {
        // INFO: one ordinary private NIC, nothing in contention, nothing internet-facing.
        // Loopback is present and rejected, as it is on every host; a NO-CARRIER bridge
        // is too, because that is what an idle Docker install leaves behind. Neither was
        // ever a candidate for the bind, so neither is worth waking the user for.
        let quiet = decide(
            vec![
                LanInterface::new("lo", "127.0.0.1", 8),
                LanInterface::new("eth0", "192.168.1.10", 24),
                down(LanInterface::new("docker0", "172.17.0.1", 16)),
            ],
            None,
        );
        assert_eq!(
            quiet.level,
            Level::Info,
            "an unambiguous private LAN bind is the one case worth no warning — and it \
             has to survive the interfaces every real host carries alongside it, or the \
             quiet case exists only in this file; passed over: {}",
            quiet.passed_over()
        );
        assert!(
            quiet.verdicts.len() > 1,
            "precondition: the fixture must be the production shape, i.e. more entries \
             than the one that won"
        );
        assert!(!quiet.internet_facing);

        // WARN, clause 1: a second candidate was genuinely in contention.
        let with_a_loser = decide(
            vec![
                LanInterface::new("lo", "127.0.0.1", 8),
                LanInterface::new("eth0", "192.168.1.10", 24),
                LanInterface::new("docker0", "172.17.0.1", 16),
            ],
            None,
        );
        assert_eq!(
            with_a_loser.level,
            Level::Warn,
            "if something rankable was passed over, the log must say so — that list is \
             the whole diagnostic #3853 lacked"
        );

        // WARN, clause 2: the winner is itself virtual, i.e. the #3853 symptom.
        let bridge_only = decide(
            vec![
                LanInterface::new("lo", "127.0.0.1", 8),
                LanInterface::new("docker0", "172.17.0.1", 16),
            ],
            None,
        );
        assert_eq!(bridge_only.level, Level::Warn);

        // WARN, clause 3: the winner is globally routable. Unanimous — one rankable
        // candidate, best class, nothing else in contention — so every other clause is
        // false and this is the only thing that can raise the level.
        let public = decide(
            vec![
                LanInterface::new("lo", "127.0.0.1", 8),
                LanInterface::new("eth0", "192.160.160.80", 24),
            ],
            None,
        );
        assert_eq!(
            public
                .verdicts
                .iter()
                .map(|(_, verdict)| *verdict)
                .collect::<Vec<_>>(),
            vec![Verdict::Loopback, Verdict::Chosen],
            "precondition: nothing in contention but the winner"
        );
        assert!(
            public.internet_facing,
            "a bind reachable from off-LAN must be flagged as such; the locality gate \
             now lets this host start a listener where it previously refused to"
        );
        assert_eq!(
            public.level,
            Level::Warn,
            "an internet-facing listener is never the quiet case, however unambiguous \
             the selection was"
        );

        // …and CGNAT is not "internet-facing": a carrier NAT is not reachable inbound.
        let cgnat = decide(vec![LanInterface::new("rmnet0", "100.64.0.1", 16)], None);
        assert!(
            !cgnat.internet_facing,
            "100.64/10 is not reachable from the internet; flagging it would train the \
             user to ignore the warning"
        );
    }

    // -- Hard exclusions ------------------------------------------------------

    #[test]
    fn loopback_link_local_down_and_host_routes_are_all_rejected() {
        let candidates = vec![
            LanInterface::new("lo", "127.0.0.1", 8),
            LanInterface::new("eth1", "169.254.10.9", 16),
            down(LanInterface::new("eth2", "192.168.9.9", 24)),
            LanInterface::new("tun9", "10.1.2.3", 32),
        ];
        let decision = decide(candidates, None);

        assert_eq!(
            decision.lan_ip, None,
            "nothing in that list can carry LAN sync; got {:?}",
            decision.lan_ip
        );
        let reasons: Vec<Verdict> = decision.verdicts.iter().map(|(_, v)| *v).collect();
        assert_eq!(
            reasons,
            vec![
                Verdict::Loopback,
                Verdict::LinkLocal,
                Verdict::NotUp,
                Verdict::HostRoute,
            ],
            "each exclusion must be attributed to its own cause, not lumped together"
        );
    }

    /// The loud failure. #3853's core complaint is that every layer reported success, so
    /// the fallback must be a WARN carrying the full list of what was refused.
    #[test]
    fn no_usable_interface_falls_back_to_loopback_and_warns() {
        let candidates = vec![
            LanInterface::new("lo", "127.0.0.1", 8),
            LanInterface::new("tun0", "10.70.121.252", 32),
        ];
        let decision = decide(candidates, None);

        assert_eq!(decision.lan_ip, None);
        assert_eq!(
            decision.bind,
            SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
            "the fallback binds loopback"
        );
        assert_eq!(
            decision.level,
            Level::Warn,
            "a loopback fallback means sync is dead; it must never be logged quietly"
        );
        let passed_over = decision.passed_over();
        assert!(
            passed_over.contains("lo=127.0.0.1/8") && passed_over.contains("tun0=10.70.121.252/32"),
            "the warning must name every rejected candidate so the cause is visible \
             without a packet capture, got: {passed_over}"
        );
    }

    /// An empty host (`get_if_addrs` failed) is the same fallback.
    #[test]
    fn an_empty_interface_list_falls_back_to_loopback() {
        let decision = decide(Vec::new(), None);
        assert_eq!(decision.lan_ip, None);
        assert_eq!(decision.level, Level::Warn);
        assert_eq!(decision.passed_over(), "none");
    }

    // -- Ranking details ------------------------------------------------------

    /// A point-to-point interface is deprioritised by its flag alone, so a tunnel named
    /// something unrecognised is still a tunnel.
    #[test]
    fn point_to_point_is_deprioritised_by_flag_not_only_by_name() {
        let candidates = vec![
            p2p(LanInterface::new("nordlynx", "10.5.0.2", 16)),
            LanInterface::new("eth0", "192.168.4.7", 24),
        ];
        let decision = decide(candidates, Some("10.5.0.2".parse().unwrap()));
        assert_eq!(chosen(&decision).map(|c| c.name.as_str()), Some("eth0"));
    }

    /// Deprioritisation is a tiebreak, never an exclusion: a host whose *only* interface
    /// is a bridge must still bind the bridge rather than loopback.
    #[test]
    fn a_virtual_interface_is_still_chosen_when_it_is_the_only_candidate() {
        let candidates = vec![LanInterface::new("docker0", "172.17.0.1", 16)];
        let decision = decide(candidates, None);

        assert_eq!(
            decision.lan_ip,
            Some("172.17.0.1".parse::<Ipv4Addr>().unwrap()),
            "a deprioritised candidate is still a candidate"
        );
        assert_eq!(
            decision.level,
            Level::Warn,
            "…but binding a bridge as the LAN is exactly the #3853 symptom, so say so"
        );
    }

    /// CGNAT is deprioritised below an ordinary LAN and above a tunnel, and is still
    /// selectable when it is all a CGNAT'd mobile device has.
    #[test]
    fn cgnat_ranks_below_a_lan_but_is_selectable_alone() {
        // Two physical radios, so the *address* is the only thing separating them: a
        // carrier-named interface would now be deprioritised by name too (#3869) and this
        // test would no longer be about CGNAT.
        let mixed = vec![
            LanInterface::new("wlan1", "100.64.0.1", 16),
            LanInterface::new("wlan0", "192.168.0.30", 24),
        ];
        assert_eq!(
            chosen(&decide(mixed, None)).map(|c| c.name.as_str()),
            Some("wlan0")
        );

        let alone = vec![LanInterface::new("wlan1", "100.64.0.1", 16)];
        assert_eq!(
            decide(alone, None).lan_ip,
            Some("100.64.0.1".parse::<Ipv4Addr>().unwrap())
        );
    }

    /// Each losing class states *its own* reason, and the worst class states both halves.
    ///
    /// One list, one winner, one loser per class, so an arm that collapses into another
    /// names itself. The virtual + CGNAT pair is why this exists: it was reported as
    /// `PassedOverVirtual`
    /// alone, so the log said "virtual or point-to-point interface" about the desktop's
    /// `zcctun0 100.64.0.1` and never mentioned that the address is a carrier one too —
    /// leaving the reader to work out which of the two ordering rules had applied.
    /// Selection was never affected; [`class`] already ranks the pair last.
    #[test]
    fn every_passed_over_class_states_its_own_reason() {
        let decision = decide(
            vec![
                LanInterface::new("eth0", "192.168.1.10", 24), // best class, wins on order
                LanInterface::new("eth1", "192.168.2.10", 24), // best class, lost on order
                LanInterface::new("wlan1", "100.64.0.1", 16),  // physical + CGNAT
                LanInterface::new("docker0", "172.17.0.1", 16), // virtual only
                LanInterface::new("wwan0", "10.44.0.9", 24),   // cellular only
                p2p(LanInterface::new("zcctun0", "100.64.1.1", 16)), // virtual + CGNAT
                LanInterface::new("rmnet0", "100.64.2.1", 16), // cellular + CGNAT
            ],
            None,
        );

        let reasons: Vec<(&str, Verdict)> = decision
            .verdicts
            .iter()
            .map(|(candidate, verdict)| (candidate.name.as_str(), *verdict))
            .collect();
        assert_eq!(
            reasons,
            vec![
                ("eth0", Verdict::Chosen),
                ("eth1", Verdict::PassedOverEnumerationOrder),
                ("wlan1", Verdict::PassedOverCgnat),
                ("docker0", Verdict::PassedOverVirtual),
                ("wwan0", Verdict::PassedOverCellular),
                ("zcctun0", Verdict::PassedOverVirtualCgnat),
                ("rmnet0", Verdict::PassedOverCellularCgnat),
            ],
            "a candidate that is both off-LAN and CGNAT must not be filed under either \
             half alone, and a carrier link must not be filed as a tunnel; passed over: {}",
            decision.passed_over()
        );

        // …and the distinction has to survive into the text the user actually reads.
        let passed_over = decision.passed_over();
        assert!(
            passed_over.contains(
                "zcctun0=100.64.1.1/16 (virtual or point-to-point interface, on CGNAT \
                 100.64/10)"
            ),
            "the log line is the only place this reason is ever seen, got: {passed_over}"
        );
        assert!(
            passed_over.contains(
                "rmnet0=100.64.2.1/16 (cellular WAN interface, on CGNAT 100.64/10 — no \
                 LAN peer is on it)"
            ),
            "a carrier link's line must say carrier, not 'virtual or point-to-point' — \
             that is the reader's cue that no routing change can help, got: {passed_over}"
        );
    }

    /// A same-class loser must name the rule that *actually* decided (#3869).
    ///
    /// One verdict used to cover both cases and always read "does not carry the default
    /// route" — including when `route_hint` was `None`, where nothing carried it and
    /// enumeration order decided. That is an audit line stating a cause that did not
    /// apply, in exactly the isolated-LAN case (`desktop_shape_with_no_default_route…`)
    /// the module argues is the interesting one, and it sends the reader to a routing
    /// table that has no answer in it.
    ///
    /// Three cases because a `route_hint.is_some()` test would pass the first two and
    /// still be wrong: a probe can answer with an address that is not in contention.
    #[test]
    fn a_same_class_loser_names_the_rule_that_actually_decided() {
        /// The verdict recorded against `name`, for readable assertions.
        fn verdict_for(decision: &BindDecision, name: &str) -> Option<Verdict> {
            decision
                .verdicts
                .iter()
                .find(|(candidate, _)| candidate.name == name)
                .map(|(_, verdict)| *verdict)
        }

        let candidates = vec![
            LanInterface::new("eth0", "192.168.1.10", 24),
            LanInterface::new("eth1", "192.168.2.10", 24),
        ];

        // 1. The hint names the winner, so the route tiebreak is what fired.
        let by_route = decide(candidates.clone(), Some("192.168.1.10".parse().unwrap()));
        assert_eq!(chosen(&by_route).map(|c| c.name.as_str()), Some("eth0"));
        assert_eq!(
            verdict_for(&by_route, "eth1"),
            Some(Verdict::PassedOverDefaultRoute),
            "the winner carried the default route and this one did not — that is a cause \
             the reader can act on"
        );
        assert!(
            by_route
                .passed_over()
                .contains("eth1=192.168.2.10/24 (does not carry the default route)"),
            "got: {}",
            by_route.passed_over()
        );

        // 2. No hint at all: nothing carried the default route, so nothing lost to it.
        let by_order = decide(candidates.clone(), None);
        assert_eq!(chosen(&by_order).map(|c| c.name.as_str()), Some("eth0"));
        assert_eq!(
            verdict_for(&by_order, "eth1"),
            Some(Verdict::PassedOverEnumerationOrder),
            "with no default route the choice was arbitrary; saying it lost the route \
             tiebreak is a statement about a rule that never ran"
        );
        let text = by_order.passed_over();
        assert!(
            text.contains("chosen on enumeration order"),
            "the audit line must say the choice was arbitrary, got: {text}"
        );
        assert!(
            !text.contains("does not carry the default route"),
            "…and must not blame a route nothing carried, got: {text}"
        );

        // 3. A hint that names no candidate — the probe answered, but with an address not
        //    in contention. Still enumeration order: `route_hint.is_some()` is not the
        //    question, `route_hint == the winner` is.
        let stale_hint = decide(candidates, Some("10.9.9.9".parse().unwrap()));
        assert_eq!(
            verdict_for(&stale_hint, "eth1"),
            Some(Verdict::PassedOverEnumerationOrder),
            "a route hint pointing at neither candidate separated neither of them"
        );

        // 4. The same address on two interfaces, with the hint naming it. The hint *does*
        //    name the winner, so the `route_named_the_winner` half is satisfied — and the
        //    loser is on the default route just as much as the winner is, so the route is
        //    still not what separated them. Without the `candidate.ip != winner_ip` guard
        //    this is the one shape that files a loser under a rule it did not lose to, and
        //    every other case in this test stays green.
        let shared = "192.168.1.10";
        let duplicated = decide(
            vec![
                LanInterface::new("eth0", shared, 24),
                LanInterface::new("eth0:1", shared, 24),
            ],
            Some(shared.parse().unwrap()),
        );
        assert_eq!(chosen(&duplicated).map(|c| c.name.as_str()), Some("eth0"));
        assert_eq!(
            verdict_for(&duplicated, "eth0:1"),
            Some(Verdict::PassedOverEnumerationOrder),
            "an alias holding the winner's own address carries the winner's own route \
             penalty; telling the reader it 'does not carry the default route' would send \
             them to a routing table that agrees with it. Passed over: {}",
            duplicated.passed_over()
        );

        // 5. …and the *text* of that verdict must be true in every one of those shapes.
        //    It used to read "no default route separated them", which reads as "there is
        //    no default route" — false in cases 3 and 4, where there is one and it simply
        //    did not single the winner out. Case 3 is not hypothetical: it is the measured
        //    Pixel 8, where the probe answers with an `rmnet*` /32 that `rejection` has
        //    already filed as `HostRoute`, so the line fires while a default route exists.
        let pixel_8 = decide(
            vec![
                LanInterface::new("rmnet0", "10.73.39.114", 32), // rejected: HostRoute
                LanInterface::new("wlan0", "192.168.1.44", 24),
                LanInterface::new("wlan1", "192.168.1.45", 24),
            ],
            // The default route leaves via the carrier link — an address that never
            // reached the ranking at all.
            Some("10.73.39.114".parse().unwrap()),
        );
        assert_eq!(chosen(&pixel_8).map(|c| c.name.as_str()), Some("wlan0"));
        assert_eq!(
            verdict_for(&pixel_8, "wlan1"),
            Some(Verdict::PassedOverEnumerationOrder),
            "the hint names no rankable candidate, so order decided; passed over: {}",
            pixel_8.passed_over()
        );
        let pixel_text = pixel_8.passed_over();
        assert!(
            !pixel_text.contains("no default route"),
            "a default route exists on this device and the audit line must not deny it — \
             it merely did not separate the two Wi-Fi links; got: {pixel_text}"
        );
        assert!(
            pixel_text.contains("the default route did not separate them"),
            "…and it must say what actually happened; got: {pixel_text}"
        );
    }

    // -- The hotspot case (#3869) ---------------------------------------------

    /// A cellular uplink does not outrank the LAN, even when it carries the default
    /// route — the genuinely-passing case the surviving half of #3869 fixes.
    ///
    /// #3869 originally set out to have a phone acting as a hotspot bind `ap0` rather
    /// than the cellular link it is sharing, by promoting `ap0` to the physical rank. That
    /// promotion was reverted (see the note on `VIRTUAL_NAME_PREFIXES`): it regressed
    /// the isolated-LAN case, so `ap0` stays `LinkKind::Virtual` — which a carrier link
    /// now outranks — and this test is **not** about that scenario. The original
    /// hotspot-vs-carrier request stays open, tracked at #4108.
    ///
    /// What `CELLULAR_NAME_PREFIXES` fixes on its own, independent of `ap0`'s rank, is
    /// this: a laptop LTE/WWAN modem — unlike Android's `rmnet*`, which hands out a
    /// `/32` host route already rejected before ranking runs (see the measurement on
    /// `CELLULAR_NAME_PREFIXES`) — is typically handed a real subnet by the carrier or
    /// ModemManager, and once up commonly carries the default route (a lower metric than
    /// idle Wi-Fi). Without this list the modem shares the physical rank with the LAN NIC
    /// and the route hint hands it the win; with the list, the modem is
    /// `LinkKind::Cellular` and the LAN wins regardless of the route.
    #[test]
    fn a_cellular_uplink_does_not_outrank_the_lan_even_via_the_route_hint() {
        let candidates = vec![
            // A real /24, not Android's /32 — see the doc comment above for why that
            // distinction is the whole test.
            LanInterface::new("wwan0", "10.150.2.5", 24),
            LanInterface::new("wlp2s0", "192.168.1.44", 24),
        ];
        // The modem carries the default route — plausible once it is up and Wi-Fi is
        // merely idle, not down.
        let decision = decide(candidates, Some("10.150.2.5".parse().unwrap()));

        assert_eq!(
            chosen(&decision).map(|c| c.name.as_str()),
            Some("wlp2s0"),
            "wwan0 holds a real /24 and carries the route hint, but a carrier link ranks \
             below a physical NIC regardless of the route; passed over: {}",
            decision.passed_over()
        );
    }

    /// A hotspot does not outrank the LAN the device actually joined — including with no
    /// default route to break the tie, which was the gap left when #3869 first attempted
    /// this by promoting `ap0` to the physical rank (see the note on
    /// `VIRTUAL_NAME_PREFIXES`; that promotion was reverted).
    ///
    /// This is the stronger property class gives for free once `ap0` stays
    /// deprioritised: `ap0` and a joined Wi-Fi network are never the same class, so the
    /// route hint — or its absence — cannot matter, and the isolated-LAN gap the
    /// promotion opened is closed. What remains genuinely open is the original #3869
    /// item 1 request itself (a tethering phone preferring its own hotspot over the
    /// carrier it is sharing); that needs a soft-AP ranking key between the route
    /// tiebreak and the index, and a verdict naming it, which is a ranking change and
    /// not made here. Tracked at #4108.
    #[test]
    fn a_hotspot_does_not_outrank_the_lan_the_device_actually_joined() {
        let candidates = vec![
            LanInterface::new("ap0", "192.168.43.1", 24),
            LanInterface::new("wlan0", "192.168.1.44", 24),
        ];
        // No route hint at all — the isolated-LAN case the module docs call the
        // interesting one, and exactly the case where the reverted `ap0` promotion fell
        // through to enumeration order and could hand the win to the hotspot.
        let decision = decide(candidates, None);

        assert_eq!(
            chosen(&decision).map(|c| c.name.as_str()),
            Some("wlan0"),
            "ap0 is LinkKind::Virtual and wlan0 is LinkKind::Physical, so class alone \
             decides even with no default route to break a tie; passed over: {}",
            decision.passed_over()
        );
    }

    /// Cellular is deprioritised, never excluded — a phone with no Wi-Fi has nothing else.
    #[test]
    fn a_cellular_interface_is_still_chosen_when_it_is_the_only_candidate() {
        let decision = decide(
            vec![
                LanInterface::new("lo", "127.0.0.1", 8),
                LanInterface::new("rmnet_data0", "10.144.5.22", 28),
            ],
            None,
        );

        assert_eq!(
            decision.lan_ip,
            Some("10.144.5.22".parse::<Ipv4Addr>().unwrap()),
            "a deprioritised candidate is still a candidate; binding loopback here would \
             kill sync on a phone that is merely off Wi-Fi"
        );
        assert_eq!(
            decision.level,
            Level::Warn,
            "…but a carrier link is not a LAN, so this is never the quiet case"
        );
    }

    /// A modem holding a real subnet beats a virtual bridge (#4109 review).
    ///
    /// The case the first cut of `CELLULAR_NAME_PREFIXES` regressed and nothing covered.
    /// Folding cellular into the same rank as virtual made a modem tie every up bridge on
    /// the host — `docker0`, `lxdbr0`, `virbr0`, a VPN — with nothing but ifindex between
    /// them, where before the list existed the modem won outright. On a private or
    /// corporate APN with no Wi-Fi and no Ethernet, that is a bind on a link no peer can
    /// possibly be on, chosen over the one link that might have a peer: #3853's own shape.
    ///
    /// The modem enumerates **second** in every row deliberately. It is the ranking that
    /// has to decide this, not enumeration order — with the bridge second the test passes
    /// under the collapsed rank too and pins nothing.
    #[test]
    fn a_modem_with_a_real_subnet_outranks_a_virtual_bridge() {
        for bridge in ["docker0", "lxdbr0", "virbr0", "br-1a2b3c4d", "wg0", "ap0"] {
            let decision = decide(
                vec![
                    LanInterface::new(bridge, "172.17.0.1", 16),
                    LanInterface::new("wwan0", "10.150.2.5", 24),
                ],
                None,
            );
            assert_eq!(
                chosen(&decision).map(|c| c.name.as_str()),
                Some("wwan0"),
                "{bridge} enumerates first, but a carrier link can have a peer on it (a \
                 corporate APN) and a bridge's neighbours are containers; passed over: {}",
                decision.passed_over()
            );
            assert_eq!(
                decision
                    .verdicts
                    .iter()
                    .find(|(candidate, _)| candidate.name == bridge)
                    .map(|(_, verdict)| *verdict),
                Some(Verdict::PassedOverVirtual),
                "…and the audit line must file the bridge under its own reason, not under \
                 the order rule that a collapsed rank would have used"
            );
        }
    }

    /// The whole ordering in one list, which is the only place it is asserted end to end.
    ///
    /// A physical NIC beats the modem, the modem beats the bridge, and each loser names
    /// the rule it actually lost to. Any two of the three ranks collapsing into one
    /// reddens this.
    #[test]
    fn a_nic_beats_the_modem_and_the_modem_beats_the_bridge() {
        let decision = decide(
            vec![
                LanInterface::new("docker0", "172.17.0.1", 16),
                LanInterface::new("wwan0", "10.150.2.5", 24),
                LanInterface::new("eth0", "192.168.1.10", 24),
            ],
            // The modem carries the default route, as it does once it is the live uplink.
            Some("10.150.2.5".parse().unwrap()),
        );

        let ranked: Vec<(&str, Verdict)> = decision
            .verdicts
            .iter()
            .map(|(candidate, verdict)| (candidate.name.as_str(), *verdict))
            .collect();
        assert_eq!(
            ranked,
            vec![
                ("docker0", Verdict::PassedOverVirtual),
                ("wwan0", Verdict::PassedOverCellular),
                ("eth0", Verdict::Chosen),
            ],
            "physical < cellular < virtual, and the route hint never promotes across \
             ranks; passed over: {}",
            decision.passed_over()
        );
    }

    /// The CGNAT half of the same ordering — the ordinary shape of a carrier link.
    ///
    /// A CGNAT modem still beats a bridge (the link kind dominates the address), still
    /// loses to a physical NIC, and — the sub-case a single `cgnat` boolean would get
    /// wrong — an *ordinary* modem beats a *CGNAT* modem.
    #[test]
    fn a_cgnat_modem_ranks_between_a_nic_and_a_bridge() {
        let vs_bridge = decide(
            vec![
                LanInterface::new("docker0", "172.17.0.1", 16),
                LanInterface::new("rmnet0", "100.64.0.5", 16),
            ],
            None,
        );
        assert_eq!(
            chosen(&vs_bridge).map(|c| c.name.as_str()),
            Some("rmnet0"),
            "CGNAT is a fact about the address; who can be on the other end of the link \
             is the stronger one; passed over: {}",
            vs_bridge.passed_over()
        );

        let vs_nic = decide(
            vec![
                LanInterface::new("rmnet0", "100.64.0.5", 16),
                LanInterface::new("wlan0", "192.168.1.44", 24),
            ],
            Some("100.64.0.5".parse().unwrap()),
        );
        assert_eq!(
            chosen(&vs_nic).map(|c| c.name.as_str()),
            Some("wlan0"),
            "a CGNAT carrier link must not win on the route hint either; passed over: {}",
            vs_nic.passed_over()
        );

        let two_modems = decide(
            vec![
                LanInterface::new("rmnet0", "100.64.0.5", 16),
                LanInterface::new("rmnet1", "10.150.2.5", 24),
            ],
            None,
        );
        assert_eq!(
            chosen(&two_modems).map(|c| c.name.as_str()),
            Some("rmnet1"),
            "within the cellular rank the ordinary address beats the CGNAT one, even \
             though the CGNAT link enumerates first; passed over: {}",
            two_modems.passed_over()
        );
    }

    /// A modem is still not a LAN: with a bridge in the list it is never the quiet case,
    /// and the bridge still appears in the audit line the user reads.
    #[test]
    fn choosing_a_modem_over_a_bridge_is_never_quiet() {
        let decision = decide(
            vec![
                LanInterface::new("lo", "127.0.0.1", 8),
                LanInterface::new("docker0", "172.17.0.1", 16),
                LanInterface::new("wwan0", "10.150.2.5", 24),
            ],
            None,
        );
        assert_eq!(
            decision.level,
            Level::Warn,
            "two rankable candidates and a winner outside the best class — the user has \
             to be told which one was taken"
        );
        assert!(
            decision
                .passed_over()
                .contains("docker0=172.17.0.1/16 (virtual or point-to-point interface)"),
            "got: {}",
            decision.passed_over()
        );
    }

    /// Every cellular prefix, one assertion each, against a NIC that must beat all of
    /// them with no route hint — the same table shape as the virtual-name test above.
    ///
    /// `wwp0s20f0u6i12` is the systemd/udev predictable spelling of the laptop WWAN card
    /// the list is justified by, and is what the machine actually calls it: the kernel's
    /// `wwan0` survives only where predictable naming is off. Covering only `wwan` left
    /// the motivating case unmatched.
    #[test]
    fn every_cellular_name_prefix_loses_to_a_physical_nic() {
        for name in [
            "rmnet0",
            "rmnet_data0",
            "ccmni0",
            "pdp_ip0",
            "wwan0",
            "wwp0s20f0u6i12",
            "qmimux0",
        ] {
            let candidates = vec![
                LanInterface::new(name, "10.144.5.22", 24),
                LanInterface::new("wlan0", "192.168.5.5", 24),
            ];
            let decision = decide(candidates, None);
            assert_eq!(
                chosen(&decision).map(|c| c.name.as_str()),
                Some("wlan0"),
                "{name} enumerates first and is private, but no LAN peer can be on a \
                 carrier link. Passed over: {}",
                decision.passed_over()
            );
        }
    }

    /// `br-<hash>` is Docker; a bare `br0` is a bridge the user built and may be the LAN.
    #[test]
    fn bare_br0_is_not_treated_as_a_docker_network() {
        let candidates = vec![
            LanInterface::new("br-1a2b3c4d", "172.18.0.1", 16),
            LanInterface::new("br0", "192.168.7.2", 24),
        ];
        let decision = decide(candidates, None);
        assert_eq!(
            chosen(&decision).map(|c| c.name.as_str()),
            Some("br0"),
            "only the hyphenated Docker form is deprioritised; passed over: {}",
            decision.passed_over()
        );
    }

    /// Within one class the default route decides — this is where the hint earns its
    /// keep, and it is the only thing separating two otherwise identical NICs.
    #[test]
    fn the_default_route_breaks_ties_between_two_physical_nics() {
        let candidates = vec![
            LanInterface::new("eth0", "192.168.1.10", 24),
            LanInterface::new("eth1", "192.168.2.10", 24),
        ];
        assert_eq!(
            chosen(&decide(
                candidates.clone(),
                Some("192.168.2.10".parse().unwrap())
            ))
            .map(|c| c.name.as_str()),
            Some("eth1"),
            "the route hint must pick the second NIC"
        );
        assert_eq!(
            chosen(&decide(candidates, None)).map(|c| c.name.as_str()),
            Some("eth0"),
            "with no hint the result must stay deterministic (enumeration order)"
        );
    }

    /// The prefix is the interface's own netmask, verbatim — and a prefix `lan_only`
    /// would refuse is rejected outright rather than widened into one it would accept.
    ///
    /// The earlier version of this test fed `/8` and asserted `>= MIN_IPV4_PREFIX_LEN`,
    /// which restates its own input: `8 >= 8` holds whatever the code does, and the
    /// `.max(MIN_IPV4_PREFIX_LEN)` clamp it claimed to cover was unreachable anyway,
    /// because `rejection` refuses everything below the minimum first. Deleting the
    /// clamp changed nothing; deleting it *and* this assertion is the honest state.
    #[test]
    fn the_prefix_is_the_interfaces_own_netmask() {
        for prefix_len in [8u8, 16, 24, 31] {
            let candidates = vec![LanInterface::new("eth0", "10.1.2.3", prefix_len)];
            assert_eq!(
                decide(candidates, None).prefix_len,
                prefix_len,
                "/{prefix_len} is what the interface reported; the bind must confine \
                 egress to the subnet the host is actually on, not a guessed one"
            );
        }

        // Broader than /8 cannot confine egress; `lan_only` would reject it, so it is
        // rejected *here*, where the reason can be logged next to the alternatives —
        // not clamped into a prefix the interface never described.
        let too_broad = decide(vec![LanInterface::new("eth0", "10.1.2.3", 4)], None);
        assert_eq!(too_broad.lan_ip, None);
        assert_eq!(
            too_broad.verdicts.first().map(|(_, verdict)| *verdict),
            Some(Verdict::PrefixTooBroad),
            "and it must be attributed to its breadth, not lumped in with the rest"
        );
    }

    // -- Non-contiguous netmasks (#4105) --------------------------------------

    /// The predicate itself, over masks whose shape is not in doubt.
    ///
    /// The two ends are included deliberately: `0.0.0.0` (the value `if-addrs`
    /// substitutes for an unreadable netmask) and `255.255.255.255` are both contiguous,
    /// so the gate says nothing about them and they keep reaching the prefix rules that
    /// already have an answer for them (`PrefixTooBroad` and `HostRoute`).
    #[test]
    fn contiguity_accepts_well_formed_masks_and_refuses_gaps() {
        for mask in [
            "0.0.0.0",         // /0 — also the "netmask unreadable" substitute
            "128.0.0.0",       // /1
            "254.0.0.0",       // /7 — a mask whose last set bit is mid-octet
            "255.0.0.0",       // /8
            "255.255.240.0",   // /20
            "255.255.255.0",   // /24
            "255.255.255.255", // /32
        ] {
            let mask: Ipv4Addr = mask.parse().expect("test literal parses");
            assert!(
                is_contiguous_netmask(mask),
                "{mask} is a well-formed netmask and must be accepted"
            );
        }

        for (mask, count_ones) in [
            ("255.0.255.0", 16),   // the issue's example: reads as a plausible /16
            ("255.255.0.255", 24), // and this one as a plausible /24
            ("0.255.255.255", 24), // set bits at the wrong end entirely
            ("255.255.255.1", 25), // one stray host bit
            ("253.0.0.0", 7),      // a gap inside the first octet
            ("255.255.254.1", 24), // gap plus a stray bit
        ] {
            let parsed: Ipv4Addr = mask.parse().expect("test literal parses");
            assert!(
                !is_contiguous_netmask(parsed),
                "{mask} has a gap in it and describes no subnet, yet `if-addrs` would \
                 report it as a confident /{count_ones}"
            );
            assert_eq!(
                u32::from(parsed).count_ones(),
                count_ones,
                "the fixture's own claim about what `if-addrs` derives from {mask} must \
                 be true, or this test is arguing with itself"
            );
        }
    }

    /// A non-contiguous mask is rejected outright, not bound as its bit count.
    ///
    /// `if-addrs` derives the prefix with `count_ones` and no contiguity check
    /// (`if-addrs-0.15.0/src/lib.rs:283`), so `255.0.255.0` arrives as `prefix_len == 16`
    /// — a value that passes both prefix gates and would become
    /// `BindOpts::set_prefix_len(16)`: the egress-confinement boundary, describing a
    /// block the interface is not on. The whole point of the rejection is that the
    /// fictitious prefix never reaches the bind.
    #[test]
    fn a_non_contiguous_netmask_is_rejected_rather_than_bound_as_its_bit_count() {
        let decision = decide(
            vec![with_netmask(
                LanInterface::new("eth0", "10.1.2.3", 16),
                "255.0.255.0",
            )],
            None,
        );

        assert_eq!(
            decision.lan_ip, None,
            "the only candidate's mask describes no subnet, so there is nothing to bind"
        );
        assert_eq!(
            decision.verdicts.first().map(|(_, verdict)| *verdict),
            Some(Verdict::NetmaskNotContiguous),
            "and it must be attributed to the mask, not to breadth or to a host route"
        );
        assert_eq!(
            decision.bind,
            SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
            "the loopback fallback, which is loud, rather than a /16 the interface never \
             described"
        );
        assert_eq!(decision.level, Level::Warn);

        // The mask, not the fictitious prefix: "not contiguous" with no value is not
        // something an operator can match against their own `ip -4 addr` output.
        let passed_over = decision.passed_over();
        assert!(
            passed_over.contains("eth0=10.1.2.3 netmask 255.0.255.0"),
            "the log line must name the mask so the host is diagnosable, got: \
             {passed_over}"
        );
        // And say why. Without this, `Verdict::NetmaskNotContiguous`'s `reason()` arm
        // is the one string in that match no test reads, so it could be reworded into
        // any other verdict's reason — or into "chosen" — and stay green.
        assert!(
            passed_over.contains("netmask is not contiguous"),
            "the audit line must give the reason as well as the value, got: \
             {passed_over}"
        );
        assert!(
            !passed_over.contains("10.1.2.3/16"),
            "and it must NOT print the `count_ones` prefix, which describes nothing and \
             would read as a fact about the subnet, got: {passed_over}"
        );
    }

    /// The contiguity gate runs *before* the prefix gates, and that ordering is the
    /// diagnostic (#4105).
    ///
    /// Measured gap, not a hypothetical: moving the gate below the two `prefix_len`
    /// checks leaves the test above green, because `255.0.255.0` counts to 16 and 16
    /// passes both of them either way. So nothing pinned the position, and the position
    /// is what decides which reason an operator is handed.
    ///
    /// `253.0.0.0` is the case that separates them. It is `11111101 …` — a gap in the
    /// first octet — and `count_ones` calls it a `/7`, which is *below*
    /// [`MIN_IPV4_PREFIX_LEN`]. With the gate first the verdict names the mask; with the
    /// gate last, `PrefixTooBroad` fires first and [`BindDecision::passed_over`] prints
    /// `eth0=10.1.2.3/7` — a confident prefix for an interface whose whole problem is
    /// that no prefix describes it, and the exact misleading audit line #4105 exists to
    /// prevent. The bind outcome is a rejection under both orderings; only the reason
    /// changes, which is precisely why no other test can catch this.
    #[test]
    fn a_mask_whose_bit_count_also_fails_the_prefix_gate_is_still_named_as_the_mask() {
        // Precondition, asserted rather than assumed: the bit count really does land
        // under the prefix floor, or the two orderings agree and this pins nothing.
        let count_ones = u32::from("253.0.0.0".parse::<Ipv4Addr>().expect("literal parses"))
            .count_ones()
            .try_into()
            .expect("a 32-bit popcount fits in u8");
        assert!(
            count_ones < MIN_IPV4_PREFIX_LEN,
            "253.0.0.0 must count to fewer than {MIN_IPV4_PREFIX_LEN} bits for this test \
             to distinguish the two orderings; got /{count_ones}"
        );

        let decision = decide(
            vec![with_netmask(
                LanInterface::new("eth0", "10.1.2.3", count_ones),
                "253.0.0.0",
            )],
            None,
        );

        assert_eq!(
            decision.verdicts.first().map(|(_, verdict)| *verdict),
            Some(Verdict::NetmaskNotContiguous),
            "the mask is what is wrong with this interface; `PrefixTooBroad` would be a \
             true statement about a number that describes nothing"
        );
        let passed_over = decision.passed_over();
        assert!(
            passed_over.contains("eth0=10.1.2.3 netmask 253.0.0.0"),
            "and the audit line must carry the mask, got: {passed_over}"
        );
        assert!(
            !passed_over.contains("10.1.2.3/"),
            "never the derived prefix — that is the line the reordering would produce, \
             got: {passed_over}"
        );
    }

    /// The rejection is a rejection, so a sane NIC alongside it still wins — and the
    /// bind takes *that* interface's prefix.
    ///
    /// A candidate whose mask is malformed must not be able to affect the outcome for
    /// the ones whose masks are fine, which is the property that makes rejecting it
    /// safe.
    #[test]
    fn a_sane_nic_is_chosen_alongside_an_interface_with_a_broken_netmask() {
        let decision = decide(
            vec![
                with_netmask(LanInterface::new("eth0", "10.1.2.3", 16), "255.0.255.0"),
                LanInterface::new("wlp2s0", "192.160.160.80", 24),
            ],
            None,
        );

        assert_eq!(
            decision.lan_ip,
            Some("192.160.160.80".parse::<Ipv4Addr>().unwrap()),
            "the interface with a usable netmask must win; passed over: {}",
            decision.passed_over()
        );
        assert_eq!(
            decision.prefix_len, 24,
            "and the confinement boundary is the winner's own prefix"
        );
        assert_eq!(
            decision.verdicts.first().map(|(_, verdict)| *verdict),
            Some(Verdict::NetmaskNotContiguous),
            "the broken interface is still reported, not silently dropped"
        );
    }

    // -- The bind the decision feeds (#3869) ----------------------------------

    /// `host_addrs` is the whole sweep, rejected candidates included.
    ///
    /// It answers "what addresses does this host hold", which is a different question
    /// from "what could this host bind": loopback and a NO-CARRIER bridge are held just
    /// as much as the winner. Narrowing it to the rankable ones would be a second,
    /// smaller disagreement with the enumeration — the same class of bug as taking a
    /// second sweep, arrived at by editing instead of by timing.
    #[test]
    fn host_addrs_reports_every_enumerated_address_not_only_the_rankable_ones() {
        let decision = decide(desktop_interfaces(), None);

        let expected: Vec<IpAddr> = [
            "127.0.0.1",
            "192.160.160.80",
            "192.168.32.1",
            "10.0.6.1",
            "10.0.7.1",
            "100.64.0.1",
        ]
        .iter()
        .map(|ip| IpAddr::V4(ip.parse().expect("test literal is a valid IPv4 address")))
        .collect();

        assert_eq!(
            decision.host_addrs(),
            expected,
            "the list handed to the locality gate must be the enumeration itself — in \
             order, and including the addresses the policy refused"
        );
    }

    /// The invariant the "the daemon's bind can no longer be refused for locality"
    /// claim rests on, asserted rather than argued (#3869).
    ///
    /// `bind_locality_ok` passes iff the address is not publicly routable **or** it is in
    /// the list. So the claim is exactly: for every decision, `bind` is either loopback or
    /// one of [`BindDecision::host_addrs`]. Every shape [`decide`] can return is here,
    /// because the argument is a case analysis and a case analysis with a gap is a
    /// counterexample: a winner, a lone winner, every candidate rejected, and no
    /// candidates at all — the last two being the loopback fallback, where `verdicts` need
    /// not contain `bind` and the first disjunct is what saves it.
    ///
    /// Changing `host_addrs` to skip rejected entries keeps this green (the winner is
    /// never rejected); changing it to skip the *chosen* one reddens the first two rows,
    /// which is the mutation this is aimed at.
    #[test]
    fn the_bound_address_is_always_one_the_locality_gate_can_vouch_for() {
        let cases: Vec<(&str, Vec<LanInterface>)> = vec![
            ("a contested host", desktop_interfaces()),
            (
                // Publicly routable on purpose: an RFC 1918 single candidate satisfies
                // the first disjunct and would assert nothing about the list.
                "a single candidate",
                vec![LanInterface::new("eth0", "192.160.160.80", 24)],
            ),
            (
                "every candidate rejected",
                vec![
                    LanInterface::new("lo", "127.0.0.1", 8),
                    down(LanInterface::new("docker0", "172.17.0.1", 16)),
                ],
            ),
            ("no candidates at all", vec![]),
        ];

        for (label, candidates) in cases {
            let decision = decide(candidates, None);
            let vouched = decision.host_addrs().contains(&decision.bind.ip());
            assert!(
                !is_publicly_routable(&decision.bind) || vouched,
                "{label}: `lan_only` refuses a publicly-routable bind it cannot find in \
                 the list, so a decision that binds one it did not enumerate is a daemon \
                 that fails to start. bind={}, host_addrs={:?}",
                decision.bind,
                decision.host_addrs()
            );
        }
    }

    /// The race, and the reason this is threaded at all (#3869).
    ///
    /// `select_bind_target` enumerates the host to choose an address; `lan_only` used to
    /// enumerate it *again* to decide whether that address may be claimed. Between the
    /// two sweeps an address can go away — a DHCP lease expiring, Wi-Fi roaming, a
    /// hotspot switched off — and the second sweep then refuses a bind the first sweep
    /// had just chosen. `daemon_loop` maps that refusal to an error and the whole daemon
    /// fails to start, where a host with genuinely no LAN would have come up on the
    /// loopback fallback and said so: the narrow failure was strictly louder than the
    /// total one.
    ///
    /// The two calls below are the two sweeps. The second argument is the only difference
    /// between them, and it is the difference between a bound endpoint and a dead daemon.
    ///
    /// Non-vacuous by construction: the fixture's LAN is `192.160.160.0/24`, real public
    /// space (the reporting hardware), so the locality gate is actually consulted — with
    /// an RFC 1918 address it passes whatever list it is handed and this test would pin
    /// nothing. That precondition is asserted rather than assumed.
    #[test]
    fn the_bind_gate_is_answered_from_the_sweep_that_chose_the_address() {
        use crate::transport::endpoint::{
            LanBindError, RecordingResolver, lan_only_with_host_addrs,
        };
        use iroh_dns::dns::DnsResolver;

        let decision = decide(
            vec![
                LanInterface::new("lo", "127.0.0.1", 8),
                LanInterface::new("wlp2s0", "192.160.160.80", 24),
            ],
            None,
        );
        assert!(
            decision.internet_facing,
            "precondition: the chosen address must be publicly routable, or the locality \
             gate short-circuits and neither call below tests it"
        );

        // One sweep: the addresses this decision was made from. Nothing is bound —
        // `lan_only_with_host_addrs` returns a builder — so this opens no socket.
        lan_only_with_host_addrs(
            decision.bind,
            decision.prefix_len,
            DnsResolver::custom(RecordingResolver::new()),
            &decision.host_addrs(),
        )
        .map(|_| ())
        .expect(
            "the address was chosen from this very list, so the gate that asks whether \
             the host holds it can only answer yes",
        );

        // A second sweep that no longer sees the address: the window that used to exist
        // between `select_bind_target` and the bind. Same bind, same prefix, and the
        // daemon dies.
        let err = lan_only_with_host_addrs(
            decision.bind,
            decision.prefix_len,
            DnsResolver::custom(RecordingResolver::new()),
            &[],
        )
        .map(|_| ())
        .expect_err(
            "control: an enumeration that has lost the address is what made this a race \
             rather than a redundant syscall",
        );
        assert!(
            matches!(err, LanBindError::BindAddressNotPrivate { .. }),
            "got {err:?}"
        );
    }

    // -- The impure entry points ----------------------------------------------
    //
    // These read the host, so they cannot be pinned against a fixture. What can be
    // asserted is what holds on *every* host; what cannot is called out below rather
    // than left to look covered.

    /// The route probe, aimed somewhere with a route that is guaranteed to exist.
    ///
    /// The previous test here asserted `!ip.is_unspecified()` on the default-route
    /// probe, which was vacuous twice over: `route_source_ipv4` filters the unspecified
    /// address by construction, and on a host with no default route the probe returns
    /// `None` and the assertion never ran at all. Aiming at loopback removes both
    /// escapes — every host routes `127.0.0.0/8` — so `None` here is a real failure.
    ///
    /// What this pins: that the probe connects and reads back a concrete *source*
    /// address. Drop the `connect` and the socket stays on `0.0.0.0`, which the filter
    /// turns into `None`; drop the `local_addr` read and there is nothing to return.
    /// What it does not pin: the choice of TEST-NET-1 as the production destination —
    /// that is an argument about which routes could capture the probe, and no test on
    /// one machine can settle it.
    #[test]
    fn the_route_probe_reports_the_source_address_for_a_route_that_exists() {
        let via_loopback = route_source_ipv4("127.0.0.1:9".parse().expect("literal parses"));
        assert_eq!(
            via_loopback,
            Some(Ipv4Addr::LOCALHOST),
            "every host has a route for 127.0.0.0/8, so the probe must answer with the \
             source address the kernel picked for it"
        );

        // The real probe may legitimately answer `None` (no default route). If it
        // answers at all, it must name an address this host actually holds — a source
        // address it does not hold would rank a candidate that does not exist.
        if let Some(source) = default_route_source_ipv4() {
            let held: Vec<Ipv4Addr> = host_candidates().iter().map(|c| c.ip).collect();
            assert!(
                held.contains(&source),
                "the default-route source {source} must be one of this host's own \
                 addresses, got {held:?}"
            );
        }
    }

    /// `host_candidates` maps `if_addrs` into the policy's input type.
    ///
    /// Only the invariants that hold on every host are asserted here: the one address
    /// every machine has, and the field ranges the policy depends on. The two flag fields
    /// are cross-checked against the kernel by
    /// `the_flag_mapping_matches_what_the_kernel_reports` (Linux only).
    #[test]
    fn host_candidates_reports_this_hosts_ipv4_addresses() {
        let candidates = host_candidates();
        assert!(
            candidates.iter().any(|c| c.ip.is_loopback()),
            "every host has a loopback IPv4 address; reporting none means the v4 filter \
             dropped everything, which is a silent loopback-fallback bind — got \
             {candidates:?}"
        );
        for candidate in &candidates {
            assert!(
                !candidate.name.is_empty(),
                "an unnamed interface cannot be classified or logged: {candidate:?}"
            );
            assert!(
                candidate.prefix_len <= 32,
                "an IPv4 prefix above /32 is not an address: {candidate:?}"
            );
        }
    }

    /// The two flag fields, cross-checked against what the kernel itself reports.
    ///
    /// `decide`'s table pins what `is_up` and `is_p2p` *mean*; nothing pinned that they
    /// are read from the right `if_addrs` field. Hardcoding `is_up: true, is_p2p: false`
    /// in [`host_candidates`] left the whole suite green — and `is_up: true` is not a
    /// harmless mutation, it readmits every NO-CARRIER bridge, including the
    /// `docker0 192.168.32.1` the old code bound on the reporting desktop.
    ///
    /// Linux only, because the cross-check reads `/sys/class/net`. The rule it encodes is
    /// the kernel's own: `dev_get_flags()` sets `IFF_RUNNING` iff the link is
    /// administratively up **and** `netif_oper_up()`, and `netif_oper_up()` counts
    /// `IF_OPER_UNKNOWN` as up. `if-addrs` maps `IFF_RUNNING` to `IfOperStatus::Up` and
    /// everything else to `Unknown` (see [`LanInterface::is_up`]) — so `operstate
    /// unknown` must arrive as `is_up == true`, and `operstate down` as `false`.
    ///
    /// # What it does and does not pin
    ///
    /// Non-vacuous on every Linux host for the `unknown ⇒ up` direction: `lo` reports
    /// `operstate unknown`, so that branch is always exercised — which is asserted below
    /// rather than assumed. The `down ⇒ not up` direction needs a NO-CARRIER interface
    /// carrying an IPv4 address (the reporting desktop has two, `docker0` and
    /// `incusbr0`), and the `is_p2p` direction needs a point-to-point interface with one
    /// (`zcctun0`). Both are conditional on the machine and are listed as residual
    /// coverage. Nothing here pins the Windows mapping, where `IfOperStatus::Unknown` is
    /// the adapter's real answer rather than "no carrier"; rejecting it there is stricter
    /// than needed and is also residual. Where `/sys/class/net` is masked entirely — some
    /// hardened container runtimes do that — there is no oracle to compare against and the
    /// test skips; see the early return for why that does not weaken the guarantee on the
    /// hosts that do expose it.
    ///
    /// `/sys/class/net/*/flags` is `dev->flags`, which does **not** carry the derived
    /// `IFF_RUNNING` / `IFF_LOWER_UP` bits — hence reconstructing the rule from
    /// `operstate` rather than reading a running bit that is not there.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_flag_mapping_matches_what_the_kernel_reports() {
        /// `<linux/if.h>`.
        const IFF_UP: u64 = 0x1;
        /// `<linux/if.h>`.
        const IFF_POINTOPOINT: u64 = 0x10;

        /// Every interface the kernel currently reports, as (operstate, flags).
        fn kernel_snapshot() -> std::collections::HashMap<String, (String, u64)> {
            let mut snapshot = std::collections::HashMap::new();
            let Ok(dir) = std::fs::read_dir("/sys/class/net") else {
                return snapshot;
            };
            for entry in dir.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let attr = |attr: &str| {
                    std::fs::read_to_string(format!("/sys/class/net/{name}/{attr}"))
                        .ok()
                        .map(|value| value.trim().to_owned())
                };
                let (Some(operstate), Some(flags)) = (attr("operstate"), attr("flags")) else {
                    continue;
                };
                let Ok(flags) = u64::from_str_radix(flags.trim_start_matches("0x"), 16) else {
                    continue;
                };
                snapshot.insert(name, (operstate, flags));
            }
            snapshot
        }

        // Bracket the enumeration, and assert only about interfaces whose state did not
        // move between the two reads: a link flapping mid-test is otherwise the one way
        // this could go red with the code untouched.
        let before = kernel_snapshot();
        let candidates = host_candidates();
        let after = kernel_snapshot();

        if before.is_empty() {
            // No `/sys/class/net` at all — a hardened container runtime can mask it, and
            // some do. There is then no kernel answer to cross-check against, which is
            // an absent oracle, not a failing one, so skip rather than fail.
            //
            // The non-vacuity guarantee is preserved by *where* this returns: the
            // `checked > 0` assertion below still runs on every host that exposes the
            // directory, and an empty snapshot is the only way to reach it having checked
            // nothing. A host that publishes interfaces but whose names do not line up
            // with what `host_candidates` reports still goes red there — which is the
            // mapping bug that assertion exists to catch.
            return;
        }

        let mut checked = 0_usize;
        let mut unknown_operstate_seen = 0_usize;
        for candidate in &candidates {
            let (Some(state), Some(unchanged)) =
                (before.get(&candidate.name), after.get(&candidate.name))
            else {
                continue;
            };
            if state != unchanged {
                continue;
            }
            let (operstate, flags) = state;
            let admin_up = flags & IFF_UP != 0;
            let oper_up = matches!(operstate.as_str(), "up" | "unknown");

            assert_eq!(
                candidate.is_up,
                admin_up && oper_up,
                "{}: the kernel says operstate={operstate} flags={flags:#x}, so \
                 IFF_RUNNING is {}, and `if_addrs` maps that to is_up={}. Reading a \
                 different field — or hardcoding this one — either rejects a working NIC \
                 into the loopback fallback or readmits a NO-CARRIER bridge, which is \
                 both halves of #3853",
                candidate.name,
                admin_up && oper_up,
                admin_up && oper_up
            );
            assert_eq!(
                candidate.is_p2p,
                flags & IFF_POINTOPOINT != 0,
                "{}: IFF_POINTOPOINT is {} in flags={flags:#x}; a tunnel that does not \
                 report as point-to-point is ranked as an ordinary NIC and can win",
                candidate.name,
                flags & IFF_POINTOPOINT != 0
            );

            checked += 1;
            if operstate == "unknown" {
                unknown_operstate_seen += 1;
            }
        }

        assert!(
            checked > 0,
            "precondition: no interface could be cross-checked against /sys/class/net, so \
             this test asserted nothing"
        );
        assert!(
            unknown_operstate_seen > 0,
            "precondition: no interface reported `operstate unknown`, so the branch this \
             test exists for — that `unknown` means *usable*, not rejected — was never \
             exercised. `lo` reports it on every Linux host"
        );
    }

    /// `select_bind_target` is the impure wrapper. What it must not do is return a
    /// decision whose parts disagree — a `lan_ip` that is not the address in `bind`, or
    /// a prefix `lan_only` will refuse — because the caller passes both to
    /// `SyncService::bind` and the mDNS announce separately.
    ///
    /// It cannot assert *which* interface this machine should pick: that depends on the
    /// machine, and asserting it here is exactly the mistake `decide`'s fixture table
    /// exists to avoid.
    #[test]
    fn select_bind_target_returns_a_self_consistent_decision() {
        let decision = select_bind_target();

        assert_eq!(decision.bind.port(), 0, "the OS assigns the port");
        assert!(
            decision.prefix_len >= MIN_IPV4_PREFIX_LEN,
            "a prefix `lan_only` refuses would fail the bind on a host this code just \
             chose the address for; got /{}",
            decision.prefix_len
        );
        match decision.lan_ip {
            Some(ip) => {
                assert_eq!(
                    decision.bind.ip(),
                    IpAddr::V4(ip),
                    "the announced address and the bound address must be the same one; \
                     announcing a different address is #3853's other half"
                );
                assert_eq!(
                    decision
                        .verdicts
                        .iter()
                        .filter(|(_, verdict)| *verdict == Verdict::Chosen)
                        .count(),
                    1,
                    "exactly one candidate is chosen"
                );
            }
            None => {
                assert_eq!(
                    decision.bind,
                    SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
                    "no LAN address means the loopback fallback, nothing else"
                );
                assert_eq!(decision.level, Level::Warn);
            }
        }
    }
}
