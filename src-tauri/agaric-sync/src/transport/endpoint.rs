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
#[derive(Debug, Clone, Default)]
pub struct RecordingResolver {
    queries: Arc<Mutex<Vec<String>>>,
}

impl RecordingResolver {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Every hostname iroh attempted to resolve, in order.
    ///
    /// # Panics
    /// If the internal mutex was poisoned by a panic in another thread.
    #[must_use]
    pub fn queries(&self) -> Vec<String> {
        self.queries
            .lock()
            .expect("recording resolver mutex poisoned")
            .clone()
    }

    fn record(&self, host: &str) {
        self.queries
            .lock()
            .expect("recording resolver mutex poisoned")
            .push(host.to_string());
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
/// If `bind` is not a valid socket address for the given `prefix_len` (for IPv4 the
/// maximum prefix is 32, for IPv6 128).
pub fn lan_only(
    bind: SocketAddr,
    prefix_len: u8,
    resolver: DnsResolver,
) -> Result<Builder, InvalidSocketAddr> {
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
#[must_use]
pub fn is_publicly_routable(addr: &SocketAddr) -> bool {
    match addr.ip() {
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
    //! control asserting the opposite. **If a control goes green, the guard beside it
    //! has stopped being able to fail and this suite is lying.**
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

    // -- Guard 1: the endpoint resolves no hostnames at all ------------------

    #[tokio::test]
    async fn lan_only_endpoint_resolves_no_hostnames() {
        let recorder = RecordingResolver::new();
        let queries = queries_for(lan_builder(&recorder), recorder).await;

        assert!(
            queries.is_empty(),
            "LAN-only endpoint attempted {} DNS lookup(s), so something is reaching \
             for a name off this machine: {queries:?}",
            queries.len()
        );
    }

    /// Control for guard 1 — and the standing evidence that `RelayMode::Disabled`
    /// alone is insufficient, which is the finding that shaped this whole module.
    #[tokio::test]
    async fn control_relay_disabled_preset_still_queries_n0_dns() {
        let recorder = RecordingResolver::new();
        let queries = queries_until(
            permissive(DnsResolver::custom(recorder.clone())),
            recorder,
            |q| q.iter().any(|s| s.contains("iroh.link")),
        )
        .await;

        assert!(
            queries.iter().any(|q| q.contains("iroh.link")),
            "NEGATIVE CONTROL FAILED: presets::N0DisableRelay made no query to an n0 \
             host. Either iroh stopped using the n0 DNS services, or RecordingResolver \
             is no longer wired into the resolution path. Until that is understood, \
             treat lan_only_endpoint_resolves_no_hostnames as unable to fail. \
             Saw: {queries:?}"
        );
    }

    // -- Guard 2: no relay is ever even looked for ---------------------------
    //
    // Asserting `relay_urls()` is empty does NOT work — it is empty under the full N0
    // preset too, since no relay can be established while DNS is refused. The
    // observable difference is that a relay-enabled endpoint *queries relay hostnames*.

    fn relay_queries(queries: &[String]) -> Vec<&String> {
        queries.iter().filter(|q| q.contains("relay")).collect()
    }

    #[tokio::test]
    async fn lan_only_endpoint_never_looks_for_a_relay() {
        let recorder = RecordingResolver::new();
        let queries = queries_for(lan_builder(&recorder), recorder).await;

        let relays = relay_queries(&queries);
        assert!(
            relays.is_empty(),
            "LAN-only endpoint looked up {} relay hostname(s): {relays:?}",
            relays.len()
        );
    }

    /// Control for guard 2.
    #[tokio::test]
    async fn control_n0_preset_does_look_for_relays() {
        let recorder = RecordingResolver::new();
        let queries = queries_until(
            Endpoint::builder(presets::N0).dns_resolver(DnsResolver::custom(recorder.clone())),
            recorder,
            |q| q.iter().any(|s| s.contains("relay")),
        )
        .await;

        let relays = relay_queries(&queries);
        assert!(
            !relays.is_empty(),
            "NEGATIVE CONTROL FAILED: presets::N0 (relays enabled) looked up no relay \
             hostname. lan_only_endpoint_never_looks_for_a_relay is therefore unable \
             to fail. Saw {} total quer(ies): {queries:?}",
            queries.len()
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
        ] {
            let sa: SocketAddr = addr.parse().expect("test address parses");
            assert!(
                !is_publicly_routable(&sa),
                "{addr} must NOT be classified publicly routable"
            );
        }
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
