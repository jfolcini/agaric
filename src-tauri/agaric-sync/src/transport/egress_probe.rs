//! Would traffic to this peer actually leave by the interface we bound? (#4299)
//!
//! # The failure this exists to name
//!
//! A VPN that captures the LAN is, from inside the app, indistinguishable from a
//! sleeping peer. Link-local multicast (`224.0.0.251`) escapes a tunnel, so mDNS
//! discovery keeps working and the peer appears in the device list; every unicast
//! dial is routed *into* the tunnel and blackholed, so every connect attempt ends
//! in the same plain timeout a peer with its lid shut would produce. The recorded
//! case was an enterprise tunnel on an Android handset whose route table carried
//! `192.160.0.0/13` — which swallowed a LAN numbered `192.160.160.0/24`, because
//! that range is genuinely *public* address space one digit away from
//! `192.168.x.x`. It cost days.
//!
//! What diagnosed it in the end was one command:
//!
//! ```text
//! $ ip route get 192.160.160.80 uid 10408
//! 192.160.160.80 dev tun0 table 1178 src 100.64.0.1     <-- the tunnel, not the LAN
//! ```
//!
//! The source address the kernel picks for a destination is the whole answer: it
//! named the tunnel while the sync endpoint was bound to a `192.160.160.x`
//! address. This module is that command, in portable unprivileged userspace.
//!
//! # How, and why no packets are sent
//!
//! `connect()` on a `SOCK_DGRAM` socket is not a handshake. It installs a default
//! destination on the socket, which makes the kernel resolve a route *now* and
//! bind the socket to the source address that route selects. `getsockname()` then
//! reads that selection back. Nothing is transmitted, nothing is observable from
//! the network, and both calls are non-blocking — two syscalls, no I/O wait, which
//! is why [`probe_peer_egress`] is a plain synchronous fn callable from an async
//! context.
//!
//! Comparing that selection against the address the sync endpoint actually bound
//! answers a question no timeout can: *would our packets to this peer even leave
//! by the interface we are speaking from?* A mismatch means they would not — they
//! are going somewhere else and dying there.
//!
//! # Why this and not a VPN interrogation
//!
//! Asking the platform whether a VPN is up is more precise and costs four
//! implementations, a JNI hop on Android, and permission-gated surfaces. A route
//! comparison is one implementation across Linux, Android, macOS and Windows, and
//! it catches the whole class rather than one vendor: split-tunnel VPNs, corporate
//! clients, multi-homed hosts, a mis-scoped default route. It also catches the
//! case the original bug turned on, which a "is this RFC1918?" heuristic would
//! have missed entirely — a route comparison does not care what the numbers look
//! like.
//!
//! # What a verdict claims
//!
//! [`EgressVerdict::RoutedElsewhere`] claims exactly one thing: the system would
//! send traffic for this peer out of a different source address than the one this
//! device bound. It does **not** claim a VPN — that is a hypothesis for the log
//! line and a hedged "may" in the user-facing text, not a finding. Every failure,
//! every ambiguity and every comparison between unlike things answers
//! [`EgressVerdict::Inconclusive`], because the cost of a wrong "your network is
//! broken" is a user chasing a network that is fine.
//!
//! # Android: the probe must NOT bind to a network
//!
//! Production's socket is bound to a specific network (iroh binds the address
//! `lan_interface` chose; on Android the platform additionally pins the socket to
//! the selected `Network`). **This probe deliberately does neither.** It binds the
//! wildcard address and lets the system choose, because the *system's default
//! routing decision* is precisely the thing being measured — and the difference
//! between that decision and our pinned bind IS the signal. A probe that inherited
//! the production binding would agree with itself every time and detect nothing.
//! See [`system_source_address_for`].

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket};

/// What the egress probe concluded about one peer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EgressVerdict {
    /// The system would source traffic for this peer from the same address the
    /// sync endpoint bound. Routing agrees with our bind; the dial failure has
    /// some other cause (a sleeping peer, a firewall on the far end) and this
    /// module has nothing to add.
    SameEgress,
    /// The system would source traffic for this peer from a *different* address
    /// than the one the sync endpoint bound — our packets would leave by another
    /// interface than the one we are speaking from.
    RoutedElsewhere,
    /// No usable comparison. A socket that would not open, a route that does not
    /// resolve, a bind address that names no interface (loopback, wildcard), or
    /// two addresses from different families. Never a diagnosis.
    Inconclusive,
}

/// A verdict plus the addresses that produced it, for the log line.
///
/// The addresses are here and **not** in the user-facing message on purpose: that
/// message doubles as the repeat-failure suppression key in
/// `session_supervisor::record_initiator_failure`, so a varying detail in it
/// un-suppresses the toast on every cycle. Varying details belong in `tracing`
/// fields, which have no such contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EgressReport {
    pub verdict: EgressVerdict,
    /// The endpoint's bound address that the comparison used, if one was usable.
    pub bound: Option<IpAddr>,
    /// The source address the system selected for `candidate`, if the probe
    /// resolved one.
    pub probed: Option<IpAddr>,
    /// The peer candidate the verdict is about, if a comparison happened.
    pub candidate: Option<SocketAddr>,
}

impl EgressReport {
    /// The verdict that says nothing.
    const fn inconclusive() -> Self {
        Self {
            verdict: EgressVerdict::Inconclusive,
            bound: None,
            probed: None,
            candidate: None,
        }
    }
}

/// Compare the address we bound against the source address the system picked.
///
/// Pure, total, and the only place the verdict rules live — the syscalls in
/// [`system_source_address_for`] exist to feed this and nothing else, which is
/// what lets the rules be tested without a network.
///
/// The rules, and why each answers the way it does:
///
/// * **Different families** → `Inconclusive`. An IPv4 bind and an IPv6 source
///   address are not evidence of anything; they are two different conversations.
///   Only like is compared with like.
/// * **Unspecified bound address** (`0.0.0.0` / `::`) → `Inconclusive`. A wildcard
///   bind has not chosen an interface, so there is nothing for the system's choice
///   to disagree with. (Production binds a specific LAN address — see
///   `transport::endpoint::lan_only` — so this is the defensive arm, not the
///   normal one.)
/// * **Loopback on either side** → `Inconclusive`. A loopback bind is a test
///   endpoint and a loopback source means the destination was loopback; neither
///   says anything about how this host reaches a LAN.
/// * **Equal** → `SameEgress`.
/// * **Anything else** → `RoutedElsewhere`. Note this is deliberately *address*
///   equality and not subnet containment: a source the kernel picked that differs
///   at all from the address our socket is pinned to means our packets carry a
///   source the route was not chosen for, which is the condition regardless of
///   whether the two happen to share a prefix.
#[must_use]
pub fn compare(bound: IpAddr, probed: IpAddr) -> EgressVerdict {
    let unusable = |ip: &IpAddr| match ip {
        IpAddr::V4(v4) => v4.is_unspecified() || v4.is_loopback(),
        IpAddr::V6(v6) => v6.is_unspecified() || v6.is_loopback(),
    };

    match (bound, probed) {
        (IpAddr::V4(_), IpAddr::V6(_)) | (IpAddr::V6(_), IpAddr::V4(_)) => {
            EgressVerdict::Inconclusive
        }
        _ if unusable(&bound) || unusable(&probed) => EgressVerdict::Inconclusive,
        _ if bound == probed => EgressVerdict::SameEgress,
        _ => EgressVerdict::RoutedElsewhere,
    }
}

/// Ask the system which source address it would use to reach `dest`, without
/// sending anything.
///
/// Returns `None` — never a panic and never a guess — if the socket will not
/// open, the route does not resolve, or the local address cannot be read. Every
/// one of those is an `Inconclusive` upstream.
///
/// # The wildcard bind is load-bearing (Android)
///
/// The socket is bound to the *wildcard* address of the destination's family and
/// to **no** particular network or interface. That is not laziness: production
/// pins its socket to the interface `lan_interface` selected (and, on Android, to
/// the selected `Network`), and if this probe inherited that pinning it would
/// simply read back the address it was given and report agreement with itself
/// forever. The measurement wanted here is the *system's own* default routing
/// decision for this destination, which is only observable from an unpinned
/// socket. The gap between that decision and our pinned bind is the entire signal.
fn system_source_address_for(dest: SocketAddr) -> Option<IpAddr> {
    let wildcard: SocketAddr = match dest {
        SocketAddr::V4(_) => SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0),
        SocketAddr::V6(_) => SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), 0),
    };
    // Deliberately unbound to any interface/network — see the doc comment above.
    let socket = UdpSocket::bind(wildcard).ok()?;
    // No packet leaves here: UDP `connect` only installs a default destination,
    // which makes the kernel resolve the route and select a source address.
    socket.connect(dest).ok()?;
    socket.local_addr().ok().map(|addr| addr.ip())
}

/// The probe: does the system route any of this peer's candidate addresses away
/// from the address we bound?
///
/// `bound` is the endpoint's own bound sockets (`Endpoint::bound_sockets`, which
/// yields an IPv4 entry and, where available, an IPv6 one); `candidates` are the
/// peer's advertised addresses.
///
/// # Why one `SameEgress` outranks every mismatch
///
/// A peer on a multi-homed LAN advertises several addresses and only some of them
/// are ours to reach. If *any* candidate routes out of the address we bound, then
/// a path to this peer exists from where we are speaking and a dial failure is not
/// a routing story — so the whole peer answers `SameEgress` and this module stays
/// quiet. `RoutedElsewhere` requires that no candidate agreed and at least one
/// disagreed: every path we could take to this peer leaves by somewhere else.
///
/// That ordering is the conservative one on purpose. The cheap error here is
/// staying silent about a captured LAN, which leaves the user exactly where they
/// were before this module existed. The expensive error is telling a user with a
/// perfectly good network that it is broken.
#[must_use]
pub fn probe_peer_egress(bound: &[SocketAddr], candidates: &[SocketAddr]) -> EgressReport {
    probe_with(bound, candidates, system_source_address_for)
}

/// [`probe_peer_egress`] with the syscall injected.
///
/// The aggregation above is policy — which candidate wins, which verdict outranks
/// which — and policy that can only be exercised against the machine it happens to
/// be running on is policy no test can pin. `source_for` is the seam: production
/// passes [`system_source_address_for`], tests pass a route table they wrote, and
/// neither the rules nor the ordering depend on CI's network topology.
fn probe_with<F>(bound: &[SocketAddr], candidates: &[SocketAddr], source_for: F) -> EgressReport
where
    F: Fn(SocketAddr) -> Option<IpAddr>,
{
    let mut mismatch: Option<EgressReport> = None;

    for candidate in candidates {
        // Like with like: a v6 candidate is only ever compared against a v6 bind.
        let Some(bound_addr) = bound
            .iter()
            .find(|b| b.is_ipv4() == candidate.is_ipv4())
            .map(SocketAddr::ip)
        else {
            continue;
        };
        let Some(probed) = source_for(*candidate) else {
            continue;
        };
        match compare(bound_addr, probed) {
            EgressVerdict::SameEgress => {
                // One good path is enough; stop and say so.
                return EgressReport {
                    verdict: EgressVerdict::SameEgress,
                    bound: Some(bound_addr),
                    probed: Some(probed),
                    candidate: Some(*candidate),
                };
            }
            EgressVerdict::RoutedElsewhere => {
                // Remember the first, keep looking for a path that works.
                mismatch.get_or_insert(EgressReport {
                    verdict: EgressVerdict::RoutedElsewhere,
                    bound: Some(bound_addr),
                    probed: Some(probed),
                    candidate: Some(*candidate),
                });
            }
            EgressVerdict::Inconclusive => {}
        }
    }

    mismatch.unwrap_or_else(EgressReport::inconclusive)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn ip(s: &str) -> IpAddr {
        s.parse().expect("test address parses")
    }

    fn sock(s: &str) -> SocketAddr {
        s.parse().expect("test socket address parses")
    }

    // -- compare: the verdict rules -----------------------------------------

    #[test]
    fn the_same_address_on_both_sides_is_not_a_mismatch() {
        assert_eq!(
            compare(ip("192.168.1.5"), ip("192.168.1.5")),
            EgressVerdict::SameEgress
        );
        assert_eq!(
            compare(ip("fd00::5"), ip("fd00::5")),
            EgressVerdict::SameEgress
        );
    }

    /// The recorded #4299 failure, as numbers: the endpoint bound the LAN address
    /// and the system would have sourced this peer's traffic from the tunnel's
    /// CGNAT address instead.
    #[test]
    fn a_source_address_from_another_subnet_is_a_mismatch_4299() {
        assert_eq!(
            compare(ip("192.160.160.80"), ip("100.64.0.1")),
            EgressVerdict::RoutedElsewhere,
            "the tunnel's source address against the LAN bind is the whole signal"
        );
    }

    /// Address equality, not subnet containment — two addresses on the same /24
    /// still mean the route selected a source our socket is not pinned to.
    #[test]
    fn a_different_address_inside_the_same_subnet_is_still_a_mismatch() {
        assert_eq!(
            compare(ip("192.168.1.5"), ip("192.168.1.9")),
            EgressVerdict::RoutedElsewhere
        );
    }

    #[test]
    fn a_loopback_or_wildcard_bind_is_inconclusive_never_a_mismatch() {
        for bound in ["127.0.0.1", "0.0.0.0", "::1", "::"] {
            assert_eq!(
                compare(ip(bound), ip("192.168.1.9")),
                EgressVerdict::Inconclusive,
                "a bind of {bound} names no interface to disagree with"
            );
            assert_eq!(
                compare(ip(bound), ip("fd00::9")),
                EgressVerdict::Inconclusive,
                "a bind of {bound} names no interface to disagree with"
            );
        }
    }

    #[test]
    fn a_loopback_or_wildcard_probe_result_is_inconclusive() {
        for probed in ["127.0.0.1", "0.0.0.0", "::1", "::"] {
            assert_eq!(
                compare(ip("192.168.1.5"), ip(probed)),
                EgressVerdict::Inconclusive
            );
            assert_eq!(
                compare(ip("fd00::5"), ip(probed)),
                EgressVerdict::Inconclusive
            );
        }
    }

    #[test]
    fn v4_against_v6_is_never_compared() {
        assert_eq!(
            compare(ip("192.168.1.5"), ip("fd00::1")),
            EgressVerdict::Inconclusive
        );
        assert_eq!(
            compare(ip("fd00::1"), ip("192.168.1.5")),
            EgressVerdict::Inconclusive
        );
    }

    // -- probe_with: the aggregation policy ---------------------------------
    //
    // Every case below supplies its own route table, so none of these depend on
    // the machine's real network — they pass identically in CI and on a laptop
    // behind whatever the laptop is behind.

    /// A route table as a lookup: destination → source address the "system"
    /// would pick. Anything absent is a route that does not resolve.
    fn routes(pairs: &[(&str, &str)]) -> impl Fn(SocketAddr) -> Option<IpAddr> + use<> {
        let table: HashMap<SocketAddr, IpAddr> = pairs
            .iter()
            .map(|(dest, src)| (sock(dest), ip(src)))
            .collect();
        move |dest| table.get(&dest).copied()
    }

    #[test]
    fn a_tunnel_that_swallows_the_lan_is_reported_4299() {
        let report = probe_with(
            &[sock("192.160.160.42:41234")],
            &[sock("192.160.160.80:9999")],
            routes(&[("192.160.160.80:9999", "100.64.0.1")]),
        );
        assert_eq!(report.verdict, EgressVerdict::RoutedElsewhere);
        assert_eq!(report.bound, Some(ip("192.160.160.42")));
        assert_eq!(report.probed, Some(ip("100.64.0.1")));
        assert_eq!(report.candidate, Some(sock("192.160.160.80:9999")));
    }

    #[test]
    fn a_healthy_lan_route_reports_same_egress() {
        let report = probe_with(
            &[sock("192.168.1.5:41234")],
            &[sock("192.168.1.9:9999")],
            routes(&[("192.168.1.9:9999", "192.168.1.5")]),
        );
        assert_eq!(report.verdict, EgressVerdict::SameEgress);
    }

    /// The multi-homed peer: one advertised address is captured, another is not.
    /// A path exists, so the peer is not a routing story.
    #[test]
    fn one_reachable_candidate_outranks_every_captured_one() {
        let bound = [sock("192.168.1.5:41234")];
        let candidates = [sock("10.9.9.9:9999"), sock("192.168.1.9:9999")];
        let table = routes(&[
            ("10.9.9.9:9999", "100.64.0.1"),
            ("192.168.1.9:9999", "192.168.1.5"),
        ]);
        assert_eq!(
            probe_with(&bound, &candidates, &table).verdict,
            EgressVerdict::SameEgress
        );
        // …and the ordering of the candidate list must not change the answer.
        let reversed = [candidates[1], candidates[0]];
        assert_eq!(
            probe_with(&bound, &reversed, &table).verdict,
            EgressVerdict::SameEgress
        );
    }

    #[test]
    fn a_candidate_with_no_bound_socket_of_its_family_is_skipped() {
        // v4-only bind, v6-only candidate: nothing to compare, and the v6
        // candidate must not be measured against the v4 bind.
        let report = probe_with(
            &[sock("192.168.1.5:41234")],
            &[sock("[fd00::9]:9999")],
            routes(&[("[fd00::9]:9999", "fd00::5")]),
        );
        assert_eq!(report.verdict, EgressVerdict::Inconclusive);
        assert_eq!(report.candidate, None);
    }

    #[test]
    fn each_family_is_compared_against_its_own_bind() {
        let bound = [sock("192.168.1.5:41234"), sock("[fd00::5]:41234")];
        let report = probe_with(
            &bound,
            &[sock("[fd00::9]:9999")],
            routes(&[("[fd00::9]:9999", "fd00::abcd")]),
        );
        assert_eq!(report.verdict, EgressVerdict::RoutedElsewhere);
        assert_eq!(report.bound, Some(ip("fd00::5")));
    }

    #[test]
    fn a_route_that_does_not_resolve_is_inconclusive() {
        let report = probe_with(
            &[sock("192.168.1.5:41234")],
            &[sock("192.168.1.9:9999")],
            routes(&[]),
        );
        assert_eq!(report.verdict, EgressVerdict::Inconclusive);
    }

    #[test]
    fn no_bound_sockets_or_no_candidates_is_inconclusive() {
        let table = routes(&[("192.168.1.9:9999", "100.64.0.1")]);
        assert_eq!(
            probe_with(&[], &[sock("192.168.1.9:9999")], &table).verdict,
            EgressVerdict::Inconclusive
        );
        assert_eq!(
            probe_with(&[sock("192.168.1.5:41234")], &[], &table).verdict,
            EgressVerdict::Inconclusive
        );
    }

    /// A loopback-bound endpoint is what every test harness in this tree builds.
    /// It must never produce a diagnosis, whatever the route table says.
    #[test]
    fn a_loopback_bound_endpoint_never_diagnoses() {
        let report = probe_with(
            &[sock("127.0.0.1:41234")],
            &[sock("192.168.1.9:9999")],
            routes(&[("192.168.1.9:9999", "100.64.0.1")]),
        );
        assert_eq!(report.verdict, EgressVerdict::Inconclusive);
    }

    // -- the real syscalls --------------------------------------------------

    /// The two syscalls must work and must not panic. Deliberately asserts
    /// nothing about *which* address comes back: that is the machine's topology,
    /// and a test that depended on it would fail on somebody's laptop.
    #[test]
    fn the_real_probe_answers_without_panicking() {
        // Loopback is the one destination whose route exists on every machine
        // this could run on, CI included.
        let source = system_source_address_for(sock("127.0.0.1:9"));
        assert!(
            source.is_none_or(|ip| ip.is_ipv4()),
            "a v4 destination cannot select a v6 source"
        );

        // A destination with no route at all must answer `None`, not panic.
        let _ = system_source_address_for(sock("[::1]:9"));

        // And the whole path, against a loopback bind, must stay silent.
        assert_eq!(
            probe_peer_egress(&[sock("127.0.0.1:41234")], &[sock("127.0.0.1:9")]).verdict,
            EgressVerdict::Inconclusive,
            "a loopback bind is inconclusive by rule, whatever the host's routes are"
        );
    }
}
