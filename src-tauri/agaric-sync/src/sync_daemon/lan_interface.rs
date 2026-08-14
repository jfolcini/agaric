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
//! 1. **Class** (hard-ordered, best first)
//!    1. physical-named, ordinary unicast
//!    2. physical-named, CGNAT (`100.64/10`)
//!    3. virtual-named or point-to-point, ordinary unicast
//!    4. virtual-named or point-to-point, CGNAT
//! 2. **The default route**, as a tiebreak *within* a class.
//! 3. Enumeration order, so the result is deterministic.
//!
//! ### Why the default route is a tiebreak and not the primary key
//!
//! Issue #3853 suggests "prefer the interface carrying the default route", and
//! that is right on a desktop — but it is exactly wrong on the reporting phone.
//! When a VPN is up the default route deliberately points **away** from the LAN,
//! at a `tun`/`wg` interface. Making the default route the primary key would
//! pick the tunnel and reproduce the bug in a new costume. Ranking class first
//! and using the route only to break ties inside a class keeps the desktop case
//! (the route names the real NIC, which is already class 1) while refusing the
//! phone case (the tunnel is class 3, or rejected outright as a `/32`).
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
    pub prefix_len: u8,
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
    #[cfg(test)]
    fn new(name: &str, ip: &str, prefix_len: u8) -> Self {
        Self {
            name: name.to_owned(),
            ip: ip.parse().expect("test literal is a valid IPv4 address"),
            prefix_len,
            is_up: true,
            is_p2p: false,
        }
    }
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
/// addressed and up — a Tailscale or Docker interface, say. Both are then class 2, so the
/// class ordering has nothing left to say and the default-route hint alone decides. On
/// such a host the route normally leaves via the LAN bridge, which is the right answer;
/// with no default route (isolated LAN, router down) the tie falls to enumeration order
/// and the choice is arbitrary. That is loud rather than silent — more than one candidate
/// is rankable, so the decision is a WARN carrying the full `passed_over` list — and
/// fixing it properly needs the routing table, not a name.
///
/// Adding a prefix is therefore cheap only when the name is *system-assigned*: entries
/// that a user could plausibly have chosen for their own LAN interface do not belong here.
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
    "p2p0",      // Android Wi-Fi Direct
    "ap0",       // Android / Linux soft-AP (hotspot) interface
];

/// Does this name look like a virtual interface?
fn has_virtual_name(name: &str) -> bool {
    VIRTUAL_NAME_PREFIXES
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
    /// Rankable, but a virtual / point-to-point interface and a better class existed.
    PassedOverVirtual,
    /// Rankable, but CGNAT and a better class existed.
    PassedOverCgnat,
    /// Rankable, but *both* virtual / point-to-point **and** CGNAT (the worst class).
    ///
    /// Its own variant rather than folding into [`Self::PassedOverVirtual`]: the reporting
    /// desktop's `zcctun0 100.64.0.1` is exactly this pair, and a log line that names only
    /// the tunnel half sends the reader looking for the address reason that is already
    /// known. Selection is unaffected — [`class`] already ranks the pair last.
    PassedOverVirtualCgnat,
    /// Rankable and in the winning class, but it lost the default-route tiebreak.
    PassedOverLowerPriority,
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
            Self::PassedOverVirtual => "virtual or point-to-point interface",
            Self::PassedOverCgnat => "CGNAT 100.64/10 — a carrier network, not a LAN",
            Self::PassedOverVirtualCgnat => {
                "virtual or point-to-point interface, on CGNAT 100.64/10"
            }
            Self::PassedOverLowerPriority => "does not carry the default route",
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
    if candidate.prefix_len >= 32 {
        return Some(Verdict::HostRoute);
    }
    if candidate.prefix_len < MIN_IPV4_PREFIX_LEN {
        return Some(Verdict::PrefixTooBroad);
    }
    None
}

/// Ranking class — lower is better. See the module docs for the ordering rationale.
fn class(candidate: &LanInterface) -> u8 {
    let virtual_iface = candidate.is_p2p || has_virtual_name(&candidate.name);
    let cgnat = is_cgnat(candidate.ip);
    match (virtual_iface, cgnat) {
        (false, false) => 0,
        (false, true) => 1,
        (true, false) => 2,
        (true, true) => 3,
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
    /// One-line summary of everything that was *not* chosen, for the log.
    pub fn passed_over(&self) -> String {
        let summary: Vec<String> = self
            .verdicts
            .iter()
            .filter(|(_, verdict)| *verdict != Verdict::Chosen)
            .map(|(candidate, verdict)| {
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
                // Placeholder; overwritten once the winner is known.
                rankable.push(verdicts.len());
                verdicts.push((candidate, Verdict::PassedOverLowerPriority));
            }
        }
    }

    // Best class first; inside a class the default-route holder first; then enumeration
    // order, which `min_by_key` preserves because the index is the final key.
    let winner = rankable.iter().copied().min_by_key(|&idx| {
        let candidate = &verdicts[idx].0;
        let on_default_route = u8::from(route_hint != Some(candidate.ip));
        (class(candidate), on_default_route, idx)
    });

    let Some(winner) = winner else {
        return loopback_fallback(verdicts);
    };

    let winning_class = class(&verdicts[winner].0);
    for &idx in &rankable {
        if idx == winner {
            verdicts[idx].1 = Verdict::Chosen;
            continue;
        }
        let candidate = &verdicts[idx].0;
        verdicts[idx].1 = if class(candidate) <= winning_class {
            // Same class as the winner — a strictly better class is impossible, the
            // winner holds the minimum — so what it lost was the route tiebreak or,
            // failing that, enumeration order.
            Verdict::PassedOverLowerPriority
        } else if is_cgnat(candidate.ip) {
            // Class 1 or class 3. Class 3 is *both* things and says so: the reporting
            // desktop's `zcctun0 100.64.0.1` is exactly that pair, and a line naming only
            // one half sends the reader looking for a second reason that is already there.
            if candidate.is_p2p || has_virtual_name(&candidate.name) {
                Verdict::PassedOverVirtualCgnat
            } else {
                Verdict::PassedOverCgnat
            }
        } else {
            // Class 2: virtual, ordinary address. Class 0 cannot reach here — it is the
            // best class, so `class(candidate) > winning_class` already excluded it.
            Verdict::PassedOverVirtual
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
    let level = if internet_facing || rankable.len() > 1 || winning_class > 0 {
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
    /// delete `winning_class > 0` and two do — the `bridge_only` line below *and*
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
        let mixed = vec![
            LanInterface::new("rmnet0", "100.64.0.1", 16),
            LanInterface::new("wlan0", "192.168.0.30", 24),
        ];
        assert_eq!(
            chosen(&decide(mixed, None)).map(|c| c.name.as_str()),
            Some("wlan0")
        );

        let alone = vec![LanInterface::new("rmnet0", "100.64.0.1", 16)];
        assert_eq!(
            decide(alone, None).lan_ip,
            Some("100.64.0.1".parse::<Ipv4Addr>().unwrap())
        );
    }

    /// Each losing class states *its own* reason, and the worst class states both halves.
    ///
    /// One list, one winner, one loser per class, so an arm that collapses into another
    /// names itself. Class 3 is why this exists: it was reported as `PassedOverVirtual`
    /// alone, so the log said "virtual or point-to-point interface" about the desktop's
    /// `zcctun0 100.64.0.1` and never mentioned that the address is a carrier one too —
    /// leaving the reader to work out which of the two ordering rules had applied.
    /// Selection was never affected; [`class`] already ranks the pair last.
    #[test]
    fn every_passed_over_class_states_its_own_reason() {
        let decision = decide(
            vec![
                LanInterface::new("eth0", "192.168.1.10", 24), // class 0, wins on order
                LanInterface::new("eth1", "192.168.2.10", 24), // class 0, lost the tiebreak
                LanInterface::new("rmnet0", "100.64.0.1", 16), // class 1, CGNAT only
                LanInterface::new("docker0", "172.17.0.1", 16), // class 2, virtual only
                p2p(LanInterface::new("zcctun0", "100.64.1.1", 16)), // class 3, both
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
                ("eth1", Verdict::PassedOverLowerPriority),
                ("rmnet0", Verdict::PassedOverCgnat),
                ("docker0", Verdict::PassedOverVirtual),
                ("zcctun0", Verdict::PassedOverVirtualCgnat),
            ],
            "a candidate that is both virtual and CGNAT must not be filed under either \
             half alone; passed over: {}",
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
