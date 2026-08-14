//! The LAN-only iroh endpoint, and the guard that keeps it LAN-only.
//!
//! The configuration below was derived by reading iroh 1.0.3's source and then
//! verified by forcing each assertion red. It began life in a throwaway spike crate
//! whose guard was *not* build-enforced, because nothing in CI compiled it; the
//! findings behind it are recorded on #78 and in plan #3464. Living here, inside a
//! workspace member, the guard runs under `cargo nextest run --workspace` — which is
//! the whole point of moving it.

use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::{Arc, Mutex},
};

use iroh::{
    Endpoint, RelayMode,
    endpoint::{BindOpts, Builder, InvalidSocketAddr, presets},
};
use iroh_dns::dns::{BoxIter, DnsError, DnsResolver, Resolver, TxtRecordData};
use n0_error::e;
use n0_future::boxed::BoxFuture;

/// A [`Resolver`] that answers nothing and records every question it was asked.
///
/// Every route by which iroh could reach n0's infrastructure — pkarr publish, pkarr
/// resolve, DNS address lookup, relay URL resolution — begins with a name lookup.
/// Injecting this via [`Builder::dns_resolver`] therefore means an endpoint cannot
/// reach n0 without leaving a record here, whatever a future iroh version adds.
///
/// It refuses every query rather than forwarding: a guard that let the lookup succeed
/// would be permitting the leak it claims to observe.
///
/// This is test apparatus today, but it is deliberately **not** `#[cfg(test)]`: the
/// same recorder wired into a production endpoint is a runtime tripwire, and a later
/// slice may do exactly that once there is somewhere to report to. Compare
/// [`permissive`], which is test-only precisely because shipping an internet-facing
/// configuration would be a liability rather than an asset.
///
/// # Bounded, because the production use is the point
///
/// Inviting production wiring and then growing a `Vec` forever would be an invitation to
/// a leak. Measured against `presets::N0` (a fully leaking endpoint) on this machine:
/// **~220 queries in the first 5 s, ~630 by 55 s, and only 5 distinct hostnames** — the
/// volume is retries of the same few names, and it does not stop. So the record is
/// capped at [`MAX_RECORDED_QUERIES`] and overflow is *counted*, not silently dropped
/// ([`dropped_queries`](Self::dropped_queries)).
///
/// Capping cannot hide a leak from the guards. The buffer starts empty and the first
/// queries recorded are the first queries made, so a configuration that leaks at all
/// leaks into slot zero; the guards assert on emptiness and on content, never on a
/// suffix. What the cap costs is fidelity about *how often* a known leak repeated, which
/// is exactly the information worth trading for a fixed memory bound — the measurement
/// above shows all 5 distinct names appear inside the first 5 s.
#[derive(Debug, Clone, Default)]
pub struct RecordingResolver {
    state: Arc<Mutex<Recorded>>,
}

/// The bounded record behind a [`RecordingResolver`].
#[derive(Debug, Default)]
struct Recorded {
    queries: Vec<String>,
    dropped: usize,
}

/// How many hostnames a [`RecordingResolver`] retains before it stops recording and
/// starts counting.
///
/// Sized from the measurement in [`RecordingResolver`]'s docs: ~4× the observed
/// 220-query startup burst of a fully leaking endpoint, and roughly 90 s of its observed
/// sustained rate. That is comfortably more than enough to show the complete distinct
/// set (5 names, all within the first 5 s) plus enough repetition to judge frequency,
/// while bounding the buffer at ~1024 short strings instead of ~950k per day.
pub const MAX_RECORDED_QUERIES: usize = 1024;

impl RecordingResolver {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Every hostname iroh attempted to resolve, in order, up to
    /// [`MAX_RECORDED_QUERIES`].
    #[must_use]
    pub fn queries(&self) -> Vec<String> {
        self.lock().queries.clone()
    }

    /// How many queries were observed but not retained because the record was full.
    ///
    /// Non-zero means [`queries`](Self::queries) is a prefix, not the whole story — it
    /// never means nothing leaked.
    #[must_use]
    pub fn dropped_queries(&self) -> usize {
        self.lock().dropped
    }

    /// Take the lock, recovering from poisoning rather than panicking.
    ///
    /// A tripwire that aborts the process when an unrelated thread panicked would be a
    /// worse failure than the one it watches for, and the guarded data is an append-only
    /// log of strings — there is no invariant a panic mid-`push` can break.
    fn lock(&self) -> std::sync::MutexGuard<'_, Recorded> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn record(&self, host: &str) {
        let mut state = self.lock();
        if state.queries.len() < MAX_RECORDED_QUERIES {
            state.queries.push(host.to_string());
        } else {
            state.dropped += 1;
        }
    }
}

impl Resolver for RecordingResolver {
    fn lookup_ipv4(&self, host: String) -> BoxFuture<Result<BoxIter<Ipv4Addr>, DnsError>> {
        self.record(&host);
        Box::pin(async move { Err(e!(DnsError::NoResponse)) })
    }

    fn lookup_ipv6(&self, host: String) -> BoxFuture<Result<BoxIter<Ipv6Addr>, DnsError>> {
        self.record(&host);
        Box::pin(async move { Err(e!(DnsError::NoResponse)) })
    }

    fn lookup_txt(&self, host: String) -> BoxFuture<Result<BoxIter<TxtRecordData>, DnsError>> {
        self.record(&host);
        Box::pin(async move { Err(e!(DnsError::NoResponse)) })
    }

    fn clear_cache(&self) {}

    fn reset(&self) -> Box<dyn Resolver> {
        // Share the recording buffer across resets, so a network-change-triggered
        // rebuild cannot launder a query out of the record.
        Box::new(self.clone())
    }
}

/// Build a LAN-only iroh endpoint: no relays, no address-lookup services, and egress
/// confined to `bind`'s subnet.
///
/// # The three layers, and why each is load-bearing
///
/// 1. **No relay transport.** `clear_relay_transports()` removes the transport
///    outright, which is strictly stronger than `RelayMode::Disabled` — that only
///    empties the relay map while the transport remains constructed.
/// 2. **No address-lookup services.** Built from [`presets::Minimal`], which sets only
///    the mandatory crypto provider. Building from `N0` or `N0DisableRelay` instead
///    would install `PkarrPublisher::n0_dns()`, `PkarrResolver::n0_dns()` and
///    `DnsAddressLookup::n0_dns()`, and **disabling the relay does not disable those**.
///    That is the trap this whole module exists to avoid. `clear_address_lookup()` is
///    then called anyway, belt-and-braces: `Minimal` installs none today, but it is a
///    preset we do not control, and the cost of the call is one line against a silent
///    reacquisition of an outbound path.
/// 3. **Egress confined to the subnet.** iroh routes outgoing datagrams by
///    longest-prefix match over bound sockets, falling back to whichever socket is
///    marked the default route. Binding only the LAN subnet with
///    `is_default_route(false)` leaves an off-subnet destination matching no socket at
///    all.
///
/// # `clear_ip_transports()` is load-bearing and no test will tell you so
///
/// The builder installs default wildcard (`0.0.0.0/0`) IP transports, which are
/// default-route sockets by definition. Leaving them in place hands every off-subnet
/// destination a socket to leave by and collapses layer 3 — **while every guard in
/// this module stays green**, because the guards observe name resolution and that leak
/// needs none. Do not drop the call as redundant.
///
/// # What the guard cannot see
///
/// The guard observes DNS, which covers every route to n0 that iroh uses today, since
/// relay selection and pkarr both start from a hostname. It would not catch a future
/// iroh dialling a hardcoded bootstrap IP. Layer 3 is the backstop for that case,
/// which is the second reason `clear_ip_transports()` matters.
///
/// # Errors
/// [`LanBindError::PrefixTooBroad`] if `prefix_len` describes a block too large to be a
/// LAN (see [`MIN_IPV4_PREFIX_LEN`] / [`MIN_IPV6_PREFIX_LEN`]);
/// [`LanBindError::BindAddressNotPrivate`] if `bind` sits in publicly-routable space and
/// is not an address this host has actually been assigned — the prefix bounds the
/// block's *breadth*, this bounds *where* it sits, and both are needed before the doc's
/// "confined to a LAN" reading is true;
/// [`LanBindError::InvalidSocketAddr`] if `bind` is not a valid socket address for the
/// given `prefix_len` (for IPv4 the maximum prefix is 32, for IPv6 128).
pub fn lan_only(
    bind: SocketAddr,
    prefix_len: u8,
    resolver: DnsResolver,
) -> Result<Builder, LanBindError> {
    lan_only_with_host_addrs(bind, prefix_len, resolver, &host_ip_addrs())
}

/// [`lan_only`], with the host's own addresses passed in rather than enumerated.
///
/// The seam exists so a test can drive the **composed** gate — prefix breadth *and*
/// locality, in the order and with the errors `lan_only` produces — against a synthetic
/// address list. Testing [`bind_locality_ok`] alone is not the same thing: the rule can be
/// correct and still not be applied here, and reverting the call below to a bare
/// `is_publicly_routable` check reddens `lan_only_binds_a_public_address_the_host_holds`.
///
/// What it does **not** cover, and what no test taking the list as a parameter can: that
/// [`lan_only`] passes [`host_ip_addrs`] rather than something else. Replacing that
/// argument with `&[]` leaves every test in this file green except
/// `lan_only_gates_on_the_addresses_this_host_actually_holds`, which is the one test that
/// drives the public entry point against the machine's own addresses.
///
/// Not `pub`: callers get [`lan_only`], which reads the real host. Only the tests in this
/// module supply the list.
///
/// # Errors
/// As [`lan_only`].
fn lan_only_with_host_addrs(
    bind: SocketAddr,
    prefix_len: u8,
    resolver: DnsResolver,
    host_addrs: &[IpAddr],
) -> Result<Builder, LanBindError> {
    // Layer 3 confines egress by longest-prefix match over the bound sockets. A prefix
    // that covers more than a LAN does not confine anything — at /0 every destination on
    // the internet matches this socket, so the third layer silently becomes a no-op
    // while all four guards below stay green, because a route out needs no name
    // resolution. Reject it here, where the caller can still be told why.
    let minimum = match bind {
        SocketAddr::V4(_) => MIN_IPV4_PREFIX_LEN,
        SocketAddr::V6(_) => MIN_IPV6_PREFIX_LEN,
    };
    if prefix_len < minimum {
        return Err(LanBindError::PrefixTooBroad {
            prefix_len,
            minimum,
            family: if bind.is_ipv4() { "IPv4" } else { "IPv6" },
        });
    }
    // The prefix bounds how *broad* the confined block is; it says nothing about
    // *where* it sits. `lan_only("8.8.8.8:0", 8, ..)` satisfies the check above and
    // installs a route for `8.0.0.0/8` — public space, confined to a LAN-sized slice
    // of it. `MIN_IPV4_PREFIX_LEN` reasons from RFC 1918 and loopback, so without this
    // second check the doc promises a guarantee the code does not deliver.
    //
    // #3853: the locality test is "is this one of *our* addresses", not "is this in RFC
    // 1918". Those are not the same question and the difference is not academic — the
    // reporting LAN is `192.160.160.0/24`, real public space, and it is that user's home
    // network. Rejecting it made the endpoint unbindable there, which is the same outage
    // by a different route. What must stay impossible is claiming a block we do not
    // hold, and `is_locally_assigned` is a stronger answer to that than `is_private`:
    // `8.8.8.8` is not on anyone's interface, so it is still refused here rather than at
    // `EADDRNOTAVAIL` with no explanation.
    if !bind_locality_ok(bind, host_addrs) {
        return Err(LanBindError::BindAddressNotPrivate { bind });
    }
    Endpoint::builder(presets::Minimal)
        .relay_mode(RelayMode::Disabled)
        .clear_relay_transports()
        .clear_address_lookup()
        .clear_ip_transports()
        .dns_resolver(resolver)
        .bind_addr_with_opts(
            bind,
            BindOpts::default()
                .set_prefix_len(prefix_len)
                .set_is_default_route(false),
        )
        .map_err(LanBindError::InvalidSocketAddr)
}

/// May [`lan_only`] bind `bind`, given the addresses this host holds?
///
/// The whole locality rule in one pure function, so it can be exercised against a
/// synthetic address list. A rule that can only be tested against the interfaces of
/// whichever machine ran the suite is a rule with no test, which is how #3853 shipped.
#[must_use]
fn bind_locality_ok(bind: SocketAddr, host_addrs: &[IpAddr]) -> bool {
    !is_publicly_routable(&bind) || is_locally_assigned(bind.ip(), host_addrs)
}

/// Is `ip` one of the addresses this host has assigned to an interface?
///
/// Pure over `host_addrs` so the rule is testable without depending on whatever
/// addresses the test machine happens to hold. The impure half is [`host_ip_addrs`],
/// which is one `getifaddrs(3)` call.
///
/// Why this is the right locality test — and why it is *stronger* than `is_private`: an
/// address only appears here because the operating system assigned it to a link this
/// machine is on. You cannot squat `8.8.8.8` that way, and if the OS did hand you a
/// globally-routable address then the netmask it came with describes your actual subnet.
/// `is_private` answers a question about IANA registries; this answers the question
/// `lan_only` is actually asking.
#[must_use]
fn is_locally_assigned(ip: IpAddr, host_addrs: &[IpAddr]) -> bool {
    let normalise = |addr: IpAddr| match addr {
        // Same unmapping `is_publicly_routable` performs, for the same reason: an
        // IPv4-mapped bind address must compare equal to the v4 address it names.
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(IpAddr::V6(v6), IpAddr::V4),
        v4 => v4,
    };
    let target = normalise(ip);
    host_addrs.iter().any(|addr| normalise(*addr) == target)
}

/// Every IP address currently assigned to an interface on this host.
///
/// A failure to enumerate returns an empty list, which makes [`is_locally_assigned`]
/// answer `false` — i.e. the guard falls closed, refusing a publicly-routable bind it
/// cannot vouch for, rather than open.
fn host_ip_addrs() -> Vec<IpAddr> {
    if_addrs::get_if_addrs().map_or_else(
        |e| {
            tracing::warn!(
                error = %e,
                "if_addrs::get_if_addrs failed; a publicly-routable bind address cannot \
                 be vouched for and will be refused"
            );
            Vec::new()
        },
        |ifaces| ifaces.iter().map(if_addrs::Interface::ip).collect(),
    )
}

/// The smallest IPv4 prefix length [`lan_only`] will accept.
///
/// **Why 8.** `10.0.0.0/8` (RFC 1918) and `127.0.0.0/8` (loopback) are the largest
/// blocks an interface can legitimately sit in and still be describing a local network;
/// every other private range (`172.16/12`, `192.168/16`, CGNAT `100.64/10`) is narrower.
/// So /8 is the broadest prefix that still names a subnet rather than a slice of the
/// internet, and it is also what the guard tests below bind. Anything broader is
/// accepting a claim the address space cannot support.
pub const MIN_IPV4_PREFIX_LEN: u8 = 8;

/// The smallest IPv6 prefix length [`lan_only`] will accept.
///
/// **Why 7.** `fc00::/7` (unique-local, RFC 4193) is the largest block an IPv6 LAN can
/// legitimately occupy; link-local `fe80::/10` is narrower. Same reasoning as
/// [`MIN_IPV4_PREFIX_LEN`], applied to the v6 address plan.
pub const MIN_IPV6_PREFIX_LEN: u8 = 7;

/// Why a [`lan_only`] endpoint could not be configured.
///
/// Hand-written rather than derived: `agaric-sync` does not depend on `thiserror` (it
/// moved to `agaric-core` with `error.rs` in #2621), and pulling a dependency in for one
/// two-variant enum is disproportionate. The variants stay distinct rather than
/// collapsing into `AppError::InvalidOperation` because "the prefix cannot confine
/// egress" is a security condition a caller may want to match on, not just log.
#[derive(Debug)]
pub enum LanBindError {
    /// `prefix_len` describes a block too broad to confine egress to a LAN, so the
    /// third layer of [`lan_only`]'s configuration would not hold.
    PrefixTooBroad {
        /// What the caller asked for.
        prefix_len: u8,
        /// The smallest value accepted for this address family.
        minimum: u8,
        /// `"IPv4"` or `"IPv6"`, for the message.
        family: &'static str,
    },
    /// `bind` is a publicly-routable address that is **not assigned to any interface on
    /// this host**. The prefix check bounds how broad the confined block is, not where it
    /// sits, so a LAN-sized slice of public space would otherwise pass.
    ///
    /// A globally-routable address the OS *did* assign is accepted: it names a link this
    /// machine is on, which is what "LAN" means here. See [`lan_only`] (#3853).
    BindAddressNotPrivate {
        /// The address the caller asked to bind.
        bind: SocketAddr,
    },
    /// iroh rejected the address / prefix pair — e.g. a prefix above the family maximum
    /// (32 for IPv4, 128 for IPv6).
    InvalidSocketAddr(InvalidSocketAddr),
}

impl std::fmt::Display for LanBindError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PrefixTooBroad {
                prefix_len,
                minimum,
                family,
            } => write!(
                f,
                "prefix /{prefix_len} is too broad to confine egress to a LAN \
                 (minimum /{minimum} for {family}); a subnet this large leaves every \
                 off-subnet destination a route out, which no guard in this module can see"
            ),
            Self::BindAddressNotPrivate { bind } => write!(
                f,
                "bind address {bind} is publicly routable and is not assigned to any \
                 interface on this host; the prefix check bounds how broad the confined \
                 block is, not where it sits, so a LAN-sized slice of public space would \
                 otherwise be accepted as LAN-only"
            ),
            // Deliberately does NOT interpolate the inner error: `source()` returns it,
            // so a chain-walking reporter (`{:#}`, `tracing`'s error chain) would print
            // it twice. `Display` carries only the context this wrapper adds.
            Self::InvalidSocketAddr(_) => write!(f, "invalid bind address for prefix"),
        }
    }
}

impl std::error::Error for LanBindError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            // The inner error is in the `Display` string, but a caller walking the chain
            // (or a `tracing` field) would otherwise find nothing behind it.
            Self::InvalidSocketAddr(e) => Some(e),
            Self::PrefixTooBroad { .. } | Self::BindAddressNotPrivate { .. } => None,
        }
    }
}

impl From<InvalidSocketAddr> for LanBindError {
    fn from(e: InvalidSocketAddr) -> Self {
        Self::InvalidSocketAddr(e)
    }
}

/// The permissive, internet-facing configuration.
///
/// Its only purpose is to be the negative control in the guard tests below: an
/// assertion that "the LAN-only endpoint does not phone home" is worth nothing unless
/// some configuration makes it fail, and this is that configuration.
///
/// `#[cfg(test)]` deliberately: the guards live in this module's own `tests`, so the
/// control needs no wider visibility, and the internet-facing configuration then does
/// not exist in the shipped binary at all.
#[cfg(test)]
fn permissive(resolver: DnsResolver) -> Builder {
    Endpoint::builder(presets::N0DisableRelay).dns_resolver(resolver)
}

/// Is this address reachable from the public internet?
///
/// Used to classify what an endpoint publishes. Deliberately conservative: anything
/// not recognised as private, loopback, link-local, unique-local or CGNAT is treated
/// as public, so an unfamiliar range fails toward "flag it" rather than "allow it".
///
/// # IPv4-mapped IPv6
///
/// `::ffff:192.168.1.10` is an IPv4 address wearing an IPv6 hat, and classifying it on
/// `segments()[0]` (which is `0x0000`) fell through to "publicly routable" for every
/// private address in that form. It is unmapped and classified as the v4 address it is.
///
/// Note this uses `to_ipv4_mapped`, **not** `to_ipv4`. The latter also converts the
/// deprecated IPv4-compatible form, which would turn `::1` into `0.0.0.1` — an address
/// none of the v4 predicates recognise, so genuine loopback would come back "public".
#[must_use]
pub fn is_publicly_routable(addr: &SocketAddr) -> bool {
    let ip = match addr.ip() {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(IpAddr::V6(v6), IpAddr::V4),
        v4 => v4,
    };
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                // 100.64.0.0/10 CGNAT — not `is_private()`, but not internet-routable
                // either, and it is what CGNAT'd mobile networks hand out.
                || (o[0] == 100 && (64..128).contains(&o[1])))
        }
        IpAddr::V6(v6) => {
            !(v6.is_loopback()
                || v6.is_unspecified()
                // fe80::/10 link-local and fc00::/7 unique-local
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                || (v6.segments()[0] & 0xfe00) == 0xfc00)
        }
    }
}

#[cfg(test)]
mod tests {
    //! The offline guard.
    //!
    //! # Every guard is paired with a control, because the first draft was not
    //!
    //! In the spike this file started with four assertions that all passed
    //! immediately, two of which could not have failed:
    //!
    //! - Asserting `addr.relay_urls()` was empty held for the full `presets::N0`
    //!   configuration too, because no relay resolves while DNS is refused. The
    //!   assertion was true for a reason unrelated to the LAN-only config.
    //! - Asserting no public address was published held because no developer machine
    //!   or CI runner *has* a public address to publish. It would hold identically on
    //!   a fully internet-facing endpoint.
    //!
    //! Both were rewritten onto the resolver record, and each is now paired with a
    //! control asserting the opposite. A green control proves the observation path
    //! can see the forbidden behaviour; if it goes red while the guard stays green,
    //! the guard result cannot be trusted.
    //!
    //! # These tests do not touch the network
    //!
    //! The recording resolver refuses every query, so no name resolves and no packet
    //! is ever addressed to an n0 host. The controls observe the *attempt*. Safe in
    //! CI, and safe on a machine whose owner did not agree to talk to n0.

    use std::{net::SocketAddrV4, time::Duration};

    use super::*;

    fn lan_bind() -> SocketAddr {
        SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
    }
    const LAN_PREFIX: u8 = 8;

    /// How long a guard waits before concluding "nothing was resolved". Proving
    /// absence means giving the endpoint time to act, so this one must be a fixed wait.
    const SETTLE: Duration = Duration::from_secs(3);

    /// How long a *control* waits for the leak it expects. Controls poll rather than
    /// sleep, so a loaded machine reports slowly instead of reporting "NEGATIVE
    /// CONTROL FAILED" — that message must always mean "the guard can no longer fire",
    /// never "this box was busy".
    const CONTROL_DEADLINE: Duration = Duration::from_secs(15);

    async fn queries_for(builder: Builder, recorder: RecordingResolver) -> Vec<String> {
        let endpoint = builder.bind().await.expect("endpoint binds");
        tokio::time::sleep(SETTLE).await;
        let queries = recorder.queries();
        endpoint.close().await;
        queries
    }

    async fn queries_until(
        builder: Builder,
        recorder: RecordingResolver,
        want: impl Fn(&[String]) -> bool,
    ) -> Vec<String> {
        let endpoint = builder.bind().await.expect("endpoint binds");
        let deadline = tokio::time::Instant::now() + CONTROL_DEADLINE;
        let queries = loop {
            let queries = recorder.queries();
            if want(&queries) || tokio::time::Instant::now() >= deadline {
                break queries;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        };
        endpoint.close().await;
        queries
    }

    fn lan_builder(recorder: &RecordingResolver) -> Builder {
        lan_only(
            lan_bind(),
            LAN_PREFIX,
            DnsResolver::custom(recorder.clone()),
        )
        .expect("loopback /8 is a valid LAN bind")
    }

    const IROH_DNS_DOMAIN: &str = "iroh.link";

    fn is_domain_or_subdomain(query: &str, domain: &str) -> bool {
        let query = query.trim_end_matches('.');
        query == domain
            || query
                .strip_suffix(domain)
                .is_some_and(|prefix| prefix.ends_with('.'))
    }

    fn domain_queries<'a>(queries: &'a [String], domain: &str) -> Vec<&'a String> {
        queries
            .iter()
            .filter(|query| is_domain_or_subdomain(query, domain))
            .collect()
    }

    fn relay_queries(queries: &[String]) -> Vec<&String> {
        queries
            .iter()
            .filter(|query| {
                query
                    .trim_end_matches('.')
                    .split('.')
                    .any(|label| label == "relay")
            })
            .collect()
    }

    // -- Guard 1: the endpoint resolves no hostnames at all ------------------

    #[tokio::test]
    async fn lan_only_endpoint_resolves_no_hostnames() {
        // Keep the permissive endpoint in this same test outcome: an empty LAN record
        // is only evidence if the control proves hostname lookups are observable in
        // this child process first. nextest gives this exact test a scoped NO_PROXY /
        // no_proxy wildcard bypass so an ambient proxy cannot turn any hostname into
        // an IP-literal request that never reaches the recorder.
        let control_recorder = RecordingResolver::new();
        let control_queries = queries_until(
            permissive(DnsResolver::custom(control_recorder.clone())),
            control_recorder,
            |queries| !domain_queries(queries, IROH_DNS_DOMAIN).is_empty(),
        )
        .await;

        let control_dns_queries = domain_queries(&control_queries, IROH_DNS_DOMAIN);
        assert!(
            !control_dns_queries.is_empty(),
            "NEGATIVE CONTROL FAILED: presets::N0DisableRelay made no query to an n0 \
             host, so the LAN-only result below is not observable and must not pass. \
             A proxy can cause this by routing reqwest to an IP literal; verify that \
             nextest's exact-test setup supplied wildcard NO_PROXY and no_proxy. \
             Otherwise, iroh may have stopped using the n0 DNS services or \
             RecordingResolver may no longer be wired into the resolution path. \
             Saw: {control_queries:?}"
        );

        // Use a different recorder so the control's expected leak cannot contaminate
        // the guard. Run the guard only after the control has proved observability.
        let lan_recorder = RecordingResolver::new();
        let lan_queries = queries_for(lan_builder(&lan_recorder), lan_recorder).await;

        assert!(
            lan_queries.is_empty(),
            "LAN-only endpoint attempted {} DNS lookup(s), so something is reaching \
             for a name off this machine: {lan_queries:?}",
            lan_queries.len()
        );
    }

    // -- Guard 2: no relay is ever even looked for ---------------------------
    //
    // Asserting `relay_urls()` is empty does NOT work — it is empty under the full N0
    // preset too, since no relay can be established while DNS is refused. The
    // observable difference is that a relay-enabled endpoint *queries relay hostnames*.

    #[tokio::test]
    async fn lan_only_endpoint_never_looks_for_a_relay() {
        // Keep this control in the same outcome as its guard. The exact-test nextest
        // setup also bypasses ambient proxies for every hostname. iroh 1.0.3's relay
        // path currently calls this resolver directly even behind a proxy; keeping the
        // bypass scoped here prevents a future proxyable relay path from weakening the
        // control silently. Either way, an empty control is a hard failure rather than
        // permission for the guard to pass.
        let control_recorder = RecordingResolver::new();
        let control_queries = queries_until(
            Endpoint::builder(presets::N0)
                .dns_resolver(DnsResolver::custom(control_recorder.clone())),
            control_recorder,
            |queries| !relay_queries(queries).is_empty(),
        )
        .await;

        let control_relays = relay_queries(&control_queries);
        assert!(
            !control_relays.is_empty(),
            "NEGATIVE CONTROL FAILED: presets::N0 (relays enabled) made no relay \
             hostname query, so the LAN-only relay result below is not observable and \
             must not pass. Verify that nextest's exact-test setup supplied wildcard \
             NO_PROXY and no_proxy: the current relay path is proxy-independent, but a \
             future proxyable path could otherwise route to an IP literal. Otherwise, \
             iroh may have stopped using DNS for relays or RecordingResolver may no \
             longer be wired into the relay resolution path. Saw: {control_queries:?}"
        );

        // A separate recorder keeps the expected control leak out of the guard record.
        let lan_recorder = RecordingResolver::new();
        let lan_queries = queries_for(lan_builder(&lan_recorder), lan_recorder).await;

        let relays = relay_queries(&lan_queries);
        assert!(
            relays.is_empty(),
            "LAN-only endpoint looked up {} relay hostname(s): {relays:?}",
            relays.len()
        );
    }

    // -- Guard 3: the address classifier -------------------------------------
    //
    // The integration form ("the endpoint publishes no public address") cannot fail on
    // a NAT'd host, which is every dev machine and every CI runner. It is kept below
    // as defence-in-depth with that limit stated; the falsifiable part is the
    // classifier, unit-tested against addresses whose class is not in doubt.

    #[test]
    fn classifier_recognises_public_addresses() {
        for addr in [
            "8.8.8.8:443",
            "1.1.1.1:443",
            "93.184.216.34:80",
            "[2606:4700:4700::1111]:443",
        ] {
            let sa: SocketAddr = addr.parse().expect("test address parses");
            assert!(
                is_publicly_routable(&sa),
                "{addr} must be classified publicly routable"
            );
        }
    }

    #[test]
    fn classifier_recognises_non_public_addresses() {
        for addr in [
            "127.0.0.1:1",
            "10.0.6.1:1",
            "192.168.68.110:1",
            "172.16.0.1:1",
            "169.254.1.1:1",
            "100.64.0.1:1", // CGNAT — not is_private(), still not internet-routable
            "[::1]:1",
            "[fe80::1]:1",
            "[fc00::1]:1",
            // IPv4-mapped IPv6 (`::ffff:a.b.c.d`). Before the unmapping in
            // `is_publicly_routable` these fell through on `segments()[0] == 0` and came
            // back "publicly routable" — a private LAN address classified as internet.
            "[::ffff:192.168.1.10]:1",
            "[::ffff:10.0.6.1]:1",
            "[::ffff:127.0.0.1]:1",
            "[::ffff:169.254.1.1]:1",
            "[::ffff:100.64.0.1]:1",
        ] {
            let sa: SocketAddr = addr.parse().expect("test address parses");
            assert!(
                !is_publicly_routable(&sa),
                "{addr} must NOT be classified publicly routable"
            );
        }
    }

    /// Unmapping must not swallow the public case: `::ffff:8.8.8.8` is still the public
    /// internet, and a fix that classified every mapped address as private would be
    /// worse than the bug it replaced.
    #[test]
    fn classifier_recognises_public_ipv4_mapped_addresses() {
        for addr in ["[::ffff:8.8.8.8]:443", "[::ffff:93.184.216.34]:80"] {
            let sa: SocketAddr = addr.parse().expect("test address parses");
            assert!(
                is_publicly_routable(&sa),
                "{addr} is a public IPv4 address in v6 clothing and must be flagged"
            );
        }
    }

    /// `to_ipv4_mapped`, not `to_ipv4`: the deprecated IPv4-*compatible* form would turn
    /// `::1` into `0.0.0.1`, which no v4 predicate recognises, so loopback would be
    /// reported as publicly routable. `[::1]:1` is already in the non-public list above;
    /// this pins the reason, so a future "simplification" to `to_ipv4` fails here with
    /// an explanation rather than there with a puzzle.
    #[test]
    fn classifier_does_not_unmap_the_ipv4_compatible_form() {
        let sa: SocketAddr = "[::1]:1".parse().expect("test address parses");
        assert!(
            !is_publicly_routable(&sa),
            "::1 is loopback; unmapping it as IPv4-compatible would yield 0.0.0.1 and \
             classify loopback as public"
        );
    }

    // -- Guard 5: the prefix length must be able to confine egress -------------
    //
    // Layer 3 of `lan_only` confines egress by longest-prefix match. A /0 subnet matches
    // every destination on the internet, so the layer collapses — and none of guards 1-4
    // can see it, because a route out needs no name resolution. That is the same blind
    // spot the module docs call out for dropping `clear_ip_transports()`.

    #[test]
    fn lan_only_rejects_a_prefix_that_cannot_confine_egress() {
        for prefix_len in 0..MIN_IPV4_PREFIX_LEN {
            let err = lan_only(
                lan_bind(),
                prefix_len,
                DnsResolver::custom(RecordingResolver::new()),
            )
            .expect_err("a prefix broader than a LAN must be rejected");
            assert!(
                matches!(err, LanBindError::PrefixTooBroad { .. }),
                "/{prefix_len} must be rejected as too broad, got {err:?}"
            );
        }
    }

    #[test]
    fn lan_only_rejects_a_broad_ipv6_prefix() {
        let bind = SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), 0);
        let err = lan_only(bind, 0, DnsResolver::custom(RecordingResolver::new()))
            .expect_err("an IPv6 /0 must be rejected");
        assert!(
            matches!(
                err,
                LanBindError::PrefixTooBroad {
                    minimum: MIN_IPV6_PREFIX_LEN,
                    ..
                }
            ),
            "IPv6 must be bounded by its own minimum, got {err:?}"
        );
    }

    /// The prefix guard bounds how *broad* the confined block is; it says nothing about
    /// *where* it sits. `8.8.8.8/8` is a LAN-sized slice of public space and satisfies
    /// every prefix check, so without a locality check the rustdoc — which reasons from
    /// RFC 1918 and loopback — would promise more than the code delivers.
    ///
    /// Deliberately uses public addresses whose class is not in doubt, and a prefix
    /// (`/8`, `/24`) that the breadth check *accepts*, so a failure here can only mean
    /// the locality check is gone.
    #[test]
    fn lan_only_rejects_a_publicly_routable_bind_address() {
        for addr in ["8.8.8.8:0", "1.1.1.1:0", "93.184.216.34:0"] {
            let bind: SocketAddr = addr.parse().expect("test address parses");
            let err = lan_only(bind, 24, DnsResolver::custom(RecordingResolver::new()))
                .expect_err("a publicly-routable bind must be rejected");
            assert!(
                matches!(err, LanBindError::BindAddressNotPrivate { .. }),
                "{addr} is public and must be rejected as such, got {err:?}"
            );
        }
        // IPv6 too, and at a prefix the breadth check accepts.
        let bind: SocketAddr = "[2606:4700:4700::1111]:0".parse().expect("parses");
        let err = lan_only(bind, 64, DnsResolver::custom(RecordingResolver::new()))
            .expect_err("a publicly-routable IPv6 bind must be rejected");
        assert!(matches!(err, LanBindError::BindAddressNotPrivate { .. }));
    }

    /// #3853: the locality test is "is it ours", not "is it RFC 1918".
    ///
    /// `192.160.160.0/24` looks private and is not. It is the reporting user's home LAN,
    /// and gating on `is_private` made their endpoint unbindable — the same outage, one
    /// layer down. What must stay refused is a public address we were never assigned.
    ///
    /// Pure over an explicit address list, deliberately: reading the host's real
    /// interfaces would make this assertion depend on the machine it runs on, which is
    /// the property that let #3853 ship with no failing test.
    #[test]
    fn a_locally_assigned_public_address_is_not_treated_as_foreign() {
        let host: Vec<IpAddr> = vec![
            "192.160.160.80".parse().unwrap(),
            "192.168.32.1".parse().unwrap(),
            "127.0.0.1".parse().unwrap(),
        ];

        assert!(
            is_locally_assigned("192.160.160.80".parse().unwrap(), &host),
            "an address the OS assigned to one of our links is local, whatever registry \
             it belongs to"
        );
        assert!(
            !is_locally_assigned("8.8.8.8".parse().unwrap(), &host),
            "a public address nobody assigned us must stay refused"
        );
        assert!(
            !is_locally_assigned("192.160.160.81".parse().unwrap(), &host),
            "the check is per address, not per subnet — a neighbour's address is not ours"
        );
    }

    /// An empty host list (`getifaddrs(3)` failed) must make the guard fall *closed*.
    #[test]
    fn an_unenumerable_host_refuses_every_public_bind() {
        assert!(!is_locally_assigned("192.160.160.80".parse().unwrap(), &[]));
        assert!(!bind_locality_ok("192.160.160.80:0".parse().unwrap(), &[]));
        // …but a private address never needed vouching for in the first place.
        assert!(bind_locality_ok("192.168.1.5:0".parse().unwrap(), &[]));
    }

    /// The composed rule [`lan_only`] applies, exercised directly.
    ///
    /// This pins the *rule*. It does **not** pin that `lan_only` calls it — a rule can be
    /// right and unwired, and an earlier revision of this test claimed otherwise while
    /// reverting the gate left the whole suite green. That claim now lives in
    /// [`lan_only_binds_a_public_address_the_host_holds`], which drives the gate through
    /// `lan_only` itself; this test is the unit underneath it.
    #[test]
    fn bind_locality_ok_accepts_a_public_address_the_host_holds() {
        let host: Vec<IpAddr> = vec![
            "192.160.160.80".parse().unwrap(),
            "192.168.32.1".parse().unwrap(),
        ];

        assert!(
            bind_locality_ok("192.160.160.80:0".parse().unwrap(), &host),
            "the reporting user's own LAN address must be bindable; refusing it is the \
             same outage one layer down"
        );
        assert!(
            !bind_locality_ok("8.8.8.8:0".parse().unwrap(), &host),
            "a public address the host was never assigned must stay refused"
        );
        assert!(
            !bind_locality_ok("[2606:4700:4700::1111]:0".parse().unwrap(), &host),
            "and so must a public IPv6 address"
        );
    }

    /// The composed gate, as `lan_only_with_host_addrs` applies it (#3853).
    ///
    /// Both arms, because the pair is what the change is: a public address the host
    /// **holds** must now build (it is the reporting user's LAN), and a public address it
    /// does **not** hold must still be refused (that is the guarantee the rustdoc makes).
    /// Reverting the gate here to `is_publicly_routable(&bind)` reddens the first arm;
    /// deleting the gate outright reddens the second.
    ///
    /// What it does **not** pin — an earlier revision of this docstring claimed it did —
    /// is that the public `lan_only` supplies the *host's* address list: this test names
    /// the list itself, so it stays green when `lan_only` passes `&[]`. That is
    /// [`lan_only_gates_on_the_addresses_this_host_actually_holds`]'s job, and it is the
    /// same "right rule, not wired in" shape one level up.
    ///
    /// `lan_only` returns a *builder* — nothing is bound and no socket is opened — so the
    /// address list is free to describe a machine other than the one running the test.
    #[test]
    fn lan_only_binds_a_public_address_the_host_holds() {
        let host: Vec<IpAddr> = vec![
            "192.160.160.80".parse().expect("test address parses"),
            "192.168.32.1".parse().expect("test address parses"),
        ];
        let bind: SocketAddr = "192.160.160.80:0".parse().expect("test address parses");

        lan_only_with_host_addrs(
            bind,
            24,
            DnsResolver::custom(RecordingResolver::new()),
            &host,
        )
        .expect(
            "the reporting user's own LAN address is public space they hold; refusing it \
             is #3853 one layer down",
        );

        let err =
            lan_only_with_host_addrs(bind, 24, DnsResolver::custom(RecordingResolver::new()), &[])
                .expect_err("the same address on a host that does not hold it must be refused");
        assert!(
            matches!(err, LanBindError::BindAddressNotPrivate { .. }),
            "an unvouched-for public bind must be refused as such, got {err:?}"
        );

        let foreign: SocketAddr = "8.8.8.8:0".parse().expect("test address parses");
        let err = lan_only_with_host_addrs(
            foreign,
            24,
            DnsResolver::custom(RecordingResolver::new()),
            &host,
        )
        .expect_err("a public address on nobody's interface must stay refused");
        assert!(
            matches!(err, LanBindError::BindAddressNotPrivate { .. }),
            "8.8.8.8 must be refused even with a populated host list, got {err:?}"
        );
    }

    /// The wiring, driven through the **public** `lan_only` against this machine (#3853).
    ///
    /// Every test above hands the address list in. That leaves one thing unpinned, and it
    /// is the thing #3853 actually was: whether `lan_only` passes [`host_ip_addrs`] at
    /// all. Replacing that argument with `&[]` compiles, keeps every other test in this
    /// file green, and makes the public `lan_only` refuse *every* publicly-routable bind —
    /// so on the reporting hardware `lan_only("192.160.160.80:0", 24, ..)` comes back
    /// `BindAddressNotPrivate` and the daemon cannot bind its own LAN. That is the
    /// original bug, one layer down, reachable and previously undetected.
    ///
    /// # Why this one test reads the host
    ///
    /// It has to: the argument being pinned *is* the host enumeration, so no synthetic
    /// list can stand in for it. The module docs above warn that "no developer machine or
    /// CI runner has a public address to publish" — this machine does (`192.160.160.80`,
    /// a home LAN numbered out of public space), and so does the reporter's, which is why
    /// the loop below is non-vacuous where it matters.
    ///
    /// On a host holding only RFC 1918 / loopback addresses the loop is empty — and there
    /// the `&[]` mutation is *equivalent*, not merely uncaught: with no publicly-routable
    /// address of its own, `bind_locality_ok` never consults the list and the two
    /// behaviours cannot be told apart by any input. The second half of the test — a
    /// public address nobody assigned us stays refused — holds on every host.
    #[test]
    fn lan_only_gates_on_the_addresses_this_host_actually_holds() {
        let held = host_ip_addrs();
        assert!(
            !held.is_empty(),
            "precondition: `getifaddrs(3)` reported no addresses at all, so this test \
             cannot say anything about the list `lan_only` gates against"
        );

        for ip in held
            .iter()
            .copied()
            .filter(|ip| is_publicly_routable(&SocketAddr::new(*ip, 0)))
        {
            // Both well inside the accepted range, so a failure here can only be the
            // locality gate — never the breadth check.
            let prefix_len = if ip.is_ipv4() { 24 } else { 64 };
            let outcome = lan_only(
                SocketAddr::new(ip, 0),
                prefix_len,
                DnsResolver::custom(RecordingResolver::new()),
            );
            assert!(
                outcome.is_ok(),
                "{ip} is publicly routable AND assigned to an interface on this host, so \
                 `lan_only` must accept it — refusing it makes the daemon unable to bind \
                 its own LAN, which is #3853. Got {:?}",
                outcome.as_ref().err()
            );
        }

        // The refusal arm needs no public interface, so it holds on every host: an
        // address the OS never assigned us must still be refused through the public
        // entry point, not merely through the seam.
        let foreign: SocketAddr = "8.8.8.8:0".parse().expect("test address parses");
        let err = lan_only(foreign, 24, DnsResolver::custom(RecordingResolver::new()))
            .expect_err("a public address on nobody's interface must stay refused");
        assert!(
            matches!(err, LanBindError::BindAddressNotPrivate { .. }),
            "8.8.8.8 must be refused as a non-local bind, got {err:?}"
        );
    }

    /// `host_ip_addrs` is the impure half of the gate. It cannot be pinned against a
    /// fixture, but "it returned nothing" is the failure that would silently close the
    /// gate on every public bind — including the reporting user's own LAN — so the one
    /// address every host has is worth asserting.
    #[test]
    fn host_ip_addrs_reports_at_least_the_loopback_address() {
        let addrs = host_ip_addrs();
        assert!(
            addrs.iter().any(IpAddr::is_loopback),
            "every host has a loopback address; an enumeration that reports none is \
             `getifaddrs(3)` failing silently, which shuts the locality gate on every \
             public bind — got {addrs:?}"
        );
    }

    /// `::ffff:a.b.c.d` must compare equal to the v4 address it names, on both sides —
    /// otherwise the guard's answer depends on which spelling the platform reports.
    #[test]
    fn locality_unmaps_ipv4_mapped_ipv6_on_both_sides() {
        let host_v4: Vec<IpAddr> = vec!["192.160.160.80".parse().unwrap()];
        assert!(is_locally_assigned(
            "::ffff:192.160.160.80".parse().unwrap(),
            &host_v4
        ));

        let host_mapped: Vec<IpAddr> = vec!["::ffff:192.160.160.80".parse().unwrap()];
        assert!(is_locally_assigned(
            "192.160.160.80".parse().unwrap(),
            &host_mapped
        ));
    }

    /// `LanBindError` must report the inner iroh error exactly once.
    ///
    /// `source()` exists so a caller walking the chain (or `tracing`'s error field) can
    /// reach the underlying `InvalidSocketAddr`. That makes interpolating it into
    /// `Display` a *duplicate*, not a convenience: `{:#}` and every chain-walking
    /// reporter would print the same sentence twice. This pins both halves — the source
    /// is reachable, and `Display` does not restate it — because either half silently
    /// regresses on its own.
    #[test]
    fn lan_bind_error_reports_the_inner_error_exactly_once() {
        use std::error::Error as _;

        // A prefix above the IPv4 maximum clears both of our own checks — /33 is not
        // "too broad", and loopback is not publicly routable — so rejection can only
        // come from iroh, which is the one path that yields `InvalidSocketAddr`.
        let bind: SocketAddr = "127.0.0.1:0".parse().expect("test address parses");
        let err = lan_only(bind, 33, DnsResolver::custom(RecordingResolver::new()))
            .expect_err("a prefix above the IPv4 maximum must be rejected by iroh");
        let LanBindError::InvalidSocketAddr(_) = &err else {
            panic!("expected the iroh-rejected variant, got {err:?}");
        };

        let source = err
            .source()
            .expect("InvalidSocketAddr must expose its inner error as the chain source");
        let outer = err.to_string();
        let inner = source.to_string();

        assert!(
            !outer.contains(&inner),
            "Display must not restate what source() already returns, or chain-walking \
             reporters print it twice; outer={outer:?} inner={inner:?}"
        );
        assert!(
            !outer.is_empty(),
            "Display must still carry the context this wrapper adds"
        );

        // The variants with nothing behind them must not invent a source.
        let too_broad = lan_only(bind, 1, DnsResolver::custom(RecordingResolver::new()))
            .expect_err("a /1 prefix must be rejected as too broad");
        assert!(
            too_broad.source().is_none(),
            "PrefixTooBroad has no inner error to expose"
        );
    }

    /// The addresses a real deployment binds must stay usable — the locality check must
    /// not be so eager that it rejects the LAN it exists to confine us to.
    #[test]
    fn lan_only_accepts_the_addresses_a_real_lan_binds() {
        for (addr, prefix) in [
            ("127.0.0.1:0", 8u8),   // loopback, used by every test here
            ("192.168.1.10:0", 24), // RFC 1918
            ("10.0.6.1:0", 8),      // RFC 1918
            ("172.16.0.1:0", 16),   // RFC 1918
            ("0.0.0.0:0", 8),       // unspecified: bind-all, not a public address
        ] {
            let bind: SocketAddr = addr.parse().expect("test address parses");
            assert!(
                lan_only(bind, prefix, DnsResolver::custom(RecordingResolver::new())).is_ok(),
                "{addr}/{prefix} is a real LAN bind and must remain usable"
            );
        }
    }

    /// The check must *bound*, not forbid: raising the minimum until real LANs stop
    /// binding would pass the rejection tests above while breaking every caller.
    ///
    /// The prefixes here are deliberate literals, not `MIN_IPV4_PREFIX_LEN`. An earlier
    /// version of this test passed the constant to the function under test, which made
    /// it self-referential and unfalsifiable — raising the minimum to /32 moved the
    /// input in lockstep and the test stayed green. These are the prefix lengths real
    /// networks actually use, so they hold the minimum down from the other side.
    #[test]
    fn lan_only_accepts_the_prefixes_real_lans_use() {
        // 10.0.0.0/8 and 127.0.0.0/8; 192.168.0.0/16; a typical /24; a single host.
        for prefix_len in [8u8, 16, 24, 32] {
            assert!(
                lan_only(
                    lan_bind(),
                    prefix_len,
                    DnsResolver::custom(RecordingResolver::new()),
                )
                .is_ok(),
                "/{prefix_len} is a real LAN prefix and must remain usable"
            );
        }
    }

    // -- The recorder itself is bounded ---------------------------------------

    #[test]
    fn recorder_bounds_its_buffer_and_counts_the_overflow() {
        let recorder = RecordingResolver::new();
        let overflow = 50usize;
        for i in 0..(MAX_RECORDED_QUERIES + overflow) {
            recorder.record(&format!("host-{i}.example"));
        }

        assert_eq!(
            recorder.queries().len(),
            MAX_RECORDED_QUERIES,
            "the record must stop growing at the cap"
        );
        assert_eq!(
            recorder.dropped_queries(),
            overflow,
            "overflow must be counted, so `queries()` is never silently a prefix"
        );
        // A leak lands in slot zero: the cap discards the tail, never the head, which is
        // why bounding cannot hide a leak from the guards above.
        assert_eq!(
            recorder.queries().first().map(String::as_str),
            Some("host-0.example")
        );
    }

    /// A poisoned mutex must degrade to "the tripwire still reports" rather than "the
    /// process aborts". The recorder guards an append-only list of strings; there is no
    /// invariant a panic mid-`push` can leave broken.
    #[test]
    fn recorder_survives_a_poisoned_lock() {
        let recorder = RecordingResolver::new();
        recorder.record("before-panic.example");

        let poisoner = recorder.clone();
        let panicked = std::thread::spawn(move || {
            let _guard = poisoner.lock();
            panic!("poison the recorder's mutex");
        })
        .join();
        assert!(panicked.is_err(), "the helper thread must actually panic");

        recorder.record("after-panic.example");
        assert_eq!(
            recorder.queries(),
            vec![
                "before-panic.example".to_owned(),
                "after-panic.example".to_owned()
            ],
            "a poisoned lock must not stop the tripwire recording or reading"
        );
    }

    /// Defence-in-depth, with a stated limit: **this cannot fail on a NAT'd host.**
    ///
    /// Retained because it costs nothing and would fire on a machine with a public
    /// address. It is explicitly not the evidence that LAN-only works — guards 1 and 2
    /// are. The non-emptiness assertion stops it degrading into a test that passes
    /// because it observed nothing at all.
    #[tokio::test]
    async fn lan_only_endpoint_publishes_only_private_addresses() {
        let recorder = RecordingResolver::new();
        let endpoint = lan_builder(&recorder).bind().await.expect("endpoint binds");

        tokio::time::sleep(SETTLE).await;
        let addr = endpoint.addr();
        let published: Vec<SocketAddr> = addr.ip_addrs().copied().collect();
        endpoint.close().await;

        assert!(
            !published.is_empty(),
            "endpoint published no addresses at all — this assertion would pass vacuously"
        );
        let public: Vec<_> = published
            .iter()
            .filter(|sa| is_publicly_routable(sa))
            .collect();
        assert!(
            public.is_empty(),
            "LAN-only endpoint published publicly-routable address(es): {public:?}"
        );
    }

    // -- Guard 4: the config still carries a session -------------------------
    //
    // An endpoint that cannot connect to anything also never phones home, so silence
    // alone is satisfiable by a completely broken configuration. Connectivity and
    // silence are asserted together, in one test, for that reason.

    // A deliberate copy, not an oversight — `driver` and `session` import
    // `service::SYNC_ALPN` precisely so they cannot drift from it, so a bare copy here
    // needs saying why.
    //
    // This module is the layer `service` is *built on*. Importing the constant would
    // point a dependency edge upwards to buy nothing: this test needs *an* ALPN that
    // both of its own endpoints agree on, not *the* ALPN Agaric ships. If the two ever
    // differ, this test is indifferent, which is exactly right for a test about relay
    // and DNS silence.
    const TEST_ALPN: &[u8] = b"agaric/sync/0";

    #[tokio::test]
    async fn two_lan_only_endpoints_complete_a_session_without_resolving_anything() {
        let listener_recorder = RecordingResolver::new();
        let listener = lan_builder(&listener_recorder)
            .alpns(vec![TEST_ALPN.to_vec()])
            .bind()
            .await
            .expect("listener binds");
        let listener_addr = listener.addr();

        let accept_task = tokio::spawn({
            let listener = listener.clone();
            async move {
                let incoming = listener.accept().await.expect("an inbound connection");
                let conn = incoming.await.expect("handshake completes");
                let (mut send, mut recv) = conn.accept_bi().await.expect("peer opens a stream");
                let got = recv.read_to_end(64).await.expect("payload arrives");
                send.write_all(&got).await.expect("echo writes");
                send.finish().expect("echo finishes");
                conn.closed().await;
                got
            }
        });

        let connector_recorder = RecordingResolver::new();
        let connector = lan_builder(&connector_recorder)
            .bind()
            .await
            .expect("connector binds");

        let conn = tokio::time::timeout(
            Duration::from_secs(10),
            connector.connect(listener_addr, TEST_ALPN),
        )
        .await
        .expect("connect does not time out")
        .expect("connect succeeds");

        let (mut send, mut recv) = conn.open_bi().await.expect("stream opens");
        send.write_all(b"agaric").await.expect("write");
        send.finish().expect("finish");
        let echoed = recv.read_to_end(64).await.expect("echo returns");
        conn.close(0u32.into(), b"done");

        let received = tokio::time::timeout(Duration::from_secs(10), accept_task)
            .await
            .expect("accept task finishes")
            .expect("accept task does not panic");

        assert_eq!(&echoed, b"agaric", "payload survives the round trip");
        assert_eq!(&received, b"agaric", "listener saw the payload");

        let listener_queries = listener_recorder.queries();
        let connector_queries = connector_recorder.queries();
        connector.close().await;
        listener.close().await;

        assert!(
            listener_queries.is_empty() && connector_queries.is_empty(),
            "a session completed but a name was resolved to do it — listener: \
             {listener_queries:?}, connector: {connector_queries:?}"
        );
    }
}
