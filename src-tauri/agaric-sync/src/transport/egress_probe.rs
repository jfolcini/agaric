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
//! is why [`probe_peer_egress_with`] is a plain synchronous fn callable from an
//! async context.
//!
//! Comparing that selection against the *prefix* the sync endpoint actually bound
//! answers a question no timeout can: *would our packets to this peer even leave
//! by the link we are speaking from?* A source address outside that prefix means
//! they would not — they are going somewhere else and dying there.
//!
//! The comparison is against the prefix and not against the bound address itself,
//! which is the difference between a diagnosis and a libel. A host with WiFi and a
//! `br0` bridge both on the LAN routinely selects the bridge's `prefsrc` for a peer
//! our WiFi-bound socket reaches perfectly well; address equality called that a
//! capture and told the user a VPN was eating their LAN when nothing was. See
//! [`compare`].
//!
//! # Why this and not a VPN interrogation
//!
//! Asking the platform whether a VPN is up is more precise and costs four
//! implementations, a JNI hop on Android, and permission-gated surfaces. A route
//! comparison is one implementation across Linux, Android, macOS and Windows, and
//! it catches the whole class rather than one vendor: split-tunnel VPNs, corporate
//! clients, a second link on a different subnet, a mis-scoped default route. (A
//! second link on the *same* subnet is not in that class and is not reported — see
//! [`compare`].) It also catches the case the original bug turned on, which a "is
//! this RFC1918?" heuristic would have missed entirely — a route comparison does
//! not care what the numbers look like.
//!
//! # What a verdict claims
//!
//! [`EgressVerdict::RoutedElsewhere`] claims exactly one thing: the system would
//! send traffic for this peer out of a source address that is not on the link this
//! device bound. It does **not** claim a VPN — that is a hypothesis for the log
//! line and a hedged "may" in the user-facing text, not a finding. Every failure,
//! every ambiguity and every comparison between unlike things answers
//! [`EgressVerdict::Inconclusive`], because the cost of a wrong "your network is
//! broken" is a user chasing a network that is fine.
//!
//! # The probe must NOT inherit production's bind
//!
//! Production's socket is bound to a specific *source address* — the one
//! `sync_daemon::lan_interface::decide` chose, which iroh then binds. **This probe
//! deliberately binds nothing**: it takes the wildcard address and lets the system
//! choose, because the *system's default routing decision* is precisely the thing
//! being measured, and the difference between that decision and our pinned bind IS
//! the signal. A probe that inherited the production bind would read back the
//! address it was given and agree with itself every time.
//!
//! On Android there is nothing further to inherit and that is worth stating,
//! because it also bounds what a `SameEgress` proves there. Agaric does **not**
//! pin its socket to a `Network` — no `android_setsocknetwork`, no
//! `bindProcessToNetwork` anywhere in this tree — because it cannot: the platform
//! rule `13000: from all fwmark 0x0/0x20000 … lookup <vpn table>` sends every
//! socket lacking `protectedFromVpn` into the tunnel, and only the VPN app or a
//! network-privileged uid may set that bit (session-1388, which also records that
//! binding the *source address* was not enough to escape: `ping -I <lan-src>` lost
//! 100 % where `ping -I wlan0` did not). So a capture whose route table happens to
//! hand back an address on our own LAN prefix as the source would read as
//! `SameEgress` here. The recorded case does not — `ip route get` named
//! `src 100.64.0.1` under the app's uid — but `SameEgress` is "this module has
//! nothing to add", never "the path is good".
//!
//! See [`system_source_address_for`].

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket};

/// What the egress probe concluded about one peer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EgressVerdict {
    /// The system would source traffic for this peer from **our own link** — the
    /// address the sync endpoint bound, or another address inside that bind's
    /// prefix. Routing agrees with our bind; the dial failure has some other
    /// cause (a sleeping peer, a firewall on the far end) and this module has
    /// nothing to add.
    SameEgress,
    /// The system would source traffic for this peer from an address **outside**
    /// the prefix the sync endpoint bound — our packets would leave this host by
    /// another link than the one we are speaking from.
    RoutedElsewhere,
    /// No usable comparison. A socket that would not open, a route that does not
    /// resolve, a bind address that names no interface (loopback, wildcard), two
    /// addresses from different families, or a bind whose prefix nobody supplied.
    /// Never a diagnosis.
    Inconclusive,
}

/// One socket the sync endpoint bound, with the prefix that bind is confined to.
///
/// The prefix is the whole reason this is a struct rather than the bare
/// [`SocketAddr`] `iroh::Endpoint::bound_sockets` hands back. The verdict is about
/// *links*, not addresses (see [`compare`]), and the only thing that says where our
/// link ends is the netmask the bind policy already read off the chosen interface:
/// `sync_daemon::lan_interface::BindDecision::prefix_len`, the same number that
/// becomes `BindOpts::set_prefix_len` on the production endpoint. Nothing here
/// re-derives it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BoundSocket {
    /// The address and port the endpoint bound.
    pub addr: SocketAddr,
    /// The prefix length that bind is confined to, verbatim from the bind policy.
    ///
    /// `None` means *nobody said where this link ends* — not `/32`, not a guess.
    /// [`compare`] answers [`EgressVerdict::Inconclusive`] for it, because "the
    /// kernel picked a different address" is only evidence of a capture once you
    /// know whether that address is on our own link.
    ///
    /// It is `None` for any IPv6 bound socket today: `BindDecision` ranks and binds
    /// IPv4 only, so there is no v6 prefix in existence to carry. Production has no
    /// v6 socket to ask about either — `transport::endpoint::lan_only` calls
    /// `clear_ip_transports()` before adding its single IPv4 bind, so
    /// `bound_sockets()` returns exactly that one — but the field admits a v6
    /// prefix and [`compare`] applies it identically at 128 bits, so a future v6
    /// bind policy needs no change here.
    pub prefix_len: Option<u8>,
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
    /// The prefix that bound address is confined to — the number the verdict turned
    /// on, and useless to omit: `bound` and `probed` alone do not say where the link
    /// the two were judged against ends (#4299 review).
    pub bound_prefix_len: Option<u8>,
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
            bound_prefix_len: None,
            probed: None,
            candidate: None,
        }
    }
}

/// Would the system send this peer's traffic off the link we bound?
///
/// Pure, total, and the only place the verdict rules live — the syscalls in
/// [`system_source_address_for`] exist to feed this and nothing else, which is
/// what lets the rules be tested without a network.
///
/// # Prefixes, not addresses (#4299 review)
///
/// The comparison is *prefix containment*, and an earlier revision that compared
/// addresses for equality was wrong in the one direction this module cannot afford.
/// Consider an ordinary host with WiFi and a `br0`/`virbr0` bridge, both numbered on
/// the LAN. `lan_interface::decide` demotes the bridge as `Virtual` and binds the
/// WiFi address; the kernel's lowest-metric route for the peer's prefix may be the
/// bridge, carrying its own `prefsrc`. Our bound socket still reaches that peer over
/// our own link perfectly well — the dial timed out because the peer is **asleep** —
/// yet address equality reported `RoutedElsewhere` and told the user a VPN might be
/// eating their LAN. A false positive here is worse than the generic timeout it
/// replaces, because it is confidently wrong.
///
/// The signal actually wanted is "the system would send this peer's traffic off our
/// link entirely", so the question asked is whether the source the kernel selected
/// falls inside the prefix our bind is confined to. Inside it, the peer is still
/// reachable from where we are speaking and there is nothing to report; outside it,
/// the packets leave by another interface, which is the tunnel case and the whole
/// point of the module.
///
/// The docked-laptop case (Ethernet and WiFi, default route on Ethernet) used to
/// escape only because `decide`'s route tiebreak happens to pick the default-route
/// holder — a real mitigation, but an incidental one that says nothing about a
/// bridge, a second NIC on the same subnet, or a tiebreak that changes. This rule
/// covers all of them.
///
/// # The rules, and why each answers the way it does
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
/// * **Equal** → `SameEgress`. The one arm that needs no prefix: an address is
///   inside its own link whatever the netmask turns out to be.
/// * **Inside `bound_prefix_len`** → `SameEgress`. The benign multi-homing above.
/// * **Outside `bound_prefix_len`** → `RoutedElsewhere`. Earned.
/// * **No usable prefix** — `None`, or a length that is not legal for the family,
///   or `/0` — → `Inconclusive`. Never a guess: see [`shares_prefix`].
#[must_use]
pub fn compare(bound: IpAddr, bound_prefix_len: Option<u8>, probed: IpAddr) -> EgressVerdict {
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
        _ => match shares_prefix(bound, probed, bound_prefix_len) {
            Some(true) => EgressVerdict::SameEgress,
            Some(false) => EgressVerdict::RoutedElsewhere,
            None => EgressVerdict::Inconclusive,
        },
    }
}

/// Do `bound` and `probed` sit inside the same `/prefix_len` block?
///
/// The same operation at two widths: mask both addresses down to the prefix and
/// compare what is left, over `u32` for IPv4 and `u128` for IPv6. IPv6 is not a
/// special case and does not get a second rule — it gets 128 bits instead of 32.
///
/// `None` — never a `false` — whenever the question cannot be asked at all: no
/// prefix was supplied, the two addresses are from different families, or the length
/// is not one that family admits (`> 32`, `> 128`). `false` is what becomes a
/// diagnosis shown to a user, so it is never produced from a number this function
/// does not understand.
///
/// `/0` is refused with the rest. It is not a link but "everywhere", and
/// `lan_interface::LanInterface::netmask` records that `0` is also what `if-addrs`
/// substitutes on POSIX for a netmask it could not read — a NULL `ifa_netmask` — so
/// the value is genuinely ambiguous rather than merely broad. No production bind
/// carries it in any case: `lan_interface::rejection` refuses anything below
/// `endpoint::MIN_IPV4_PREFIX_LEN` before a decision is made.
fn shares_prefix(bound: IpAddr, probed: IpAddr, prefix_len: Option<u8>) -> Option<bool> {
    let prefix_len = prefix_len.filter(|len| *len > 0)?;
    match (bound, probed) {
        (IpAddr::V4(bound), IpAddr::V4(probed)) => {
            if prefix_len > 32 {
                return None;
            }
            let mask = u32::MAX << (32 - prefix_len);
            Some(u32::from(bound) & mask == u32::from(probed) & mask)
        }
        (IpAddr::V6(bound), IpAddr::V6(probed)) => {
            if prefix_len > 128 {
                return None;
            }
            let mask = u128::MAX << (128 - prefix_len);
            Some(u128::from(bound) & mask == u128::from(probed) & mask)
        }
        // Unreachable through `compare`, which rejects mixed families first, and
        // still not a `false`: two families are not a subnet disagreement.
        (IpAddr::V4(_), IpAddr::V6(_)) | (IpAddr::V6(_), IpAddr::V4(_)) => None,
    }
}

/// Ask the system which source address it would use to reach `dest`, without
/// sending anything.
///
/// Returns `None` — never a panic and never a guess — if the socket will not
/// open, the route does not resolve, or the local address cannot be read. Every
/// one of those is an `Inconclusive` upstream.
///
/// # The wildcard bind is load-bearing
///
/// The socket is bound to the *wildcard* address of the destination's family and
/// to **no** particular interface or network. That is not laziness: production
/// binds the source address `lan_interface::decide` selected, and if this probe
/// inherited that bind it would simply read back the address it was given and
/// report agreement with itself forever. The measurement wanted here is the
/// *system's own* default routing decision for this destination, which is only
/// observable from an unbound socket. The gap between that decision and our
/// pinned bind is the entire signal.
///
/// This is the same two-syscall lookup as
/// `sync_daemon::lan_interface::route_source_ipv4`, generalised to both families
/// and to a caller-supplied destination; that one aims at TEST-NET-1 to find the
/// default route's source address, this one aims at a peer.
pub(crate) fn system_source_address_for(dest: SocketAddr) -> Option<IpAddr> {
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

/// The probe: does the system route any of this peer's candidate addresses off the
/// link we bound?
///
/// `bound` is the endpoint's own bound sockets, each carrying the prefix its bind is
/// confined to (see [`BoundSocket`]); `candidates` are the peer's advertised
/// addresses. `source_for` is the route lookup — production passes
/// [`system_source_address_for`] (the two syscalls this module exists to make),
/// tests pass a route table they wrote.
///
/// That seam is not a convenience. The aggregation here is policy — which candidate
/// wins, which verdict outranks which, which bind a candidate is judged against —
/// and policy that can only be exercised against the machine it happens to be
/// running on is policy no test can pin. With the seam, neither the rules nor the
/// ordering depend on CI's network topology; the seam is threaded one level further
/// up, through `sync_daemon::session_supervisor::diagnose_dial_timeout_with`, for
/// exactly the same reason (#4299 review).
///
/// # Why one `SameEgress` outranks every mismatch
///
/// A peer on a multi-homed LAN advertises several addresses and only some of them
/// are ours to reach. If *any* candidate routes out of the link we bound, then a
/// path to this peer exists from where we are speaking and a dial failure is not a
/// routing story — so the whole peer answers `SameEgress` and this module stays
/// quiet. `RoutedElsewhere` requires that no candidate agreed and at least one
/// disagreed: every path we could take to this peer leaves this host by somewhere
/// else.
///
/// That ordering is the conservative one on purpose. The cheap error here is
/// staying silent about a captured LAN, which leaves the user exactly where they
/// were before this module existed. The expensive error is telling a user with a
/// perfectly good network that it is broken.
///
/// # Every same-family bind, not the first one (#4299 review)
///
/// A candidate is compared against **all** the bound sockets of its own family, and
/// a source address inside *any* of their prefixes is a `SameEgress`. The rule is
/// the peer-level one above, applied to binds instead of candidates:
/// `RoutedElsewhere` means *every* path we could take leaves this host by somewhere
/// else, and a bind whose own prefix contains the selected source is a path. An
/// earlier revision took only the first same-family bind, which — given a second
/// socket on the subnet the system actually chose — reported a capture while a
/// perfectly good local path existed, the one direction this module cannot afford
/// (see [`compare`]).
///
/// Production has a single IPv4 bind today (`transport::endpoint::lan_only` calls
/// `clear_ip_transports()` before adding it), so the two rules cannot disagree
/// there. The parameter is a slice, though, and a slice that quietly ignored all but
/// its first same-family element would be a trap for the bind policy that widens it.
#[must_use]
pub(crate) fn probe_peer_egress_with<F>(
    bound: &[BoundSocket],
    candidates: &[SocketAddr],
    source_for: F,
) -> EgressReport
where
    F: Fn(SocketAddr) -> Option<IpAddr>,
{
    let mut mismatch: Option<EgressReport> = None;

    for candidate in candidates {
        // Like with like: a v6 candidate is only ever compared against v6 binds —
        // and against *that* bind's own prefix, never a prefix borrowed from the
        // other family's socket.
        let same_family = || {
            bound
                .iter()
                .filter(move |b| b.addr.is_ipv4() == candidate.is_ipv4())
        };
        // Nothing of this family to compare against: don't pay for the lookup.
        if same_family().next().is_none() {
            continue;
        }
        let Some(probed) = source_for(*candidate) else {
            continue;
        };
        for bound_socket in same_family() {
            let bound_addr = bound_socket.addr.ip();
            match compare(bound_addr, bound_socket.prefix_len, probed) {
                EgressVerdict::SameEgress => {
                    // One good path is enough; stop and say so.
                    return EgressReport {
                        verdict: EgressVerdict::SameEgress,
                        bound: Some(bound_addr),
                        bound_prefix_len: bound_socket.prefix_len,
                        probed: Some(probed),
                        candidate: Some(*candidate),
                    };
                }
                EgressVerdict::RoutedElsewhere => {
                    // Remember the first, keep looking for a path that works.
                    mismatch.get_or_insert(EgressReport {
                        verdict: EgressVerdict::RoutedElsewhere,
                        bound: Some(bound_addr),
                        bound_prefix_len: bound_socket.prefix_len,
                        probed: Some(probed),
                        candidate: Some(*candidate),
                    });
                }
                EgressVerdict::Inconclusive => {}
            }
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

    /// A bound socket with the prefix its bind is confined to — what
    /// `session_supervisor` builds out of `Endpoint::bound_sockets` and
    /// `BindDecision::prefix_len`.
    fn bound_sock(s: &str, prefix_len: u8) -> BoundSocket {
        BoundSocket {
            addr: sock(s),
            prefix_len: Some(prefix_len),
        }
    }

    /// A bound socket nobody supplied a prefix for — `Inconclusive` by rule.
    fn bound_sock_unknown(s: &str) -> BoundSocket {
        BoundSocket {
            addr: sock(s),
            prefix_len: None,
        }
    }

    // -- compare: the verdict rules -----------------------------------------

    /// The trivial agreement, asserted with **no** prefix on purpose: an address is
    /// inside its own link whatever the netmask turns out to be, so this is the one
    /// arm that must keep answering when the prefix is unknown.
    #[test]
    fn the_same_address_on_both_sides_is_not_a_mismatch() {
        assert_eq!(
            compare(ip("192.168.1.5"), None, ip("192.168.1.5")),
            EgressVerdict::SameEgress
        );
        assert_eq!(
            compare(ip("fd00::5"), None, ip("fd00::5")),
            EgressVerdict::SameEgress
        );
        // …and with one, unchanged.
        assert_eq!(
            compare(ip("192.168.1.5"), Some(24), ip("192.168.1.5")),
            EgressVerdict::SameEgress
        );
        assert_eq!(
            compare(ip("fd00::5"), Some(64), ip("fd00::5")),
            EgressVerdict::SameEgress
        );
    }

    /// The recorded #4299 failure, as numbers: the endpoint bound the LAN address
    /// and the system would have sourced this peer's traffic from the tunnel's
    /// CGNAT address instead.
    #[test]
    fn a_source_address_from_another_subnet_is_a_mismatch_4299() {
        assert_eq!(
            compare(ip("192.160.160.80"), Some(24), ip("100.64.0.1")),
            EgressVerdict::RoutedElsewhere,
            "the tunnel's source address against the LAN prefix is the whole signal"
        );
    }

    /// Benign multi-homing is **not** a capture (#4299 review).
    ///
    /// The exact false positive this rule exists to prevent, as numbers: a host with
    /// WiFi on `192.168.1.5` and a `br0` bridge on `192.168.1.9`, both on the LAN.
    /// `lan_interface::decide` demotes the bridge and binds the WiFi address; the
    /// kernel's lowest-metric route for the peer's prefix is the bridge, so the
    /// probe reads back `192.168.1.9`. Our socket still reaches that peer over our
    /// own link — the dial timed out because the peer is asleep — and telling this
    /// user a VPN may be eating their LAN would be worse than the bare timeout it
    /// replaces, because it is confidently wrong.
    ///
    /// This test asserted the opposite until the review of #4299, under the name
    /// `a_different_address_inside_the_same_subnet_is_still_a_mismatch`.
    #[test]
    fn an_address_inside_the_bound_prefix_is_not_a_mismatch_4299() {
        assert_eq!(
            compare(ip("192.168.1.5"), Some(24), ip("192.168.1.9")),
            EgressVerdict::SameEgress,
            "a second address on our own /24 still reaches the peer over our own link"
        );
        // The same operation at 128 bits: `decide` binds IPv4 only today, so no
        // production v6 socket carries a prefix — but the rule is one rule, and a v6
        // bind policy must not arrive to find a v4-shaped special case waiting.
        assert_eq!(
            compare(ip("fd00::5"), Some(64), ip("fd00::9")),
            EgressVerdict::SameEgress,
            "…and the same at /64, where the rule is the same operation on 128 bits"
        );
        // The prefix is honoured as given, not rounded to a familiar byte boundary:
        // 10.1.0.5 and 10.1.1.9 share a /16 and not the /24 above it.
        assert_eq!(
            compare(ip("10.1.0.5"), Some(16), ip("10.1.1.9")),
            EgressVerdict::SameEgress
        );
    }

    /// The mirror of the pair: outside the bound prefix is the tunnel case, and the
    /// widened rule must not have widened into silence.
    ///
    /// Written alongside its `SameEgress` twin deliberately — a rule pinned on one
    /// arm only is how "never diagnose" and "always diagnose" both pass.
    #[test]
    fn an_address_outside_the_bound_prefix_is_a_mismatch_4299() {
        assert_eq!(
            compare(ip("192.168.1.5"), Some(24), ip("100.64.0.1")),
            EgressVerdict::RoutedElsewhere,
            "a CGNAT source against a /24 LAN bind leaves our link entirely"
        );
        assert_eq!(
            compare(ip("fd00::5"), Some(64), ip("fd00:1::9")),
            EgressVerdict::RoutedElsewhere,
            "…and at 128 bits, where fd00:1::/64 is not fd00::/64"
        );
        // One bit outside is still outside: 192.168.2.9 misses the /24 by the third
        // octet, which is the smallest miss the mask can express.
        assert_eq!(
            compare(ip("192.168.1.5"), Some(24), ip("192.168.2.9")),
            EgressVerdict::RoutedElsewhere
        );
        // …and the identical pair of addresses is `SameEgress` on a prefix broad
        // enough to hold both — `192.168.0.0/22` spans `.0` through `.3` — which is
        // what proves the mask is applied rather than the octets eyeballed. (A `/23`
        // is not broad enough: it stops at `192.168.1.255`.)
        assert_eq!(
            compare(ip("192.168.1.5"), Some(22), ip("192.168.2.9")),
            EgressVerdict::SameEgress
        );
    }

    /// No prefix is `Inconclusive` — never a guess in either direction (#4299
    /// review).
    ///
    /// `None` is "nobody said where this link ends", and the two addresses below are
    /// exactly the pair a `/24` would call same-link and a `/32` would call a
    /// capture. Defaulting either way would be inventing the answer.
    #[test]
    fn a_bind_with_no_prefix_can_never_be_a_mismatch() {
        assert_eq!(
            compare(ip("192.168.1.5"), None, ip("192.168.1.9")),
            EgressVerdict::Inconclusive
        );
        assert_eq!(
            compare(ip("192.168.1.5"), None, ip("100.64.0.1")),
            EgressVerdict::Inconclusive,
            "not even the tunnel case: without a prefix there is no link to be off"
        );
        assert_eq!(
            compare(ip("fd00::5"), None, ip("fd00:1::9")),
            EgressVerdict::Inconclusive
        );
    }

    /// A prefix length that names no subnet is the same as no prefix at all.
    ///
    /// `/0` is "everywhere" rather than a link, and `if-addrs` also substitutes `0`
    /// on POSIX for a netmask it could not read; anything past the family's width is
    /// a number this module does not understand. Neither may become a diagnosis, and
    /// neither may become a silent `SameEgress` either.
    #[test]
    fn a_prefix_length_that_names_no_subnet_is_inconclusive() {
        for prefix_len in [0u8, 33, 255] {
            assert_eq!(
                compare(ip("192.168.1.5"), Some(prefix_len), ip("100.64.0.1")),
                EgressVerdict::Inconclusive,
                "/{prefix_len} describes no IPv4 subnet"
            );
        }
        for prefix_len in [0u8, 129, 255] {
            assert_eq!(
                compare(ip("fd00::5"), Some(prefix_len), ip("fd00:1::9")),
                EgressVerdict::Inconclusive,
                "/{prefix_len} describes no IPv6 subnet"
            );
        }
        // /32 and /128 are the *legal* extremes and stay usable: a host route is a
        // link of exactly one address, and everything else is off it.
        assert_eq!(
            compare(ip("192.168.1.5"), Some(32), ip("192.168.1.9")),
            EgressVerdict::RoutedElsewhere
        );
        assert_eq!(
            compare(ip("fd00::5"), Some(128), ip("fd00::9")),
            EgressVerdict::RoutedElsewhere
        );
    }

    /// Asserted **with** a usable prefix, so the loopback/wildcard rule is what
    /// produces the `Inconclusive` rather than a missing prefix doing it for free.
    #[test]
    fn a_loopback_or_wildcard_bind_is_inconclusive_never_a_mismatch() {
        for bound in ["127.0.0.1", "0.0.0.0", "::1", "::"] {
            assert_eq!(
                compare(ip(bound), Some(24), ip("192.168.1.9")),
                EgressVerdict::Inconclusive,
                "a bind of {bound} names no interface to disagree with"
            );
            assert_eq!(
                compare(ip(bound), Some(64), ip("fd00::9")),
                EgressVerdict::Inconclusive,
                "a bind of {bound} names no interface to disagree with"
            );
        }
    }

    #[test]
    fn a_loopback_or_wildcard_probe_result_is_inconclusive() {
        for probed in ["127.0.0.1", "0.0.0.0", "::1", "::"] {
            assert_eq!(
                compare(ip("192.168.1.5"), Some(24), ip(probed)),
                EgressVerdict::Inconclusive
            );
            assert_eq!(
                compare(ip("fd00::5"), Some(64), ip(probed)),
                EgressVerdict::Inconclusive
            );
        }
    }

    /// Two families are never compared — and a prefix length legal in both (`24` is
    /// a valid v4 and v6 prefix) must not make the mixed pair look answerable.
    #[test]
    fn v4_against_v6_is_never_compared() {
        assert_eq!(
            compare(ip("192.168.1.5"), Some(24), ip("fd00::1")),
            EgressVerdict::Inconclusive
        );
        assert_eq!(
            compare(ip("fd00::1"), Some(24), ip("192.168.1.5")),
            EgressVerdict::Inconclusive
        );
    }

    // -- probe_peer_egress_with: the aggregation policy ---------------------
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
        let report = probe_peer_egress_with(
            &[bound_sock("192.160.160.42:41234", 24)],
            &[sock("192.160.160.80:9999")],
            routes(&[("192.160.160.80:9999", "100.64.0.1")]),
        );
        assert_eq!(report.verdict, EgressVerdict::RoutedElsewhere);
        assert_eq!(report.bound, Some(ip("192.160.160.42")));
        assert_eq!(
            report.bound_prefix_len,
            Some(24),
            "the log line must carry the prefix the verdict turned on, or a bug \
             report shows two addresses and no way to tell why they disagreed"
        );
        assert_eq!(report.probed, Some(ip("100.64.0.1")));
        assert_eq!(report.candidate, Some(sock("192.160.160.80:9999")));
    }

    #[test]
    fn a_healthy_lan_route_reports_same_egress() {
        let report = probe_peer_egress_with(
            &[bound_sock("192.168.1.5:41234", 24)],
            &[sock("192.168.1.9:9999")],
            routes(&[("192.168.1.9:9999", "192.168.1.5")]),
        );
        assert_eq!(report.verdict, EgressVerdict::SameEgress);
    }

    /// The multi-homed peer: one advertised address is captured, another is not.
    /// A path exists, so the peer is not a routing story.
    #[test]
    fn one_reachable_candidate_outranks_every_captured_one() {
        let bound = [bound_sock("192.168.1.5:41234", 24)];
        let candidates = [sock("10.9.9.9:9999"), sock("192.168.1.9:9999")];
        let table = routes(&[
            ("10.9.9.9:9999", "100.64.0.1"),
            ("192.168.1.9:9999", "192.168.1.5"),
        ]);
        assert_eq!(
            probe_peer_egress_with(&bound, &candidates, &table).verdict,
            EgressVerdict::SameEgress
        );
        // …and the ordering of the candidate list must not change the answer.
        let reversed = [candidates[1], candidates[0]];
        assert_eq!(
            probe_peer_egress_with(&bound, &reversed, &table).verdict,
            EgressVerdict::SameEgress
        );
    }

    /// The whole probe against the benign multi-homing case, not just [`compare`]
    /// (#4299 review).
    ///
    /// WiFi bound at `192.168.1.5/24`, a `br0` bridge at `192.168.1.9` holding the
    /// lower-metric route, and a peer that is simply asleep. The probe must add
    /// nothing here — the aggregation in [`probe_peer_egress_with`] is where a
    /// `RoutedElsewhere` would actually reach a user, and pinning the rule only at
    /// `compare` would leave that route untested.
    #[test]
    fn a_bridge_on_our_own_lan_is_not_reported_as_a_capture_4299() {
        let report = probe_peer_egress_with(
            &[bound_sock("192.168.1.5:41234", 24)],
            &[sock("192.168.1.80:9999")],
            routes(&[("192.168.1.80:9999", "192.168.1.9")]),
        );
        assert_eq!(
            report.verdict,
            EgressVerdict::SameEgress,
            "the bridge's prefsrc is on our own /24; this peer is asleep, not captured"
        );
    }

    /// A bound socket nobody supplied a prefix for can never produce a diagnosis —
    /// the same route table that reads as a capture with a prefix stays silent
    /// without one.
    ///
    /// The pair is the point: the two calls differ only in whether the prefix is
    /// there, so a `None` quietly defaulting to `/32` would redden the first
    /// assertion instead of hiding behind the second's agreement.
    #[test]
    fn a_bound_socket_without_a_prefix_never_diagnoses() {
        let candidates = [sock("192.160.160.80:9999")];
        let table = routes(&[("192.160.160.80:9999", "100.64.0.1")]);
        assert_eq!(
            probe_peer_egress_with(
                &[bound_sock_unknown("192.160.160.42:41234")],
                &candidates,
                &table
            )
            .verdict,
            EgressVerdict::Inconclusive,
            "without a prefix there is no link for the tunnel's source to be off"
        );
        assert_eq!(
            probe_peer_egress_with(
                &[bound_sock("192.160.160.42:41234", 24)],
                &candidates,
                &table
            )
            .verdict,
            EgressVerdict::RoutedElsewhere,
            "…and the identical route table with a prefix is the recorded capture"
        );
    }

    #[test]
    fn a_candidate_with_no_bound_socket_of_its_family_is_skipped() {
        // v4-only bind, v6-only candidate: nothing to compare, and the v6
        // candidate must not be measured against the v4 bind.
        let report = probe_peer_egress_with(
            &[bound_sock("192.168.1.5:41234", 24)],
            &[sock("[fd00::9]:9999")],
            routes(&[("[fd00::9]:9999", "fd00::5")]),
        );
        assert_eq!(report.verdict, EgressVerdict::Inconclusive);
        assert_eq!(report.candidate, None);

        // …and the mirror, so the rule is pinned in both directions rather than
        // on the one arm that happened to be written first.
        let mirrored = probe_peer_egress_with(
            &[bound_sock("[fd00::5]:41234", 64)],
            &[sock("192.168.1.9:9999")],
            routes(&[("192.168.1.9:9999", "100.64.0.1")]),
        );
        assert_eq!(mirrored.verdict, EgressVerdict::Inconclusive);
        assert_eq!(mirrored.candidate, None);
    }

    #[test]
    fn each_family_is_compared_against_its_own_bind() {
        let bound = [
            bound_sock("192.168.1.5:41234", 24),
            bound_sock("[fd00::5]:41234", 64),
        ];
        let report = probe_peer_egress_with(
            &bound,
            &[sock("[fd00::9]:9999")],
            routes(&[("[fd00::9]:9999", "fd00:abcd::1")]),
        );
        assert_eq!(report.verdict, EgressVerdict::RoutedElsewhere);
        assert_eq!(report.bound, Some(ip("fd00::5")));
    }

    /// A candidate inside the *second* same-family bind's prefix is not routed
    /// elsewhere (#4299 review).
    ///
    /// The first bind is on a different subnet from the one the system chose, so a
    /// probe that consulted only the first same-family bind would report a capture
    /// while a local path plainly exists — the confidently-wrong direction
    /// [`compare`] exists to avoid. `bound` is a slice; every element of the
    /// candidate's family gets asked.
    #[test]
    fn a_candidate_inside_a_later_binds_prefix_is_not_a_mismatch_4299() {
        let bound = [
            bound_sock("192.168.1.5:41234", 24),
            bound_sock("10.0.0.5:41234", 24),
        ];
        let report = probe_peer_egress_with(
            &bound,
            &[sock("10.0.0.9:9999")],
            routes(&[("10.0.0.9:9999", "10.0.0.5")]),
        );
        assert_eq!(
            report.verdict,
            EgressVerdict::SameEgress,
            "the source the system chose is inside the second bind's own /24; that \
             bind is a path to this peer and a path is not a capture"
        );
        assert_eq!(
            report.bound,
            Some(ip("10.0.0.5")),
            "…and the report must name the bind that actually agreed, not the one \
             that happened to be listed first"
        );
        assert_eq!(report.bound_prefix_len, Some(24));
    }

    /// The mirror: when *no* same-family bind contains the selected source, the
    /// mismatch stands — checking every bind must not have widened into silence.
    #[test]
    fn a_candidate_outside_every_binds_prefix_is_still_a_mismatch_4299() {
        let report = probe_peer_egress_with(
            &[
                bound_sock("192.168.1.5:41234", 24),
                bound_sock("10.0.0.5:41234", 24),
            ],
            &[sock("10.0.0.9:9999")],
            routes(&[("10.0.0.9:9999", "100.64.0.1")]),
        );
        assert_eq!(report.verdict, EgressVerdict::RoutedElsewhere);
        assert_eq!(
            report.bound,
            Some(ip("192.168.1.5")),
            "the first disagreeing bind is the one the log line reports"
        );
    }

    #[test]
    fn a_route_that_does_not_resolve_is_inconclusive() {
        let report = probe_peer_egress_with(
            &[bound_sock("192.168.1.5:41234", 24)],
            &[sock("192.168.1.9:9999")],
            routes(&[]),
        );
        assert_eq!(report.verdict, EgressVerdict::Inconclusive);
    }

    #[test]
    fn no_bound_sockets_or_no_candidates_is_inconclusive() {
        let table = routes(&[("192.168.1.9:9999", "100.64.0.1")]);
        assert_eq!(
            probe_peer_egress_with(&[], &[sock("192.168.1.9:9999")], &table).verdict,
            EgressVerdict::Inconclusive
        );
        assert_eq!(
            probe_peer_egress_with(&[bound_sock("192.168.1.5:41234", 24)], &[], &table).verdict,
            EgressVerdict::Inconclusive
        );
    }

    /// A loopback-bound endpoint is what every test harness in this tree builds.
    /// It must never produce a diagnosis, whatever the route table says.
    #[test]
    fn a_loopback_bound_endpoint_never_diagnoses() {
        let report = probe_peer_egress_with(
            &[bound_sock("127.0.0.1:41234", 8)],
            &[sock("192.168.1.9:9999")],
            routes(&[("192.168.1.9:9999", "100.64.0.1")]),
        );
        assert_eq!(report.verdict, EgressVerdict::Inconclusive);
    }

    // -- the real syscalls --------------------------------------------------

    /// The two syscalls must work, must not panic, and must actually select a
    /// source *on the route to the destination* — which is the whole premise of
    /// the module and the one thing the injected-table tests above cannot check.
    ///
    /// Loopback is the only destination whose route is the same on every machine
    /// this could run on, so it is the only one asserted against; nothing here
    /// depends on the host's LAN, its interfaces or its default route.
    #[test]
    fn the_real_probe_answers_without_panicking() {
        // `127.0.0.0/8` is on `lo` with a loopback prefsrc everywhere this runs,
        // so `connect()` must select a loopback source. Asserting only
        // `is_ipv4()` would be a tautology: the socket was bound v4, so
        // `local_addr()` cannot answer anything else.
        assert!(
            system_source_address_for(sock("127.0.0.1:9")).is_some_and(|ip| ip.is_loopback()),
            "connect(2) to loopback must select the loopback route's own source"
        );

        // The v6 half, where a host with IPv6 disabled legitimately answers
        // `None` — which must be a `None`, not a panic.
        assert!(
            system_source_address_for(sock("[::1]:9")).is_none_or(|ip| ip.is_loopback()),
            "either there is no v6 loopback route, or its source is ::1"
        );

        // And the whole path, against a loopback bind, must stay silent.
        assert_eq!(
            probe_peer_egress_with(
                &[bound_sock("127.0.0.1:41234", 8)],
                &[sock("127.0.0.1:9")],
                system_source_address_for
            )
            .verdict,
            EgressVerdict::Inconclusive,
            "a loopback bind is inconclusive by rule, whatever the host's routes are"
        );
    }
}
