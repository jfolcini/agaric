//! The #78 offline guard, and the negative controls that prove each assertion can fire.
//!
//! Spike question (1) from #78 is "does relay-disabled + mDNS truly stay offline?".
//! A packet capture answers it once. These tests answer it on every run, which is what
//! the decision comment requires: iroh defaults to relays and n0 DNS *on*, so LAN-only
//! is a posture we hold actively, and a minor-version bump is exactly the event that
//! could drop it silently.
//!
//! # Why every guard here is paired with a control
//!
//! The first draft of this file had four assertions and all four passed immediately.
//! Two of them could not have failed:
//!
//! - `lan_only_endpoint_has_no_relay` asserted `addr.relay_urls()` was empty. It is
//!   empty for the full `presets::N0` configuration too, because the recording resolver
//!   refuses DNS and no relay can be established without it. The assertion held for a
//!   reason that had nothing to do with the LAN-only config.
//! - A public-address assertion held because this machine has no publicly-routable
//!   address to publish. It would hold identically on a fully internet-facing endpoint.
//!
//! Both are rewritten below onto the signal that *is* observable — the resolver record —
//! and each is paired with a control that must fail in the opposite direction. If a
//! control ever goes green, the guard beside it has stopped being able to fail.
//!
//! # These tests do not touch the network
//!
//! The recording resolver refuses every query, so no name ever resolves and no packet is
//! ever addressed to an n0 host. The controls observe the *attempt*, which is the thing
//! we actually care about, and they observe it without egress. Safe in CI, and safe to
//! run on a machine whose owner did not consent to talking to n0.

use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4},
    time::Duration,
};

use iroh::{endpoint::presets, Endpoint};
use iroh_dns::dns::DnsResolver;
use iroh_lan_spike::{is_publicly_routable, lan_only, permissive, RecordingResolver};

/// Loopback with a /8 prefix: a stand-in for "the LAN subnet" available on any machine
/// and in CI, with no reliance on the host having a particular private range.
fn lan_bind() -> SocketAddr {
    SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
}
const LAN_PREFIX: u8 = 8;

/// Long enough for startup address-lookup and relay work to have been attempted.
/// Measured: the permissive control accumulates its first queries within ~1s; the full
/// `N0` preset reaches >200 within 6s. Three seconds is comfortably past the first.
const SETTLE: Duration = Duration::from_secs(3);

async fn queries_for(builder: iroh::endpoint::Builder, recorder: RecordingResolver) -> Vec<String> {
    let endpoint = builder.bind().await.expect("endpoint binds");
    tokio::time::sleep(SETTLE).await;
    let queries = recorder.queries();
    endpoint.close().await;
    queries
}

// ---------------------------------------------------------------------------
// Guard 1 — the endpoint resolves no hostnames at all.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn lan_only_endpoint_resolves_no_hostnames() {
    let recorder = RecordingResolver::new();
    let queries = queries_for(
        lan_only(
            lan_bind(),
            LAN_PREFIX,
            DnsResolver::custom(recorder.clone()),
        ),
        recorder,
    )
    .await;

    assert!(
        queries.is_empty(),
        "LAN-only endpoint attempted {} DNS lookup(s), so something is reaching for a \
         name off this machine: {queries:?}",
        queries.len()
    );
}

/// Control for guard 1, and the evidence for [`iroh_lan_spike::DIAL_HOME_ANYWAY`].
///
/// `presets::N0DisableRelay` is the preset whose name matches the #78 plan's wording
/// ("RelayMode::Disabled"). This asserts it still reaches for n0's DNS server — which is
/// both the negative control and the finding.
#[tokio::test]
async fn control_relay_disabled_preset_still_queries_n0_dns() {
    let recorder = RecordingResolver::new();
    let queries = queries_for(permissive(DnsResolver::custom(recorder.clone())), recorder).await;

    assert!(
        queries.iter().any(|q| q.contains("iroh.link")),
        "NEGATIVE CONTROL FAILED: presets::N0DisableRelay made no query to an n0 host. \
         Either iroh stopped using the n0 DNS services, or RecordingResolver is no longer \
         wired into the resolution path. Until that is understood, treat \
         lan_only_endpoint_resolves_no_hostnames as unable to fail. Saw: {queries:?}"
    );
}

// ---------------------------------------------------------------------------
// Guard 2 — no relay is ever even looked for.
//
// Asserting `addr.relay_urls()` is empty does NOT work: it is empty under the full N0
// preset too, because no relay can be established while DNS is refused. The observable
// difference is that a relay-enabled endpoint *queries relay hostnames*.
// ---------------------------------------------------------------------------

fn relay_queries(queries: &[String]) -> Vec<&String> {
    queries.iter().filter(|q| q.contains("relay")).collect()
}

#[tokio::test]
async fn lan_only_endpoint_never_looks_for_a_relay() {
    let recorder = RecordingResolver::new();
    let queries = queries_for(
        lan_only(
            lan_bind(),
            LAN_PREFIX,
            DnsResolver::custom(recorder.clone()),
        ),
        recorder,
    )
    .await;

    let relays = relay_queries(&queries);
    assert!(
        relays.is_empty(),
        "LAN-only endpoint looked up {} relay hostname(s): {relays:?}",
        relays.len()
    );
}

/// Control for guard 2. The full `N0` preset has relays enabled and must therefore be
/// seen reaching for them.
#[tokio::test]
async fn control_n0_preset_does_look_for_relays() {
    let recorder = RecordingResolver::new();
    let queries = queries_for(
        Endpoint::builder(presets::N0).dns_resolver(DnsResolver::custom(recorder.clone())),
        recorder,
    )
    .await;

    let relays = relay_queries(&queries);
    assert!(
        !relays.is_empty(),
        "NEGATIVE CONTROL FAILED: presets::N0 (relays enabled) looked up no relay \
         hostname. lan_only_endpoint_never_looks_for_a_relay is therefore unable to \
         fail. Saw {} total quer(ies): {queries:?}",
        queries.len()
    );
}

// ---------------------------------------------------------------------------
// Guard 3 — the address classifier.
//
// The integration form of this ("the endpoint publishes no public address") cannot fail
// on a NAT'd host, which is every developer machine and every CI runner: there is no
// public address available to publish, so the assertion holds regardless of config. It
// is kept below as defence-in-depth with that limit stated, but the falsifiable part is
// the classifier itself, unit-tested here against addresses whose class is not in doubt.
// ---------------------------------------------------------------------------

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
        "127.0.0.1:1",      // loopback
        "10.0.6.1:1",       // RFC1918
        "192.168.68.110:1", // RFC1918
        "172.16.0.1:1",     // RFC1918
        "169.254.1.1:1",    // link-local
        "100.64.0.1:1",     // CGNAT — not is_private(), still not internet-routable
        "[::1]:1",          // loopback
        "[fe80::1]:1",      // link-local
        "[fc00::1]:1",      // unique-local
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
/// It is retained because it costs nothing and would fire on a machine with a public
/// address (a cloud runner, a host on a routable /24). It is explicitly *not* the
/// evidence that the LAN-only config works — guards 1 and 2 are. The non-emptiness
/// assertion is what stops it degrading into a test that passes because it observed
/// nothing at all.
#[tokio::test]
async fn lan_only_endpoint_publishes_only_private_addresses() {
    let endpoint = lan_only(
        lan_bind(),
        LAN_PREFIX,
        DnsResolver::custom(RecordingResolver::new()),
    )
    .bind()
    .await
    .expect("LAN-only endpoint binds");

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

/// Guards 1–3 all bind to loopback. This pins that the loopback bind is a test
/// convenience and not the thing being tested: a real private-LAN address is classified
/// the same way.
#[test]
fn loopback_bind_is_not_load_bearing_for_the_classifier() {
    let lan: SocketAddr = "192.168.68.110:44705".parse().expect("parses");
    let loopback: SocketAddr = "127.0.0.1:44705".parse().expect("parses");
    assert_eq!(
        is_publicly_routable(&lan),
        is_publicly_routable(&loopback),
        "a real LAN address and loopback must classify identically, otherwise the \
         loopback bind used by the other tests is hiding a difference"
    );
    assert!(matches!(lan.ip(), IpAddr::V4(_)));
}
